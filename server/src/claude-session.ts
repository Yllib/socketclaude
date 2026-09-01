import { query, createSdkMcpServer, tool, forkSession as sdkForkSession, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as crypto from "crypto";
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import * as pty from "node-pty";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import {
  ServerMessage,
  ActiveSubagentsServerMessage,
  HistoryEntry,
  QuestionItem,
  SessionInfo,
  AgentSessionSettings,
  Backend,
  WorkflowStatePayload,
} from "./protocol";
import { saveSession, getSession, updateSessionActivity, updateSessionContextUsage, updateSessionAgentSettings, appendHistory, saveTodos, getTodos, remapSession, markQuestionAnswered, appendSdkEvent, cacheToolImage, positionSessionMessage, clearSessionPendingHandoffContext, removeHistoryEntriesByUuids } from "./session-store";
import { saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { SocketAgentPlugin, SessionContext } from "./plugin-api";
import {
  AppToolContext,
  handleAgentSessionTool,
  handleBrowserSessionTool,
  handleHtmlPlanTool,
  handleMonitorTool,
  handleNotifyUserTool,
  handleRememberTool,
  handleRequestSecureInputTool,
  handleScheduleReminderTool,
  handleSendFileTool,
  handleSpeakTool,
  handleTaskBatchTool,
  handleWorkReviewTool,
  stopAppMonitor,
  stopAppMonitorsForSession,
} from "./app-tool-handlers";
import type {
  AgentSessionToolExecutor,
  DelegatedAgentLiveActivity,
} from "./delegated-agent-types";
import { AGENT_SESSION_TOOL_DESCRIPTION, buildSocketAgentIntegrationInstructions, HTML_PLAN_TOOL_DESCRIPTION, REMEMBER_TOOL_DESCRIPTION, WORK_REVIEW_TOOL_DESCRIPTION } from "./socketagent-instructions";
import { pendingSecureInputMessagesForSession, redactSecretsDeep, secureInputInventoryForAgent } from "./secure-input-store";
import { SessionEventDelivery } from "./session-event-delivery";
import { legacyManagedNpmBinDir, legacyManagedNpmPrefix, managedNpmBinDir, managedNpmPrefix } from "./socket-agent-paths";
import { createClaudeAuthRequest, exchangeClaudeAuthCode, ClaudeAuthRequest } from "./claude-auth";
import { getCachedModelCatalog, modelCatalogIsFresh, saveCachedModelCatalog } from "./model-catalog-store";
import { LatestSnapshotDispatcher } from "./latest-snapshot-dispatcher";
import { maybeSendAgentAttentionPush } from "./push-notifications";
import { createInteractiveRequestId } from "./interactive-request-id";
import { remapSessionMemory } from "./session-memory-store";
import {
  buildClaudeRateLimitEvent,
  buildClaudeUsageRateLimitEvents,
} from "./rate-limit-events";
import { recordRateLimitEvent } from "./rate-limit-cache";

export type ClaudeExecutableSource = "explicit" | "sdk" | "managed" | "legacy" | "system" | "unresolved";

export interface ClaudeExecutableInfo {
  path?: string;
  source: ClaudeExecutableSource;
  reason?: string;
}

export interface ClaudeExecutableSpawn {
  command: string;
  args: string[];
  shell: boolean;
}

export interface ClaudeAvailability {
  available: boolean;
  reason?: string;
  detail?: string;
  version?: string;
}

interface ClaudeSubagentState {
  agentId?: string;
  toolUseId: string;
  description: string;
  subagentType: string;
  startedAt: string;
  parentToolUseId?: string;
  prompt?: string;
  resolvedModel?: string;
  isBackgrounded: boolean;
  status: "pending" | "running" | "completed" | "failed" | "stopped" | "paused";
  progressSummary?: string;
  lastToolName?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

interface ClaudeSdkBackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
}

interface ClaudeWorkflowRun {
  taskId: string;
  toolUseId: string;
  runId?: string;
  workflowName?: string;
  summary: string;
  scriptPath?: string;
  transcriptDir?: string;
  statePath?: string;
  lastSnapshot?: WorkflowStatePayload;
  lastSignature?: string;
  interval?: NodeJS.Timeout;
}

const CLAUDE_AVAILABILITY_CACHE_MS = 5000;

/**
 * Claude local/slash commands can return text only on the final result event.
 * Do not use that fallback when the SDK already emitted a completed assistant
 * message for the turn, even if there were no stream_event text deltas.
 */
export function shouldEmitClaudeResultFallback(
  resultContent: unknown,
  currentText: string,
  sawMainAssistantText: boolean,
): boolean {
  return typeof resultContent === "string"
    && resultContent.length > 0
    && currentText.length === 0
    && !sawMainAssistantText;
}

/** Claude Code 2.1.198+ treats omitted run_in_background as true. */
export function claudeAgentRunsInBackground(input: unknown): boolean {
  return !(input && typeof input === "object"
    && (input as Record<string, unknown>).run_in_background === false);
}

/**
 * Claude Code now ships a built-in Monitor tool whose "persistent" lifetime is
 * only the current SDK session. SocketAgent's MCP Monitor is durable across
 * turns and server restarts, so never expose the native name as a choice.
 */
export function claudeDisallowedTools(userDisallowedTools: string[]): string[] {
  return [...new Set([...userDisallowedTools, "Monitor"])];
}

/** Background completion follow-ups are SDK-owned turns, not phone prompts. */
export function isClaudeTaskNotificationResult(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const origin = (message as Record<string, any>).origin;
  return origin?.kind === "task-notification";
}

/** Structured Agent launch acknowledgements are non-terminal tool results. */
export function isClaudeAgentLaunchOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const status = (output as Record<string, unknown>).status;
  return status === "async_launched" || status === "remote_launched";
}

/** Structured Workflow launch acknowledgements are non-terminal tool results. */
export function isClaudeWorkflowLaunchOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const value = output as Record<string, unknown>;
  return (value.status === "async_launched" || value.status === "remote_launched")
    && value.taskType === "local_workflow";
}

export function workflowStatePathForLaunch(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Record<string, unknown>;
  const runId = String(value.runId || "");
  const scriptPath = String(value.scriptPath || "");
  if (!runId || !scriptPath || path.basename(runId) !== runId) return undefined;
  const scriptsDir = path.dirname(scriptPath);
  if (path.basename(scriptsDir) !== "scripts") return undefined;
  return path.join(path.dirname(scriptsDir), `${runId}.json`);
}

function boundedWorkflowString(value: unknown, max = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function boundedWorkflowNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function workflowResultPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return boundedWorkflowString(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      20_000,
    );
  } catch {
    return boundedWorkflowString(value, 20_000);
  }
}

/** Convert Claude Code's on-disk workflow state into a bounded wire snapshot. */
export function sanitizeClaudeWorkflowState(
  raw: unknown,
  fallback: {
    taskId: string;
    toolUseId?: string;
    runId?: string;
    workflowName?: string;
    summary?: string;
    status?: string;
    scriptPath?: string;
    transcriptDir?: string;
    statePath?: string;
  },
): WorkflowStatePayload {
  const value = raw && typeof raw === "object"
    ? raw as Record<string, any>
    : {};
  const phases = Array.isArray(value.phases)
    ? value.phases.slice(0, 100).map((phase: any) => ({
      title: boundedWorkflowString(phase?.title, 500) || "Phase",
      ...(boundedWorkflowString(phase?.detail, 2_000)
        ? { detail: boundedWorkflowString(phase?.detail, 2_000) }
        : {}),
    }))
    : [];
  const progress = Array.isArray(value.workflowProgress)
    ? value.workflowProgress.slice(0, 1_000).map((entry: any) => ({
      type: boundedWorkflowString(entry?.type, 100) || "workflow_agent",
      ...(boundedWorkflowNumber(entry?.index) !== undefined ? { index: boundedWorkflowNumber(entry.index) } : {}),
      ...(boundedWorkflowString(entry?.title, 500) ? { title: boundedWorkflowString(entry.title, 500) } : {}),
      ...(boundedWorkflowString(entry?.label, 500) ? { label: boundedWorkflowString(entry.label, 500) } : {}),
      ...(boundedWorkflowNumber(entry?.phaseIndex) !== undefined ? { phaseIndex: boundedWorkflowNumber(entry.phaseIndex) } : {}),
      ...(boundedWorkflowString(entry?.phaseTitle, 500) ? { phaseTitle: boundedWorkflowString(entry.phaseTitle, 500) } : {}),
      ...(boundedWorkflowString(entry?.agentId, 200) ? { agentId: boundedWorkflowString(entry.agentId, 200) } : {}),
      ...(boundedWorkflowString(entry?.model, 200) ? { model: boundedWorkflowString(entry.model, 200) } : {}),
      ...(boundedWorkflowString(entry?.state, 100) ? { state: boundedWorkflowString(entry.state, 100) } : {}),
      ...(boundedWorkflowNumber(entry?.startedAt) !== undefined ? { startedAt: boundedWorkflowNumber(entry.startedAt) } : {}),
      ...(boundedWorkflowNumber(entry?.queuedAt) !== undefined ? { queuedAt: boundedWorkflowNumber(entry.queuedAt) } : {}),
      ...(boundedWorkflowNumber(entry?.lastProgressAt) !== undefined ? { lastProgressAt: boundedWorkflowNumber(entry.lastProgressAt) } : {}),
      ...(boundedWorkflowNumber(entry?.tokens) !== undefined ? { tokens: boundedWorkflowNumber(entry.tokens) } : {}),
      ...(boundedWorkflowNumber(entry?.toolCalls) !== undefined ? { toolCalls: boundedWorkflowNumber(entry.toolCalls) } : {}),
      ...(boundedWorkflowNumber(entry?.durationMs) !== undefined ? { durationMs: boundedWorkflowNumber(entry.durationMs) } : {}),
      ...(boundedWorkflowNumber(entry?.attempt) !== undefined ? { attempt: boundedWorkflowNumber(entry.attempt) } : {}),
      ...(boundedWorkflowString(entry?.promptPreview, 4_000) ? { promptPreview: boundedWorkflowString(entry.promptPreview, 4_000) } : {}),
      ...(boundedWorkflowString(entry?.resultPreview, 8_000) ? { resultPreview: boundedWorkflowString(entry.resultPreview, 8_000) } : {}),
      ...(boundedWorkflowString(entry?.error, 4_000) ? { error: boundedWorkflowString(entry.error, 4_000) } : {}),
    }))
    : [];
  const logs = Array.isArray(value.logs)
    ? value.logs.slice(-200)
      .map((entry: unknown) => boundedWorkflowString(entry, 2_000))
      .filter((entry: string | undefined): entry is string => Boolean(entry))
    : [];
  return {
    taskId: fallback.taskId,
    ...(fallback.toolUseId ? { toolUseId: fallback.toolUseId } : {}),
    ...(boundedWorkflowString(value.runId || fallback.runId, 200)
      ? { runId: boundedWorkflowString(value.runId || fallback.runId, 200) }
      : {}),
    ...(boundedWorkflowString(value.workflowName || fallback.workflowName, 500)
      ? { workflowName: boundedWorkflowString(value.workflowName || fallback.workflowName, 500) }
      : {}),
    summary: boundedWorkflowString(value.summary || fallback.summary, 2_000) || "Workflow",
    status: boundedWorkflowString(value.status || fallback.status, 100) || "running",
    ...(fallback.scriptPath ? { scriptPath: fallback.scriptPath } : {}),
    ...(fallback.transcriptDir ? { transcriptDir: fallback.transcriptDir } : {}),
    ...(fallback.statePath ? { statePath: fallback.statePath } : {}),
    ...(boundedWorkflowNumber(value.startTime) !== undefined ? { startTime: boundedWorkflowNumber(value.startTime) } : {}),
    ...(boundedWorkflowNumber(value.durationMs) !== undefined ? { durationMs: boundedWorkflowNumber(value.durationMs) } : {}),
    ...(boundedWorkflowNumber(value.agentCount) !== undefined ? { agentCount: boundedWorkflowNumber(value.agentCount) } : {}),
    ...(boundedWorkflowNumber(value.totalTokens) !== undefined ? { totalTokens: boundedWorkflowNumber(value.totalTokens) } : {}),
    ...(boundedWorkflowNumber(value.totalToolCalls) !== undefined ? { totalToolCalls: boundedWorkflowNumber(value.totalToolCalls) } : {}),
    ...(boundedWorkflowString(value.defaultModel, 200) ? { defaultModel: boundedWorkflowString(value.defaultModel, 200) } : {}),
    phases,
    progress,
    logs,
    ...(workflowResultPreview(value.result) ? { resultPreview: workflowResultPreview(value.result) } : {}),
  };
}

export interface ClaudeTaskStateUpdate {
  taskId: string;
  subject?: string;
  description?: string;
  teammateName?: string;
  status?: "pending" | "in_progress" | "completed" | "deleted";
}

/**
 * Claude's TaskCreate/TaskUpdate list is not a subagent list. Keep it in the
 * same durable session task store used by TodoWrite while preserving any
 * legacy TodoWrite entries that may coexist during an upgrade.
 */
export function reduceClaudeTaskTodos(
  current: any[],
  update: ClaudeTaskStateUpdate,
): any[] {
  const taskId = String(update.taskId || "");
  if (!taskId) return current.map((item) => ({ ...item }));
  const result = current.map((item) => ({ ...item }));
  const index = result.findIndex(
    (item) => item?.source === "claude_tasks"
      && String(item?.id ?? item?.taskId ?? "") === taskId,
  );
  if (update.status === "deleted") {
    if (index >= 0) result.splice(index, 1);
    return result;
  }

  const previous = index >= 0 ? result[index] : undefined;
  const subject = String(update.subject || previous?.content || `Task #${taskId}`);
  const next = {
    ...(previous || {}),
    id: taskId,
    taskId,
    content: subject,
    activeForm: subject,
    status: update.status || previous?.status || "pending",
    source: "claude_tasks",
    ...(update.description !== undefined
      ? { description: update.description }
      : previous?.description !== undefined
        ? { description: previous.description }
        : {}),
    ...(update.teammateName !== undefined
      ? { teammateName: update.teammateName }
      : previous?.teammateName !== undefined
        ? { teammateName: previous.teammateName }
        : {}),
  };
  if (index >= 0) result[index] = next;
  else result.push(next);
  return result;
}

export function replaceClaudeTaskTodos(current: any[], tasks: any[]): any[] {
  let result = current
    .filter((item) => item?.source !== "claude_tasks")
    .map((item) => ({ ...item }));
  const previousTasks = current.filter((item) => item?.source === "claude_tasks");
  for (const task of tasks) {
    const taskId = String(task?.id || task?.taskId || "");
    if (!taskId) continue;
    const previous = previousTasks.find(
      (item) => String(item?.id ?? item?.taskId ?? "") === taskId,
    );
    result = reduceClaudeTaskTodos(result, {
      taskId,
      subject: String(task?.subject || previous?.content || `Task #${taskId}`),
      description: task?.description ?? previous?.description,
      teammateName: task?.owner ?? task?.teammateName ?? previous?.teammateName,
      status: task?.status || previous?.status || "pending",
    });
  }
  return result;
}

/**
 * TodoWrite is a full replacement only for TodoWrite-owned rows. It must not
 * erase modern TaskCreate/TaskUpdate rows or SocketAgent TaskBatch rows that
 * share the visible task pane and durable store.
 */
export function replaceClaudeTodoWriteTodos(current: any[], todos: any[]): any[] {
  const retained = current
    .filter((item) => {
      const source = String(item?.source || "");
      return source !== "" && source !== "claude_todos";
    })
    .map((item) => ({ ...item }));
  const replacement = todos.map((todo) => ({
    ...todo,
    source: "claude_todos",
  }));
  return [...retained, ...replacement];
}

function existingFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.existsSync(filePath) ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function npmGlobalPackageDir(prefix: string, packageName: string): string {
  const parts = packageName.split("/");
  const nodeModules = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  return path.join(nodeModules, ...parts);
}

function resolveClaudePackageBin(prefix: string): string | undefined {
  const packageDir = npmGlobalPackageDir(prefix, "@anthropic-ai/claude-code");
  const packageJsonPath = path.join(packageDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
    const binValue = typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.claude || Object.values(pkg.bin || {})[0];
    if (!binValue) return undefined;
    return existingFile(path.resolve(packageDir, binValue));
  } catch {
    return undefined;
  }
}

function isJavaScriptRuntimeFile(filePath: string): boolean {
  return /\.(?:js|mjs|tsx?|jsx)$/i.test(filePath);
}

function resolveSdkClaudeBinary(): string | undefined {
  // Some SDK installs include both linux-*-musl and glibc optional-dep packages.
  // On glibc hosts, make the binary choice explicit so the SDK cannot pick a musl
  // binary and fail with ENOENT for /lib/ld-musl-*.so.1.
  if (process.platform !== "linux") return undefined;
  const arch = process.arch;
  const glibcRuntime = (process.report?.getReport() as any)?.header?.glibcVersionRuntime;
  const isGlibc = typeof glibcRuntime === "string" && glibcRuntime.length > 0;
  const glibcPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`;
  const muslPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`;
  const preferred = isGlibc ? [glibcPkg, muslPkg] : [muslPkg, glibcPkg];
  for (const pkg of preferred) {
    try { return require.resolve(pkg); } catch {}
  }
  return undefined;
}

function resolveInstalledClaudeCli(): string | undefined {
  const isWindows = process.platform === "win32";
  try {
    const command = isWindows ? "where.exe" : "which";
    const output = execFileSync(command, ["claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {}

  const home = os.homedir();
  const candidates = isWindows
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.cmd") : undefined,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm", "claude.cmd") : undefined,
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
      ];
  return candidates.map(existingFile).find(Boolean);
}

function resolveManagedClaudeCli(): { path?: string; source?: ClaudeExecutableSource } {
  const managedPackageBin = resolveClaudePackageBin(managedNpmPrefix());
  if (managedPackageBin) return { path: managedPackageBin, source: "managed" };

  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  for (const name of names) {
    const managed = existingFile(path.join(managedNpmBinDir(), name));
    if (managed) return { path: managed, source: "managed" };
  }

  const legacyPackageBin = resolveClaudePackageBin(legacyManagedNpmPrefix());
  if (legacyPackageBin) return { path: legacyPackageBin, source: "legacy" };

  for (const name of names) {
    const legacy = existingFile(path.join(legacyManagedNpmBinDir(), name));
    if (legacy) return { path: legacy, source: "legacy" };
  }
  return {};
}

function resolveClaudeExecutable(): ClaudeExecutableInfo {
  const explicit =
    existingFile(process.env.CLAUDE_CODE_EXECUTABLE) ||
    existingFile(process.env.CLAUDE_CODE_PATH);
  if (explicit) return { path: explicit, source: "explicit" };

  const managed = resolveManagedClaudeCli();
  if (managed.path) return { path: managed.path, source: managed.source || "managed" };

  const sdk = resolveSdkClaudeBinary();
  if (sdk) return { path: sdk, source: "sdk" };

  const installed = resolveInstalledClaudeCli();
  if (installed) return { path: installed, source: "system" };

  return {
    source: "unresolved",
    reason: "No Claude executable was found in the SDK, SocketAgent toolchain, or PATH",
  };
}

let CLAUDE_EXECUTABLE_INFO = resolveClaudeExecutable();
let CLAUDE_BINARY_OVERRIDE: string | undefined = CLAUDE_EXECUTABLE_INFO.path;
let cachedClaudeAvailability: { checkedAt: number; value: ClaudeAvailability } | null = null;

function logClaudeExecutableInfo(): void {
  if (CLAUDE_BINARY_OVERRIDE) {
    console.log(`[SDK] Using Claude executable (${CLAUDE_EXECUTABLE_INFO.source}): ${CLAUDE_BINARY_OVERRIDE}`);
  } else if (CLAUDE_EXECUTABLE_INFO.reason) {
    console.warn(`[SDK] ${CLAUDE_EXECUTABLE_INFO.reason}`);
  }
}

logClaudeExecutableInfo();

export function getClaudeExecutableInfo(): ClaudeExecutableInfo {
  return { ...CLAUDE_EXECUTABLE_INFO };
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

function errorString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Preserve the OS launch details that Node attaches to spawn failures. Raw
 * arguments stay hidden because they may contain prompts or private MCP URLs.
 */
export function formatClaudeQueryError(
  error: unknown,
  fallback: string,
  cwd: string,
  executableInfo: ClaudeExecutableInfo = getClaudeExecutableInfo(),
): string {
  const record = errorRecord(error);
  const message = error instanceof Error
    ? error.message
    : errorString(record, "message") || fallback;
  const syscall = errorString(record, "syscall");
  const spawnedExecutable = errorString(record, "path");
  const explicitCode = errorString(record, "code");
  const messageCode = message.match(/\b(E[A-Z0-9]+)\b/)?.[1];
  const code = explicitCode || messageCode;
  const isSpawnFailure = syscall?.startsWith("spawn")
    || /^spawn\b/i.test(message)
    || (spawnedExecutable !== undefined && code !== undefined);
  if (!isSpawnFailure) return message;

  const cliPath = executableInfo.path;
  const runtimePath = spawnedExecutable
    || (cliPath && isJavaScriptRuntimeFile(cliPath) ? process.execPath : cliPath);
  const spawnArgs = record?.spawnargs;
  const argumentCount = Array.isArray(spawnArgs) ? spawnArgs.length : undefined;
  const details = [
    code ? `code=${code}` : undefined,
    syscall ? `syscall=${syscall}` : undefined,
    runtimePath ? `executable=${runtimePath}` : undefined,
    cliPath && cliPath !== runtimePath ? `claudeCli=${cliPath}` : undefined,
    `source=${executableInfo.source}`,
    `cwd=${cwd}`,
    argumentCount !== undefined ? `argumentCount=${argumentCount}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const explanation = code === "EIO"
    ? "The operating system returned an input/output error while launching Claude."
    : "The operating system could not launch Claude.";

  return `Claude process failed to start: ${message}. ${explanation} Launch details: ${details.join("; ")}.`;
}

export function buildClaudeExecutableSpawn(
  args: string[],
  info: ClaudeExecutableInfo = CLAUDE_EXECUTABLE_INFO
): ClaudeExecutableSpawn | undefined {
  if (!info.path) return undefined;
  if (isJavaScriptRuntimeFile(info.path)) {
    return {
      command: process.execPath,
      args: [info.path, ...args],
      shell: false,
    };
  }
  return {
    command: info.path,
    args,
    shell: false,
  };
}

function firstClaudeOutputLine(stdout?: string | Buffer, stderr?: string | Buffer): string | undefined {
  const text = `${stdout || ""}\n${stderr || ""}`.trim();
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function invalidateClaudeAvailabilityCache(): void {
  cachedClaudeAvailability = null;
}

/**
 * Sentinel tool_result bodies Claude Code substitutes when a tool use is
 * cancelled instead of executed. These are internal CLI constants, not model
 * output: the tool never runs, no PreToolUse hook fires, and the text is
 * addressed to the model ("the user doesn't want..."). Once the turn's abort
 * signal is set, every remaining tool call in that run gets one of these, so
 * the model concludes it is being denied and gives up — even in bypassPermissions.
 * We match them so the app can label the cancellation instead of rendering it
 * as ordinary tool output.
 */
const TOOL_CANCELLED_SENTINELS = [
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
];

/** Minimum gap between forwarded thinking-token progress updates. */
const THINKING_TOKENS_MIN_INTERVAL_MS = 500;

function isCancelledToolResult(output: string): boolean {
  const trimmed = output.trim();
  return TOOL_CANCELLED_SENTINELS.some((s) => trimmed.startsWith(s));
}

export function getClaudeAvailability(): ClaudeAvailability {
  const now = Date.now();
  if (cachedClaudeAvailability && now - cachedClaudeAvailability.checkedAt < CLAUDE_AVAILABILITY_CACHE_MS) {
    return cachedClaudeAvailability.value;
  }

  const cache = (value: ClaudeAvailability): ClaudeAvailability => {
    cachedClaudeAvailability = { checkedAt: Date.now(), value };
    return value;
  };

  const info = getClaudeExecutableInfo();
  if (!info.path) {
    return cache({
      available: false,
      reason: info.reason || "No Claude executable is available.",
    });
  }

  const probe = buildClaudeExecutableSpawn(["--version"], info);
  if (!probe) {
    return cache({
      available: false,
      reason: "No Claude executable is available.",
    });
  }

  const result = spawnSync(probe.command, probe.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: probe.shell,
    windowsHide: true,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return cache({
      available: false,
      reason: code === "ENOENT"
        ? "Claude executable was not found."
        : `Claude executable probe failed: ${result.error.message}`,
      detail: firstClaudeOutputLine(result.stdout, result.stderr),
    });
  }

  if (result.status !== 0) {
    const detail = firstClaudeOutputLine(result.stdout, result.stderr);
    return cache({
      available: false,
      reason: detail
        ? `Claude executable probe exited ${result.status}: ${detail}`
        : `Claude executable probe exited ${result.status}`,
      detail,
    });
  }

  return cache({
    available: true,
    version: firstClaudeOutputLine(result.stdout, result.stderr),
  });
}

function claudeExecutableQueryOptions(): Record<string, unknown> {
  if (!CLAUDE_BINARY_OVERRIDE) return {};
  return {
    pathToClaudeCodeExecutable: CLAUDE_BINARY_OVERRIDE,
    ...(isJavaScriptRuntimeFile(CLAUDE_BINARY_OVERRIDE) ? { executable: process.execPath } : {}),
  };
}

let claudeModelDiscoveryPromise: Promise<Array<Record<string, unknown>>> | null = null;

async function discoverClaudeSupportedModels(cwd: string): Promise<Array<Record<string, unknown>>> {
  if (claudeModelDiscoveryPromise) return claudeModelDiscoveryPromise;
  claudeModelDiscoveryPromise = (async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    const probe = query({
      // /usage is handled locally by Claude Code. It initializes the control
      // channel without consuming an inference turn, after which the SDK can
      // answer supportedModels().
      prompt: "/usage",
      options: {
        cwd,
        ...claudeExecutableQueryOptions(),
        tools: [],
        settingSources: ["user", "project"],
        abortController,
      },
    });
    try {
      for await (const message of probe) {
        if (message.type !== "system" || (message as any).subtype !== "init") continue;
        const models = await probe.supportedModels();
        return (Array.isArray(models) ? models : []) as Array<Record<string, unknown>>;
      }
      return [];
    } finally {
      clearTimeout(timeout);
      try { probe.close(); } catch {}
    }
  })().finally(() => {
    claudeModelDiscoveryPromise = null;
  });
  return claudeModelDiscoveryPromise;
}

export function refreshClaudeExecutableInfo(): ClaudeExecutableInfo {
  CLAUDE_EXECUTABLE_INFO = resolveClaudeExecutable();
  CLAUDE_BINARY_OVERRIDE = CLAUDE_EXECUTABLE_INFO.path;
  invalidateClaudeAvailabilityCache();
  logClaudeExecutableInfo();
  return getClaudeExecutableInfo();
}

interface PendingQuestion {
  questionId: string;
  resolve: (answers: Record<string, string>) => void;
  questionData?: ServerMessage; // stored so we can re-send on reconnect
}

interface MonitorState {
  monitoring: boolean;
  description: string;
  outputFile: string;
  lastSize: number;
  readerInterval: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  outputBuffer: string[];
  timeoutTimer: NodeJS.Timeout | null;
  timeoutSeconds: number | null;
  process?: import("child_process").ChildProcess;
}

const DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLAUDE_WARM_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.CLAUDE_WARM_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
})();

type ClaudeQueuedUserMessage = {
  type: "user";
  uuid: string;
  session_id: string;
  message: {
    role: "user";
    content: string;
  };
  parent_tool_use_id: null;
  origin: { kind: "human" };
  priority?: "now" | "next" | "later";
  shouldQuery?: boolean;
};

export interface ClaudePendingContext {
  text: string;
  uuid: string;
}

export function formatClaudeBoundaryContext(
  pending: readonly ClaudePendingContext[],
): string {
  if (pending.length === 0) return "";
  const messages = pending.map(
    (entry, index) => `<additional-user-context index="${index + 1}">\n${entry.text}\n</additional-user-context>`,
  );
  return [
    "The user sent the following additional context while this turn was running.",
    "Treat it as context or help for the work in progress. Receiving it is not itself a refusal, denial, interruption, or cancellation; follow the content itself normally.",
    ...messages,
  ].join("\n\n");
}

export function createClaudeContinuationMessages(
  pending: readonly ClaudePendingContext[],
  sessionId: string,
): ClaudeQueuedUserMessage[] {
  return pending.map((entry, index) => ({
    type: "user",
    uuid: entry.uuid,
    session_id: sessionId,
    message: { role: "user", content: entry.text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
    ...(index < pending.length - 1 ? { shouldQuery: false } : {}),
  }));
}

export function isLiveClaudeUserEcho(message: unknown): boolean {
  const candidate = message as any;
  return candidate?.type === "user"
    && candidate.isReplay !== true
    && candidate.isSynthetic !== true
    && candidate.tool_use_result == null;
}

export function claudeApiRetryDelayMs(message: unknown): number {
  const delay = Number((message as any)?.retry_delay_ms);
  return Number.isFinite(delay) && delay >= 0 ? delay : 0;
}

class ClaudeInputQueue implements AsyncIterable<ClaudeQueuedUserMessage> {
  private messages: ClaudeQueuedUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<ClaudeQueuedUserMessage>) => void> = [];
  private closed = false;

  push(message: ClaudeQueuedUserMessage): void {
    if (this.closed) throw new Error("Claude input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.messages.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeQueuedUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise<IteratorResult<ClaudeQueuedUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

interface PendingTurn {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class ClaudeSession {
  private sessionId: string | null = null;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private abortController: AbortController | null = null;
  /** Set when SocketAgent itself stopped the run, so backend-initiated tool
   *  cancellations can be told apart from ones the user actually asked for. */
  private _stopRequested = false;
  /** Tool cancellations seen in the current run that nobody asked for. */
  private _unexpectedCancellations = 0;
  /** Throttle clock for live thinking-token progress. */
  private _lastThinkingTokensSentAt = 0;
  private activeQuery: ReturnType<typeof query> | null = null;
  private activeInputQueue: ClaudeInputQueue | null = null;
  /** User-authored "next" messages waiting for a non-cancelling SDK boundary. */
  private _pendingBoundaryContext: ClaudePendingContext[] = [];
  private warmIdleTimer: NodeJS.Timeout | null = null;
  private pendingTurns: PendingTurn[] = [];
  private _isRunning = false;
  private _isWarmIdle = false;
  private _runStartedAt: string | null = null;
  private _ttsEnabled = false;
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice: string = "af_heart";
  private _kokoroSpeed: number = 1.0;
  private _effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high';
  private _thinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  private _disallowedTools: string[] = [];
  private _appendSystemPrompt: string = '';
  private _systemPromptOverride: string | undefined;
  private _pendingTransferContext: string | null = null;
  private _autoCompactEnabled = true;
  private _autoCompactWindow: number | undefined;
  private _autoCompactWindowOverride: number | undefined;
  private _forkFromSessionId?: string;
  private _suppressedToolResultIds: Set<string> = new Set();  // toolUseIds whose results should be hidden from client
  private _taskIdToToolUseId: Map<string, string> = new Map();  // agentId → toolUseId mapping
  private _sdkTaskIds: Set<string> = new Set();
  private _sdkBackgroundTasks: Map<string, ClaudeSdkBackgroundTask> = new Map();
  private _workflowRuns: Map<string, ClaudeWorkflowRun> = new Map();
  private _taskStatePersistedAt: Map<string, number> = new Map();
  private _monitoredTasks: Map<string, MonitorState> = new Map();
  private _taskOutputFiles: Map<string, string> = new Map();  // taskId → outputFile path
  private _activeSubagents: Map<string, ClaudeSubagentState> = new Map();
  private _activeBashStream: { interval: NodeJS.Timeout; filePath: string; lastSize: number } | null = null;
  private _bgBashWatchers: Map<string, { interval: NodeJS.Timeout; filePath: string; lastSize: number }> = new Map();
  private _activeToolUseId: string | null = null;  // currently-executing tool call
  private _activeToolName: string | null = null;
  private _readToolPaths: Map<string, string> = new Map();  // toolUseId → file_path for Read tool calls
  private _toolParentIds: Map<string, string> = new Map();  // toolUseId → owning subagent toolUseId
  private _isCompacting = false;  // whether context compaction is in progress
  private _compactStartedAt: string | null = null;
  private _permissionMode: string | null = null;  // current permission mode (e.g., "plan")
  private _authErrorSent = false;  // suppress duplicate exit-code error after auth failure
  private _authRequest: ClaudeAuthRequest | null = null;
  private _lastContextWindow = 0;  // last known context window size from modelUsage
  private _sessionModel: string | null = null;  // model reported by SessionStart hook
  private _requestedModel: string | null = null;
  private _streamingText = new Map<string, { content: string; parentToolUseId?: string; uuid?: string; startedAtMs?: number }>();
  private _streamingThinking = new Map<string, { content: string; parentToolUseId?: string; uuid?: string; startedAtMs?: number }>();
  private _thinkingProgress: { startedAtMs: number; estimatedTokens: number; uuid?: string } | null = null;
  private _activeSdkMessageIds = new Map<string, string>();
  private _lastPreview: string = "";
  private _lastSessionInit: ServerMessage | null = null;
  private _lastSupportedModels: ServerMessage | null = null;
  private _lastSupportedCommands: ServerMessage | null = null;
  private _lastSupportedAgents: ServerMessage | null = null;
  private clientSockets = new Set<WebSocket>();
  private sessionEventDelivery = new SessionEventDelivery((message) => {
    this.dispatchToClients(message as ServerMessage);
  });
  private streamSnapshots = new LatestSnapshotDispatcher<ServerMessage>((message) => {
    this.sendImmediately(message);
  });
  public onActivity?: () => void;
  public onClose?: () => void;
  public onSessionIdChanged?: (previousSessionId: string, nextSessionId: string) => void;
  public onMonitorOutput?: (text: string) => void;
  public onAgentSessionRequest?: AgentSessionToolExecutor;
  // When set, this fresh session replaces an old cleared session — remap the ID in the store
  public replacesSessionId?: string;
  public _resumeSessionId?: string;
  // Queue for injecting user messages mid-conversation

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private plugins: SocketAgentPlugin[] = []
  ) {
    this.attachWebSocket(ws);
  }

  setTtsEnabled(enabled: boolean): void {
    this._ttsEnabled = enabled;
    console.log(`TTS ${enabled ? 'enabled' : 'disabled'} for session ${this.sessionId || '(pending)'}`);
  }

  get ttsEnabled(): boolean {
    return this._ttsEnabled;
  }

  setTtsEngine(engine: "system" | "kokoro_server" | "kokoro_device"): void {
    this._ttsEngine = engine;
    console.log(`TTS engine set to ${engine} for session ${this.sessionId || '(pending)'}`);
  }

  get ttsEngine(): string {
    return this._ttsEngine;
  }

  setKokoroVoice(voice: string): void {
    this._kokoroVoice = voice;
  }

  setKokoroSpeed(speed: number): void {
    this._kokoroSpeed = speed;
  }

  setEffort(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): void {
    this._effort = effort;
    this.persistAgentSettings({ effort });
    console.log(`Effort set to ${effort} for session ${this.sessionId || '(pending)'}`);
  }

  get effort(): string {
    return this._effort;
  }

  setThinking(thinking: typeof ClaudeSession.prototype._thinking): void {
    this._thinking = thinking;
    this.persistAgentSettings({ thinking });
    console.log(`Thinking set to ${JSON.stringify(thinking)} for session ${this.sessionId || '(pending)'}`);
  }

  get thinking() {
    return this._thinking;
  }

  setDisallowedTools(tools: string[]): void {
    this._disallowedTools = [...tools];
    this.persistAgentSettings({ disallowedTools: this._disallowedTools });
    console.log(`Disallowed tools set to [${tools.join(', ')}] for session ${this.sessionId || '(pending)'}`);
  }

  setAppendSystemPrompt(text: string, options: { inherited?: boolean; clearOverride?: boolean } = {}): void {
    this._appendSystemPrompt = text;
    if (options.clearOverride) {
      this._systemPromptOverride = undefined;
      this.persistAgentSettings({ systemPrompt: undefined });
    } else if (!options.inherited) {
      this._systemPromptOverride = text;
      this.persistAgentSettings({ systemPrompt: text });
    }
    console.log(`Append system prompt set (${text.length} chars) for session ${this.sessionId || '(pending)'}`);
  }

  setPendingTransferContext(context: string): void {
    this._pendingTransferContext = context.trim() || null;
  }

  setClaudeAutoCompact(enabled: boolean): void {
    this._autoCompactEnabled = enabled;
    this.persistAgentSettings({ claudeAutoCompact: enabled });
    if (this.activeQuery) {
      void this.activeQuery
        .applyFlagSettings({ autoCompactEnabled: enabled })
        .catch((err: any) => {
          console.warn(
            `Failed to apply Claude auto-compact setting live: ${err?.message || String(err)}`,
          );
        });
    }
    console.log(`Claude auto-compact ${enabled ? 'enabled' : 'disabled'} for session ${this.sessionId || '(pending)'}`);
  }

  setClaudeAutoCompactWindow(
    window: number | null | undefined,
    options: { inherited?: boolean; clearOverride?: boolean } = {},
  ): void {
    const normalized = window == null ? undefined : window;
    this._autoCompactWindow = normalized;
    if (options.clearOverride) {
      this._autoCompactWindowOverride = undefined;
      this.persistAgentSettings({ claudeAutoCompactWindow: undefined });
    } else if (!options.inherited) {
      this._autoCompactWindowOverride = normalized;
      this.persistAgentSettings({ claudeAutoCompactWindow: normalized });
    }
    if (this.activeQuery) {
      void this.activeQuery
        .applyFlagSettings({ autoCompactWindow: normalized ?? null })
        .catch((err: any) => {
          console.warn(
            `Failed to apply Claude auto-compact window live: ${err?.message || String(err)}`,
          );
        });
    }
    console.log(
      `Claude auto-compact window set to ${normalized ?? "SDK default"}`
      + `${options.inherited || options.clearOverride ? " (inherited)" : " (session override)"}`
      + ` for session ${this.sessionId || "(pending)"}`,
    );
  }

  get claudeAutoCompactWindowOverride(): number | undefined {
    return this._autoCompactWindowOverride;
  }

  private claudeFlagSettings(): Settings {
    return {
      autoCompactEnabled: this._autoCompactEnabled,
      ...(this._autoCompactWindow !== undefined
        ? { autoCompactWindow: this._autoCompactWindow }
        : {}),
    };
  }

  setForkSource(sessionId: string): void {
    this._forkFromSessionId = sessionId;
    console.log(`Fork source set to ${sessionId}`);
  }

  private _resumeSessionAt?: string;

  /** Set a message UUID to resume the conversation at (truncates conversation after this point) */
  setResumeSessionAt(uuid: string): void {
    this._resumeSessionAt = uuid;
    console.log(`Resume-at set to ${uuid}`);
  }

  private _stoppedTasks: Set<string> = new Set();  // prevent duplicate stop notifications

  async stopTask(taskId: string): Promise<void> {
    // Deduplicate — only process the first stop request per task
    if (this._stoppedTasks.has(taskId)) {
      console.log(`[StopTask] Already stopped ${taskId}, ignoring`);
      return;
    }
    this._stoppedTasks.add(taskId);
    console.log(`[StopTask] Processing stop for ${taskId}, activeQuery=${!!this.activeQuery}`);

    if (!this.activeQuery) {
      console.log(`[StopTask] No active query for task ${taskId} — task likely already finished`);
      return;
    }
    // The app sends toolUseId, but the SDK needs the agentId
    let sdkTaskId = taskId;
    for (const [agentId, toolUseId] of this._taskIdToToolUseId.entries()) {
      if (toolUseId === taskId) {
        sdkTaskId = agentId;
        break;
      }
    }
    console.log(`[StopTask] Calling SDK stopTask(${sdkTaskId})`);
    // Fire and forget — don't await, the SDK will handle it async
    this.activeQuery.stopTask(sdkTaskId).then(() => {
      console.log(`[StopTask] SDK stopped task ${sdkTaskId}`);
    }).catch(e => {
      console.error(`[StopTask] SDK error stopping ${sdkTaskId}: ${e}`);
    });
  }

  private _startBashWatcher(filePath: string): void {
    this._stopBashWatcher();  // clean up any previous watcher
    console.log(`[BashWatcher] Starting on ${filePath}`);
    const state = { interval: null as any, filePath, lastSize: 0 };
    state.interval = setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const content = buf.toString("utf8");
          this.send({
            type: "tool_stderr",
            content,
            sessionId: this.sessionId || "",
          } as any);
        }
      } catch {}
    }, 500);
    this._activeBashStream = state;
  }

  private _stopBashWatcher(): void {
    if (this._activeBashStream) {
      clearInterval(this._activeBashStream.interval);
      this._activeBashStream = null;
    }
  }

  /** Independent watcher for backgrounded bash tasks — survives when next tool starts */
  private _startBgBashWatcher(taskId: string, toolUseId: string, filePath: string): void {
    this._stopBgBashWatcher(taskId);
    console.log(`[BgBashWatcher] Starting for ${taskId} (toolUseId=${toolUseId}) on ${filePath}`);
    const state = { interval: null as any, filePath, lastSize: 0 };
    state.interval = setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const content = buf.toString("utf8");
          this.send({
            type: "tool_stderr",
            toolUseId,
            content,
            sessionId: this.sessionId || "",
          } as any);
        }
      } catch {}
    }, 1000);
    state.interval = state.interval;
    this._bgBashWatchers.set(taskId, state);
  }

  private _stopBgBashWatcher(taskId: string): void {
    const watcher = this._bgBashWatchers.get(taskId);
    if (watcher) {
      clearInterval(watcher.interval);
      this._bgBashWatchers.delete(taskId);
    }
  }

  // ── Monitor output tailing ──

  private _startMonitorReader(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;
    this._stopMonitorReader(taskId);  // clean up any previous reader

    console.log(`[Monitor] Starting reader for ${taskId} on ${state.outputFile}`);
    state.readerInterval = setInterval(() => {
      try {
        if (!fs.existsSync(state.outputFile)) return;
        const stat = fs.statSync(state.outputFile);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(state.outputFile, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const newContent = buf.toString("utf8");
          const lines = newContent.split("\n").filter(l => l.length > 0);
          if (lines.length > 0) {
            const lineContent = lines.join("\n");
            // Persist one cumulative, revisioned card snapshot so a retry or
            // reconnect can replace state instead of duplicating chunks.
            let positioned;
            if (this.sessionId) {
              positioned = appendHistory(this.sessionId, {
                role: "monitor",
                content: fs.readFileSync(state.outputFile, "utf8"),
                taskId,
                description: state.description,
                toolInput: { snapshot: true },
                timestamp: new Date().toISOString(),
              });
            }
            this.send({
              type: "monitor_output",
              taskId,
              content: lineContent,
              snapshotContent: positioned?.content || fs.readFileSync(state.outputFile, "utf8"),
              description: state.description,
              snapshot: true,
              sessionId: this.sessionId || "",
              ...(positioned ? {
                entryId: positioned.entryId,
                sessionSeq: positioned.sessionSeq,
                revision: positioned.revision,
              } : {}),
            } as any);
            // Accumulate for Claude injection (5s debounce)
            state.outputBuffer.push(...lines);
            if (state.debounceTimer) clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(() => {
              this._flushMonitorBuffer(taskId);
            }, 5000);
          }
        }
      } catch {}
    }, 500);
  }

  private _stopMonitorReader(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;
    if (state.readerInterval) {
      clearInterval(state.readerInterval);
      state.readerInterval = null;
    }
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  }

  private _flushMonitorBuffer(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state || state.outputBuffer.length === 0) return;

    const content = state.outputBuffer.join("\n");
    state.outputBuffer = [];
    state.debounceTimer = null;

    const text = `[Monitor: "${state.description}" (${taskId})]\n${content}`;
    console.log(`[Monitor] Flushing ${content.length} chars for ${taskId}`);

    // Inject to Claude or start new query (app already gets live output from reader)
    if (this._isRunning && this.activeQuery) {
      this.injectMessage(text, 'next').catch(e => {
        console.error(`[Monitor] Inject error: ${e}`);
      });
    } else if (this.onMonitorOutput) {
      this.onMonitorOutput(text);
    }
  }

  private _cleanupMonitor(taskId: string, flush = false): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;

    console.log(`[Monitor] Cleaning up ${taskId} (flush=${flush})`);
    this._stopMonitorReader(taskId);

    if (flush && state.outputBuffer.length > 0) {
      this._flushMonitorBuffer(taskId);
    }

    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    // Kill Monitor-spawned processes
    if (state.process) {
      try {
        if (state.process.pid) {
          process.kill(-state.process.pid, "SIGTERM");
          // Force kill after 5s if still alive
          setTimeout(() => {
            try { if (state.process?.pid) process.kill(-state.process.pid, "SIGKILL"); } catch {}
          }, 5000);
        }
      } catch {}
    }

    this._monitoredTasks.delete(taskId);

    // Notify app
    this.send({
      type: "monitor_started",
      taskId,
      description: state.description,
      monitoring: false,
      sessionId: this.sessionId || "",
    } as any);
  }

  private _cleanupAllMonitors(): void {
    for (const taskId of Array.from(this._monitoredTasks.keys())) {
      this._cleanupMonitor(taskId, false);
    }
  }

  private async _hardCleanupAllMonitors(): Promise<void> {
    const owned = [...this._monitoredTasks.entries()];
    for (const [taskId, state] of owned) {
      this._stopMonitorReader(taskId);
      if (state.timeoutTimer) {
        clearTimeout(state.timeoutTimer);
        state.timeoutTimer = null;
      }
    }
    await Promise.all(owned.map(([, state]) => {
      const child = state.process;
      if (!child) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
      if (!child.pid || child.exitCode !== null) {
        resolve();
        return;
      }
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        clearTimeout(abandonTimer);
        if (error) reject(error);
        else resolve();
      };
      const killTree = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], {
            stdio: "ignore",
            windowsHide: true,
          });
          return;
        }
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
        }
      };
      const forceTimer = setTimeout(() => killTree(true), 750);
      const abandonTimer = setTimeout(() => finish(
        new Error(`Monitor process tree ${child.pid} did not exit after SIGKILL`),
      ), 2_000);
      child.once("exit", () => finish());
      killTree(false);
      });
    }));
    for (const [taskId, state] of owned) {
      if (this._monitoredTasks.get(taskId) !== state) continue;
      this._monitoredTasks.delete(taskId);
      this.send({
        type: "monitor_started",
        taskId,
        description: state.description,
        monitoring: false,
        sessionId: this.sessionId || "",
      } as any);
    }
  }

  public stopMonitoring(taskId: string): void {
    if (stopAppMonitor(taskId, true, true)) return;
    this._cleanupMonitor(taskId, true);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  getDelegatedLiveActivity(): DelegatedAgentLiveActivity {
    const assistantText = [...this._streamingText.entries()]
      .slice(-5)
      .map(([streamId, stream]) => ({
        stream_id: streamId,
        content: stream.content.slice(-6_000),
        ...(stream.parentToolUseId
          ? { parent_tool_use_id: stream.parentToolUseId }
          : {}),
      }));
    const activeTools =
      this._activeToolUseId && this._activeToolName
        ? [
            {
              tool_use_id: this._activeToolUseId,
              tool: this._activeToolName,
              ...(this._toolParentIds.get(this._activeToolUseId)
                ? {
                    parent_tool_use_id: this._toolParentIds.get(
                      this._activeToolUseId,
                    ),
                  }
                : {}),
            },
          ]
        : [];
    const reasoningInProgress =
      this._streamingThinking.size > 0 || this._thinkingProgress !== null;
    return {
      running: this.isBusy,
      ...(assistantText.length > 0 ? { assistant_text: assistantText } : {}),
      ...(activeTools.length > 0 ? { active_tools: activeTools } : {}),
      ...(reasoningInProgress
        ? {
            reasoning: {
              in_progress: true,
              ...(this._thinkingProgress?.estimatedTokens
                ? {
                    estimated_tokens:
                      this._thinkingProgress.estimatedTokens,
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  get isWarmIdle(): boolean {
    return this._isWarmIdle;
  }

  private _hasClaudeBackgroundWork(): boolean {
    return this._sdkBackgroundTasks.size > 0
      || Array.from(this._activeSubagents.values()).some(
        (task) => task.isBackgrounded && (task.status === "pending" || task.status === "running" || task.status === "paused"),
      );
  }

  get isBusy(): boolean {
    return this._isRunning || this._isCompacting || this._hasClaudeBackgroundWork();
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  get activeStartedAt(): string | null {
    if (this._isCompacting) return this._compactStartedAt || this._runStartedAt;
    if (this._isRunning) return this._runStartedAt;
    if (this._hasClaudeBackgroundWork()) {
      const starts = Array.from(this._activeSubagents.values())
        .filter((task) => task.isBackgrounded)
        .map((task) => task.startedAt)
        .sort();
      return starts[0] || this._runStartedAt;
    }
    return null;
  }

  private _refreshPlanRateLimits(): void {
    const activeQuery = this.activeQuery as any;
    const getUsage =
      activeQuery?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof getUsage !== "function") return;
    Promise.resolve(getUsage.call(activeQuery))
      .then((usage: any) => {
        for (const event of buildClaudeUsageRateLimitEvents(
          usage,
          this.sessionId || "",
        )) {
          recordRateLimitEvent(event);
          this.send(event as any);
        }
      })
      .catch(() => {
        // Usage limits are optional for API/provider sessions and older SDKs.
      });
  }

  get permissionMode(): string | null {
    return this._permissionMode;
  }

  private _clearWarmIdleTimer(): void {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
  }

  private _resolvePendingTurn(): void {
    const pending = this.pendingTurns.shift();
    pending?.resolve();
  }

  private _rejectPendingTurns(err: Error): void {
    while (this.pendingTurns.length > 0) {
      const pending = this.pendingTurns.shift();
      pending?.reject(err);
    }
  }

  private _trackPendingTurn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingTurns.push({ resolve, reject });
    });
  }

  private _createUserMessage(
    text: string,
    sessionId: string,
    uuid: string,
    priority?: "now" | "next" | "later",
    shouldQuery?: boolean,
  ): ClaudeQueuedUserMessage {
    return {
      type: "user",
      uuid,
      session_id: sessionId,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      ...(priority ? { priority } : {}),
      ...(shouldQuery === undefined ? {} : { shouldQuery }),
    };
  }

  private _takePendingBoundaryContext(): ClaudePendingContext[] {
    if (this._pendingBoundaryContext.length === 0) return [];
    return this._pendingBoundaryContext.splice(0);
  }

  private _enterWarmIdle(): void {
    if (!this.activeQuery || !this.activeInputQueue || CLAUDE_WARM_IDLE_TIMEOUT_MS <= 0) return;
    // A root turn can finish while background subagents are still running.
    // Keep the SDK process alive until its authoritative live-task snapshot is
    // empty; closing the warm stream here would terminate those agents.
    if (this._hasClaudeBackgroundWork()) {
      this._isWarmIdle = false;
      this._clearWarmIdleTimer();
      console.log(`[WarmIdle] Deferred while ${this.activeBackgroundTasks.size} Claude background task(s) remain`);
      return;
    }
    this._isRunning = false;
    this._isWarmIdle = true;
    this._clearWarmIdleTimer();
    const sid = this.sessionId || "";
    this.warmIdleTimer = setTimeout(() => {
      if (!this._isWarmIdle) return;
      console.log(`[WarmIdle] Closing Claude SDK stream for ${sid || "(unknown)"} after ${CLAUDE_WARM_IDLE_TIMEOUT_MS}ms idle`);
      this._isWarmIdle = false;
      this.activeInputQueue?.close();
      try { this.activeQuery?.close(); } catch {}
    }, CLAUDE_WARM_IDLE_TIMEOUT_MS);
    this.warmIdleTimer.unref?.();
    console.log(`[WarmIdle] Keeping Claude SDK stream open for ${sid || "(pending)"} (${CLAUDE_WARM_IDLE_TIMEOUT_MS}ms timeout)`);
  }

  private _leaveWarmIdle(): void {
    this._clearWarmIdleTimer();
    this._isWarmIdle = false;
  }

  private _retractClaudeMessages(rawUuids: unknown): void {
    if (!Array.isArray(rawUuids)) return;
    const uuids = [...new Set(rawUuids.map((uuid) => String(uuid || "").trim()).filter(Boolean))];
    if (uuids.length === 0) return;
    const retracted = new Set(uuids);
    for (const [streamId, stream] of this._streamingText) {
      if (stream.uuid && retracted.has(stream.uuid)) this._streamingText.delete(streamId);
    }
    for (const [streamId, stream] of this._streamingThinking) {
      if (stream.uuid && retracted.has(stream.uuid)) this._streamingThinking.delete(streamId);
    }
    const sessionId = this.sessionId || "";
    if (sessionId) {
      try {
        removeHistoryEntriesByUuids(sessionId, uuids);
      } catch (error) {
        console.error(`[SDK] Failed to retract superseded history: ${String(error)}`);
      }
      this.send({ type: "history_retracted", sessionId, uuids });
    }
  }

  private _handleClaudeConversationReset(message: any): void {
    const previousSessionId = this.sessionId || String(message?.session_id || "");
    const nextSessionId = String(message?.new_conversation_id || "").trim();
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return;
    const previous = getSession(previousSessionId);
    remapSession(previousSessionId, nextSessionId);
    remapSessionMemory(previousSessionId, nextSessionId);
    this.sessionId = nextSessionId;
    this._resumeSessionId = nextSessionId;
    this._streamingText.clear();
    this._streamingThinking.clear();
    this._thinkingProgress = null;
    this.onSessionIdChanged?.(previousSessionId, nextSessionId);
    this.send({
      type: "session_created",
      sessionId: nextSessionId,
      replacesSessionId: previousSessionId,
      cwd: previous?.cwd || this.cwd,
      title: previous?.title,
      backend: "claude",
    });
  }

  get sessionModel(): string | null {
    return this._sessionModel;
  }

  /** Active background task IDs (agentId → toolUseId) */
  get activeBackgroundTasks(): Map<string, string> {
    const active = new Map<string, string>();
    for (const [taskId, toolUseId] of this._taskIdToToolUseId) {
      if (!this._sdkTaskIds.has(taskId) || this._sdkBackgroundTasks.has(taskId)) {
        active.set(taskId, toolUseId);
      }
    }
    for (const taskId of this._sdkBackgroundTasks.keys()) {
      if (!active.has(taskId)) {
        active.set(taskId, this._taskIdToToolUseId.get(taskId) || taskId);
      }
    }
    for (const task of this._activeSubagents.values()) {
      if (!task.isBackgrounded) continue;
      const taskId = task.agentId || task.toolUseId;
      if (!active.has(taskId)) active.set(taskId, task.toolUseId);
    }
    return active;
  }

  /** Active subagent tasks with metadata */
  getActiveSubagents(): ActiveSubagentsServerMessage["tasks"] {
    return Array.from(this._activeSubagents.entries()).map(([toolUseId, info]) => ({
      agentId: info.agentId || toolUseId,
      toolUseId: info.toolUseId,
      description: info.description,
      subagentType: info.subagentType,
      startedAt: info.startedAt,
      status: info.status === "stopped" ? "interrupted"
        : info.status === "failed" ? "errored"
        : info.status === "paused" ? "pending"
        : info.status === "completed" ? "completed"
        : "running",
      isBackgrounded: info.isBackgrounded,
      ...(info.prompt ? { prompt: info.prompt } : {}),
      ...(info.resolvedModel ? { model: info.resolvedModel } : {}),
      ...(info.progressSummary ? { progressSummary: info.progressSummary } : {}),
      ...(info.lastToolName ? { lastToolName: info.lastToolName } : {}),
      ...(info.usage ? { usage: info.usage } : {}),
      ...(info.parentToolUseId ? { parentToolUseId: info.parentToolUseId } : {}),
    }));
  }

  private _taskUsage(raw: any): ClaudeSubagentState["usage"] | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const totalTokens = Number(raw.total_tokens ?? raw.totalTokens);
    const toolUses = Number(raw.tool_uses ?? raw.toolUses);
    const durationMs = Number(raw.duration_ms ?? raw.durationMs);
    if (![totalTokens, toolUses, durationMs].some(Number.isFinite)) return undefined;
    return {
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      toolUses: Number.isFinite(toolUses) ? toolUses : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
  }

  private _isSubagentTask(taskType: unknown, subagentType?: unknown): boolean {
    if (typeof subagentType === "string" && subagentType.length > 0) return true;
    const normalized = String(taskType || "").toLowerCase();
    return normalized.includes("agent") || normalized === "subagent";
  }

  private _findSubagentByTaskId(taskId: string): [string, ClaudeSubagentState] | undefined {
    for (const entry of this._activeSubagents.entries()) {
      if (entry[1].agentId === taskId) return entry;
    }
    return undefined;
  }

  private _emitActiveSubagentsSnapshot(): void {
    this.send({
      type: "active_subagents",
      tasks: this.getActiveSubagents(),
      sessionId: this.sessionId || "",
      backend: "claude",
      replace: true,
    });
  }

  private _publishWorkflowRun(
    run: ClaudeWorkflowRun,
    force = false,
    statusOverride?: string,
    summaryOverride?: string,
  ): WorkflowStatePayload {
    let raw: unknown;
    if (run.statePath) {
      try {
        if (fs.existsSync(run.statePath)) {
          raw = JSON.parse(fs.readFileSync(run.statePath, "utf8"));
        }
      } catch (error) {
        console.warn(
          `[Workflow] Failed to read ${run.statePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const snapshot = sanitizeClaudeWorkflowState(raw, {
      taskId: run.taskId,
      toolUseId: run.toolUseId,
      runId: run.runId,
      workflowName: run.workflowName,
      summary: summaryOverride || run.summary,
      status: statusOverride || run.lastSnapshot?.status || "running",
      scriptPath: run.scriptPath,
      transcriptDir: run.transcriptDir,
      statePath: run.statePath,
    });
    if (statusOverride) snapshot.status = statusOverride;
    if (summaryOverride) {
      snapshot.summary = boundedWorkflowString(summaryOverride, 2_000)
        || snapshot.summary;
    }
    const signature = JSON.stringify(snapshot);
    if (!force && signature === run.lastSignature) return run.lastSnapshot || snapshot;
    run.lastSignature = signature;
    run.lastSnapshot = snapshot;
    this.send({
      type: "workflow_state",
      ...snapshot,
      sessionId: this.sessionId || "",
    });
    const active = snapshot.status === "running"
      || snapshot.status === "pending"
      || snapshot.status === "paused";
    this._persistTaskState({
      taskId: run.taskId,
      taskKind: "workflow",
      status: snapshot.status,
      content: snapshot.resultPreview || snapshot.summary,
      taskDescription: snapshot.summary,
      originToolUseId: run.toolUseId,
      taskType: "local_workflow",
      isBackgrounded: active,
      workflowState: snapshot,
    }, active ? 1_500 : 0);
    this.onActivity?.();
    return snapshot;
  }

  private _trackWorkflowLaunch(output: Record<string, any>, toolUseId: string): void {
    const taskId = String(output.taskId || "");
    if (!taskId || !toolUseId) return;
    const previous = this._workflowRuns.get(taskId);
    if (previous?.interval) clearInterval(previous.interval);
    const run: ClaudeWorkflowRun = {
      taskId,
      toolUseId,
      runId: String(output.runId || "") || undefined,
      workflowName: String(output.workflowName || "") || undefined,
      summary: String(output.summary || output.workflowName || "Workflow"),
      scriptPath: String(output.scriptPath || "") || undefined,
      transcriptDir: String(output.transcriptDir || "") || undefined,
      statePath: workflowStatePathForLaunch(output),
    };
    this._workflowRuns.set(taskId, run);
    this._sdkTaskIds.add(taskId);
    this._taskIdToToolUseId.set(taskId, toolUseId);
    this._sdkBackgroundTasks.set(taskId, {
      taskId,
      taskType: "local_workflow",
      description: run.summary,
    });
    this._publishWorkflowRun(run, true);
    run.interval = setInterval(() => {
      this._publishWorkflowRun(run);
    }, 400);
    run.interval.unref?.();
  }

  private _finishWorkflowRun(
    taskId: string,
    status: string,
    summary?: string,
  ): WorkflowStatePayload | undefined {
    const run = this._workflowRuns.get(taskId);
    if (!run) return undefined;
    if (run.interval) {
      clearInterval(run.interval);
      run.interval = undefined;
    }
    const snapshot = this._publishWorkflowRun(run, true, status, summary);
    this._workflowRuns.delete(taskId);
    return snapshot;
  }

  private _settleWorkflowRuns(status: "stopped" | "failed", summary: string): void {
    for (const taskId of [...this._workflowRuns.keys()]) {
      this._finishWorkflowRun(taskId, status, summary);
    }
  }

  private _handleSdkTaskStarted(ts: any): void {
    const taskId = String(ts.task_id || "");
    const directToolUseId = String(ts.tool_use_id || "") || undefined;
    const toolUseId = directToolUseId || this._taskIdToToolUseId.get(taskId);
    if (taskId) {
      this._sdkTaskIds.add(taskId);
      if (toolUseId) this._taskIdToToolUseId.set(taskId, toolUseId);
      this._sdkBackgroundTasks.set(taskId, {
        taskId,
        taskType: String(ts.task_type || ""),
        description: String(ts.description || ""),
      });
    }

    const isWorkflow = String(ts.task_type || "") === "local_workflow";
    const isSubagent = this._isSubagentTask(ts.task_type, ts.subagent_type);
    if (toolUseId && isSubagent) {
      const previous = this._activeSubagents.get(toolUseId);
      this._activeSubagents.set(toolUseId, {
        toolUseId,
        agentId: taskId || previous?.agentId,
        description: String(ts.description || previous?.description || "Agent"),
        subagentType: String(ts.subagent_type || previous?.subagentType || ""),
        startedAt: previous?.startedAt || new Date().toISOString(),
        isBackgrounded: true,
        status: "running",
        ...(String(ts.prompt || previous?.prompt || "") ? { prompt: String(ts.prompt || previous?.prompt || "") } : {}),
        ...(previous?.parentToolUseId ? { parentToolUseId: previous.parentToolUseId } : {}),
        ...(previous?.resolvedModel ? { resolvedModel: previous.resolvedModel } : {}),
        ...(previous?.progressSummary ? { progressSummary: previous.progressSummary } : {}),
        ...(previous?.lastToolName ? { lastToolName: previous.lastToolName } : {}),
        ...(previous?.usage ? { usage: previous.usage } : {}),
      });
    }

    this._persistTaskState({
      taskId,
      taskKind: isWorkflow ? "workflow" : isSubagent ? "subagent" : "background",
      status: "running",
      content: String(ts.description || ""),
      taskDescription: String(ts.description || "") || undefined,
      originToolUseId: toolUseId,
      taskType: String(ts.task_type || "") || undefined,
      subagentType: String(ts.subagent_type || "") || undefined,
      prompt: String(ts.prompt || "") || undefined,
      isBackgrounded: true,
      skipTranscript: ts.skip_transcript === true || undefined,
      ...(isWorkflow ? {
        workflowState: this._workflowRuns.get(taskId)?.lastSnapshot
          || sanitizeClaudeWorkflowState(undefined, {
            taskId,
            toolUseId,
            workflowName: String(ts.workflow_name || "") || undefined,
            summary: String(ts.description || "Workflow"),
            status: "running",
          }),
      } : {}),
    });
    this.send({
      type: "task_started",
      taskId,
      toolUseId,
      description: String(ts.description || ""),
      taskType: String(ts.task_type || "") || undefined,
      subagentType: String(ts.subagent_type || "") || undefined,
      workflowName: String(ts.workflow_name || "") || undefined,
      prompt: String(ts.prompt || "") || undefined,
      skipTranscript: ts.skip_transcript === true || undefined,
      sessionId: this.sessionId || "",
    });
    this._emitActiveSubagentsSnapshot();
    this.onActivity?.();
  }

  private _handleSdkTaskProgress(tp: any): void {
    const taskId = String(tp.task_id || "");
    const toolUseId = String(tp.tool_use_id || "")
      || this._taskIdToToolUseId.get(taskId)
      || undefined;
    const usage = this._taskUsage(tp.usage);
    if (taskId) this._sdkTaskIds.add(taskId);
    if (taskId && toolUseId) this._taskIdToToolUseId.set(taskId, toolUseId);

    const taskType = this._sdkBackgroundTasks.get(taskId)?.taskType;
    const isWorkflow = taskType === "local_workflow";
    const isSubagent = Boolean(
      (toolUseId && this._activeSubagents.has(toolUseId))
      || this._isSubagentTask(undefined, tp.subagent_type),
    );
    if (toolUseId && isSubagent) {
      const previous = this._activeSubagents.get(toolUseId);
      this._activeSubagents.set(toolUseId, {
        toolUseId,
        agentId: taskId || previous?.agentId,
        description: String(tp.description || previous?.description || "Agent"),
        subagentType: String(tp.subagent_type || previous?.subagentType || ""),
        startedAt: previous?.startedAt || new Date().toISOString(),
        isBackgrounded: previous?.isBackgrounded ?? this._sdkBackgroundTasks.has(taskId),
        status: "running",
        ...(previous?.prompt ? { prompt: previous.prompt } : {}),
        ...(previous?.parentToolUseId ? { parentToolUseId: previous.parentToolUseId } : {}),
        ...(previous?.resolvedModel ? { resolvedModel: previous.resolvedModel } : {}),
        ...(String(tp.summary || previous?.progressSummary || "") ? { progressSummary: String(tp.summary || previous?.progressSummary || "") } : {}),
        ...(String(tp.last_tool_name || previous?.lastToolName || "") ? { lastToolName: String(tp.last_tool_name || previous?.lastToolName || "") } : {}),
        ...(usage || previous?.usage ? { usage: usage || previous?.usage } : {}),
      });
    }

    const subagent = toolUseId ? this._activeSubagents.get(toolUseId) : undefined;
    this._persistTaskState({
      taskId,
      taskKind: isWorkflow ? "workflow" : isSubagent ? "subagent" : "background",
      status: "running",
      content: String(tp.summary || tp.description || ""),
      taskDescription: String(tp.description || subagent?.description || "") || undefined,
      originToolUseId: toolUseId,
      parentToolUseId: subagent?.parentToolUseId || null,
      taskType: this._sdkBackgroundTasks.get(taskId)?.taskType || undefined,
      subagentType: String(tp.subagent_type || subagent?.subagentType || "") || undefined,
      prompt: subagent?.prompt,
      progressSummary: String(tp.summary || "") || undefined,
      lastToolName: String(tp.last_tool_name || "") || undefined,
      usage: usage || subagent?.usage,
      isBackgrounded: this._sdkBackgroundTasks.has(taskId) || subagent?.isBackgrounded,
      ...(isWorkflow && this._workflowRuns.get(taskId)?.lastSnapshot
        ? { workflowState: this._workflowRuns.get(taskId)!.lastSnapshot }
        : {}),
    }, 1_500);
    this.send({
      type: "bg_task_progress",
      taskId,
      toolUseId,
      description: String(tp.description || ""),
      subagentType: String(tp.subagent_type || "") || undefined,
      usage,
      lastToolName: String(tp.last_tool_name || "") || undefined,
      summary: String(tp.summary || "") || undefined,
      sessionId: this.sessionId || "",
    });
    this.onActivity?.();
  }

  private _handleSdkTaskUpdated(tu: any): void {
    const taskId = String(tu.task_id || "");
    const toolUseId = this._taskIdToToolUseId.get(taskId)
      || this._findSubagentByTaskId(taskId)?.[0];
    const rawPatch = tu.patch && typeof tu.patch === "object" ? tu.patch : {};
    const rawStatus = String(rawPatch.status || "");
    const state = toolUseId ? this._activeSubagents.get(toolUseId) : undefined;
    if (state) {
      if (rawPatch.description) state.description = String(rawPatch.description);
      if (typeof rawPatch.is_backgrounded === "boolean") {
        state.isBackgrounded = rawPatch.is_backgrounded;
      }
      if (rawStatus === "killed") state.status = "stopped";
      else if (rawStatus === "pending" || rawStatus === "running" || rawStatus === "completed"
        || rawStatus === "failed" || rawStatus === "paused") {
        state.status = rawStatus;
      }
    }

    const normalizedStatus = rawStatus === "killed" ? "stopped" : rawStatus || state?.status || "running";
    const taskType = this._sdkBackgroundTasks.get(taskId)?.taskType;
    const isWorkflow = taskType === "local_workflow";
    this._persistTaskState({
      taskId,
      taskKind: isWorkflow ? "workflow" : state ? "subagent" : "background",
      status: normalizedStatus,
      content: String(rawPatch.error || rawPatch.description || state?.progressSummary || state?.description || ""),
      taskDescription: String(rawPatch.description || state?.description || "") || undefined,
      originToolUseId: toolUseId,
      parentToolUseId: state?.parentToolUseId || null,
      taskType: this._sdkBackgroundTasks.get(taskId)?.taskType || undefined,
      subagentType: state?.subagentType || undefined,
      prompt: state?.prompt,
      progressSummary: state?.progressSummary,
      lastToolName: state?.lastToolName,
      usage: state?.usage,
      isBackgrounded: typeof rawPatch.is_backgrounded === "boolean"
        ? rawPatch.is_backgrounded
        : state?.isBackgrounded ?? this._sdkBackgroundTasks.has(taskId),
      ...(isWorkflow && this._workflowRuns.get(taskId)?.lastSnapshot
        ? { workflowState: this._workflowRuns.get(taskId)!.lastSnapshot }
        : {}),
    });
    this.send({
      type: "task_updated",
      taskId,
      toolUseId,
      patch: {
        ...(rawStatus ? { status: rawStatus } : {}),
        ...(rawPatch.description ? { description: String(rawPatch.description) } : {}),
        ...(Number.isFinite(Number(rawPatch.end_time)) ? { endTime: Number(rawPatch.end_time) } : {}),
        ...(Number.isFinite(Number(rawPatch.total_paused_ms)) ? { totalPausedMs: Number(rawPatch.total_paused_ms) } : {}),
        ...(rawPatch.error ? { error: String(rawPatch.error) } : {}),
        ...(typeof rawPatch.is_backgrounded === "boolean" ? { isBackgrounded: rawPatch.is_backgrounded } : {}),
      },
      sessionId: this.sessionId || "",
    } as any);
    this._emitActiveSubagentsSnapshot();
    this.onActivity?.();
  }

  private _handleSdkBackgroundTasksChanged(message: any): void {
    const tasks = Array.isArray(message.tasks) ? message.tasks : [];
    const replacement = new Map<string, ClaudeSdkBackgroundTask>();
    for (const task of tasks) {
      const taskId = String(task?.task_id || "");
      if (!taskId) continue;
      replacement.set(taskId, {
        taskId,
        taskType: String(task?.task_type || ""),
        description: String(task?.description || ""),
      });
      this._sdkTaskIds.add(taskId);
      const mapped = this._taskIdToToolUseId.get(taskId);
      const subagent = mapped ? this._activeSubagents.get(mapped) : this._findSubagentByTaskId(taskId)?.[1];
      if (subagent) {
        subagent.isBackgrounded = true;
        subagent.status = "running";
        if (task?.description) subagent.description = String(task.description);
      }
    }

    const liveIds = new Set(replacement.keys());
    for (const [toolUseId, state] of this._activeSubagents) {
      if (state.isBackgrounded && state.agentId && !liveIds.has(state.agentId)) {
        // The level snapshot is authoritative for liveness but carries no
        // terminal outcome. Retain the identity until task_notification so
        // its summary/output can still be attributed; expose it as settled.
        state.isBackgrounded = false;
        if (state.status === "running" || state.status === "pending" || state.status === "paused") {
          state.status = "completed";
        }
      }
    }
    this._sdkBackgroundTasks = replacement;

    this.send({
      type: "background_tasks_changed",
      tasks: Array.from(replacement.values()).map((task) => ({
        taskId: task.taskId,
        taskType: task.taskType,
        description: task.description,
        ...(this._taskIdToToolUseId.get(task.taskId)
          ? { toolUseId: this._taskIdToToolUseId.get(task.taskId)! }
          : {}),
      })),
      sessionId: this.sessionId || "",
    });
    this._emitActiveSubagentsSnapshot();
    if (!this._isRunning && !this._hasClaudeBackgroundWork()) this._enterWarmIdle();
    this.onActivity?.();
  }

  private _resetSdkTaskTracking(
    status: "stopped" | "failed",
    summary: string,
    notify = true,
  ): void {
    this._settleWorkflowRuns(status, summary);
    const states = Array.from(this._activeSubagents.entries()).filter(([, state]) =>
      state.status === "pending" || state.status === "running" || state.status === "paused"
    );
    if (notify) {
      for (const [toolUseId, state] of states) {
        const taskId = state.agentId || toolUseId;
        this._persistTaskState({
          taskId,
          taskKind: "subagent",
          status,
          content: summary,
          taskDescription: state.description,
          originToolUseId: toolUseId,
          parentToolUseId: state.parentToolUseId || null,
          subagentType: state.subagentType || undefined,
          prompt: state.prompt,
          progressSummary: state.progressSummary,
          lastToolName: state.lastToolName,
          usage: state.usage,
          isBackgrounded: false,
        });
        this.send({
          type: "tool_result",
          toolUseId,
          output: summary,
          backgroundPending: false,
          parentToolUseId: state.parentToolUseId || null,
          sessionId: this.sessionId || "",
        });
        this.send({
          type: "task_notification",
          taskId,
          status,
          summary,
          originToolUseId: toolUseId,
          parentToolUseId: state.parentToolUseId || null,
          subagentType: state.subagentType || undefined,
          sessionId: this.sessionId || "",
        });
        if (this.sessionId) {
          appendHistory(this.sessionId, {
            role: "tool_result",
            content: "",
            toolUseId,
            toolOutput: summary,
            backgroundPending: false,
            parentToolUseId: state.parentToolUseId || null,
            timestamp: new Date().toISOString(),
          });
          appendHistory(this.sessionId, {
            role: "notification",
            content: summary,
            status,
            taskId,
            originToolUseId: toolUseId,
            parentToolUseId: state.parentToolUseId || null,
            subagentType: state.subagentType || undefined,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    for (const taskId of this._sdkTaskIds) {
      this._taskIdToToolUseId.delete(taskId);
    }
    this._sdkTaskIds.clear();
    this._sdkBackgroundTasks.clear();
    this._activeSubagents.clear();
    this._taskStatePersistedAt.clear();
    if (notify) {
      this.send({
        type: "background_tasks_changed",
        tasks: [],
        sessionId: this.sessionId || "",
      });
      this._emitActiveSubagentsSnapshot();
    }
    this.onActivity?.();
  }

  private _persistTaskState(state: {
    taskId: string;
    taskKind: "claude_task" | "subagent" | "workflow" | "background";
    status: string;
    content?: string;
    taskSubject?: string;
    taskDescription?: string;
    teammateName?: string;
    originToolUseId?: string;
    parentToolUseId?: string | null;
    taskType?: string;
    subagentType?: string;
    prompt?: string;
    progressSummary?: string;
    lastToolName?: string;
    usage?: ClaudeSubagentState["usage"];
    isBackgrounded?: boolean;
    skipTranscript?: boolean;
    workflowState?: WorkflowStatePayload;
  }, throttleMs = 0): void {
    if (!this.sessionId || !state.taskId) return;
    const persistenceKey = `${state.taskKind}:${state.taskId}`;
    const nowMs = Date.now();
    const previousMs = this._taskStatePersistedAt.get(persistenceKey) || 0;
    if (throttleMs > 0 && nowMs - previousMs < throttleMs) return;
    this._taskStatePersistedAt.set(persistenceKey, nowMs);
    appendHistory(this.sessionId, {
      role: "task_state",
      content: state.content || state.taskDescription || state.taskSubject || "",
      taskId: state.taskId,
      taskKind: state.taskKind,
      status: state.status,
      taskSubject: state.taskSubject,
      taskDescription: state.taskDescription,
      teammateName: state.teammateName,
      originToolUseId: state.originToolUseId,
      parentToolUseId: state.parentToolUseId,
      taskType: state.taskType,
      subagentType: state.subagentType,
      toolInput: state.prompt ? { prompt: state.prompt } : undefined,
      progressSummary: state.progressSummary,
      lastToolName: state.lastToolName,
      taskUsage: state.usage,
      isBackgrounded: state.isBackgrounded,
      skipTranscript: state.skipTranscript,
      workflowState: state.workflowState,
      timestamp: new Date(nowMs).toISOString(),
    });
    if (state.status === "completed"
      || state.status === "failed"
      || state.status === "stopped"
      || state.status === "deleted") {
      this._taskStatePersistedAt.delete(persistenceKey);
    }
  }

  private _publishClaudeTaskUpdate(update: ClaudeTaskStateUpdate): void {
    if (!this.sessionId) return;
    const current = getTodos(this.sessionId);
    const next = reduceClaudeTaskTodos(current, update);
    const task = next.find(
      (item) => item?.source === "claude_tasks"
        && String(item?.id ?? item?.taskId ?? "") === update.taskId,
    ) || current.find(
      (item) => item?.source === "claude_tasks"
        && String(item?.id ?? item?.taskId ?? "") === update.taskId,
    );
    this._persistTaskState({
      taskId: update.taskId,
      taskKind: "claude_task",
      status: update.status || task?.status || "pending",
      content: update.subject || task?.content || `Task #${update.taskId}`,
      taskSubject: update.subject || task?.content,
      taskDescription: update.description ?? task?.description,
      teammateName: update.teammateName ?? task?.teammateName,
      isBackgrounded: false,
    });
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      saveTodos(this.sessionId, next);
      this.send({
        type: "todos",
        todos: next,
        sessionId: this.sessionId,
      } as any);
    }
    this.onActivity?.();
  }

  private _publishClaudeTaskSnapshot(tasks: any[]): void {
    if (!this.sessionId) return;
    const current = getTodos(this.sessionId);
    const next = replaceClaudeTaskTodos(current, tasks);
    const nextNativeIds = new Set(
      next
        .filter((item) => item?.source === "claude_tasks")
        .map((item) => String(item?.id ?? item?.taskId ?? "")),
    );
    for (const previous of current.filter((item) => item?.source === "claude_tasks")) {
      const taskId = String(previous?.id ?? previous?.taskId ?? "");
      if (taskId && !nextNativeIds.has(taskId)) {
        this._persistTaskState({
          taskId,
          taskKind: "claude_task",
          status: "deleted",
          content: String(previous.content || `Task #${taskId}`),
          taskSubject: String(previous.content || "") || undefined,
          taskDescription: previous.description,
          teammateName: previous.teammateName,
          isBackgrounded: false,
        });
      }
    }
    for (const task of next.filter((item) => item?.source === "claude_tasks")) {
      const taskId = String(task?.id ?? task?.taskId ?? "");
      this._persistTaskState({
        taskId,
        taskKind: "claude_task",
        status: String(task.status || "pending"),
        content: String(task.content || `Task #${taskId}`),
        taskSubject: String(task.content || "") || undefined,
        taskDescription: task.description,
        teammateName: task.teammateName,
        isBackgrounded: false,
      });
    }
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      saveTodos(this.sessionId, next);
      this.send({
        type: "todos",
        todos: next,
        sessionId: this.sessionId,
      } as any);
    }
    this.onActivity?.();
  }

  private _streamLane(message: any): string {
    return String(message?.parent_tool_use_id || "") || "main";
  }

  private _streamKey(message: any): string {
    const lane = this._streamLane(message);
    const event = message?.type === "stream_event" ? message?.event : undefined;
    const apiMessageId = String(
      event?.type === "message_start"
        ? event?.message?.id || ""
        : message?.message?.id || "",
    );

    if (apiMessageId) this._activeSdkMessageIds.set(lane, apiMessageId);

    // The Agent SDK assigns a fresh outer UUID to every stream_event frame.
    // The API message id from message_start remains stable for all deltas and
    // for the completed assistant snapshot, so it is the card identity.
    const stableId = apiMessageId
      || this._activeSdkMessageIds.get(lane)
      || String(message?.uuid || "")
      || "current";
    return `${lane}:${stableId}`;
  }

  private _finishSdkMessageStream(message: any): void {
    this._activeSdkMessageIds.delete(this._streamLane(message));
  }

  private _appendLiveStream(
    streams: Map<string, { content: string; parentToolUseId?: string; uuid?: string; startedAtMs?: number }>,
    message: any,
    content: string,
  ): string {
    const key = this._streamKey(message);
    const parentToolUseId = String(message?.parent_tool_use_id || "") || undefined;
    const uuid = String(message?.uuid || "") || undefined;
    const existing = streams.get(key);
    streams.set(key, {
      content: (existing?.content || "") + content,
      startedAtMs: existing?.startedAtMs || Date.now(),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(uuid ? { uuid } : {}),
    });
    return key;
  }

  private _clearLiveStreamsForMessage(message: any): void {
    const key = this._streamKey(message);
    this._streamingText.delete(key);
    this._streamingThinking.delete(key);
  }

  /** Currently-executing tool call info (null if no tool is running) */
  getActiveToolCall(): { toolUseId: string; name: string } | null {
    if (this._activeToolUseId && this._activeToolName) {
      return { toolUseId: this._activeToolUseId, name: this._activeToolName };
    }
    return null;
  }

  /** Read accumulated bash output from the live log file (for replay on reconnect) */
  getAccumulatedBashOutput(): string | null {
    if (!this._activeBashStream) return null;
    try {
      if (!fs.existsSync(this._activeBashStream.filePath)) return null;
      const content = fs.readFileSync(this._activeBashStream.filePath, "utf8");
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  get lastPreview(): string {
    return this._lastPreview;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Swap the WebSocket so a reconnecting client receives future messages */
  setWebSocket(ws: WebSocket, deferLiveReplay = false): void {
    this.attachWebSocket(ws);
    // Re-send cached session init and models so app UI populates immediately
    if (this._lastSessionInit) this.sendTo(ws, this._lastSessionInit);
    if (this._lastSupportedModels) this.sendTo(ws, this._lastSupportedModels);
    if (this._lastSupportedCommands) this.sendTo(ws, this._lastSupportedCommands);
    if (this._lastSupportedAgents) this.sendTo(ws, this._lastSupportedAgents);
    if (!deferLiveReplay) {
      this.replayPendingInteractions(ws);
      this.sessionEventDelivery.replayTo((message) => {
        this.sendTo(ws, message as ServerMessage);
      });
    }
  }

  acknowledgeSessionEvent(deliveryId: string): boolean {
    return this.sessionEventDelivery.acknowledge(deliveryId);
  }

  replayLiveState(ws: WebSocket = this.ws): void {
    this.sessionEventDelivery.replayTo((message) => {
      this.sendTo(ws, message as ServerMessage);
    });
    const activeTool = this.getActiveToolCall();
    if (activeTool && !this.sessionEventDelivery.hasPending("tool_call", activeTool.toolUseId)) {
      this.sendTo(ws, {
        type: "tool_call",
        tool: activeTool.name,
        input: {},
        toolUseId: activeTool.toolUseId,
        sessionId: this.sessionId || "",
        replay: true,
      } as any);
    }
    for (const [streamId, stream] of this._streamingThinking) {
      if (!stream.content.trim()) continue;  // signature-only thinking, nothing to show
      this.sendTo(ws, {
        type: "thinking",
        content: stream.content,
        sessionId: this.sessionId || "",
        streamId,
        ...(stream.parentToolUseId ? { parentToolUseId: stream.parentToolUseId } : {}),
        ...(stream.uuid ? { uuid: stream.uuid } : {}),
        replay: true,
      });
    }
    for (const [streamId, stream] of this._streamingText) {
      this.sendTo(ws, {
        type: "text",
        content: stream.content,
        sessionId: this.sessionId || "",
        streamId,
        ...(stream.parentToolUseId ? { parentToolUseId: stream.parentToolUseId } : {}),
        ...(stream.uuid ? { uuid: stream.uuid } : {}),
        replay: true,
      });
    }
    // setWebSocket may run before session_history is delivered. Replay these
    // again afterward so a history replacement cannot hide an open card.
    this.replayPendingInteractions(ws);
  }

  private replayPendingInteractions(ws: WebSocket = this.ws): void {
    // Re-send any pending (unanswered) questions so the reconnecting client can respond
    for (const [, pending] of this.pendingQuestions) {
      if (pending.questionData) {
        this.sendTo(ws, pending.questionData);
      }
    }
    for (const pendingSecureInput of pendingSecureInputMessagesForSession(this.sessionId || "")) {
      this.sendTo(ws, pendingSecureInput as ServerMessage);
    }
    // Workflow snapshots are cumulative state, not append-only stream frames.
    // Re-send the latest snapshot after history restoration so a reconnect
    // immediately resumes the live phase/agent view.
    for (const run of this._workflowRuns.values()) {
      if (!run.lastSnapshot) continue;
      this.sendTo(ws, {
        type: "workflow_state",
        ...run.lastSnapshot,
        sessionId: this.sessionId || "",
        replay: true,
      } as ServerMessage);
    }
    // Send active subagent tasks so the app can render SubAgentCards
    const activeSubagents = this.getActiveSubagents();
    if (activeSubagents.length > 0) {
      console.log(`[Resume] Sending ${activeSubagents.length} active subagents`);
    }
    this.sendTo(ws, {
      type: "active_subagents",
      tasks: activeSubagents,
      sessionId: this.sessionId || "",
      backend: "claude",
      replace: true,
    } as ActiveSubagentsServerMessage);
  }

  /** Detach the WebSocket so this session stops sending to the client.
   *  The session continues running in the background (history is still logged). */
  detachWebSocket(): void {
    // Live output is session-scoped and the app filters by sessionId. Keep
    // attached sockets until they close so reconnects/probes don't steal the
    // stream from another visible client.
  }

  private attachWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this.clientSockets.add(ws);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(redactSecretsDeep(msg)));
    }
  }

  public send(msg: ServerMessage): void {
    positionSessionMessage(String((msg as any).sessionId || this.sessionId || ""), msg as any);
    maybeSendAgentAttentionPush(msg as any, path.basename(this.cwd) || "SocketAgent");
    const streamKey = this.coalescedStreamKey(msg);
    if (streamKey && (msg as any).snapshot === true && (msg as any).finalSnapshot !== true) {
      this.streamSnapshots.push(streamKey, msg);
      return;
    }
    if (streamKey && (msg as any).finalSnapshot === true) {
      this.streamSnapshots.discard(streamKey);
    } else if ((msg as any).type === "tool_call") {
      this.streamSnapshots.flushAll();
    }
    this.sendImmediately(msg);
  }

  private coalescedStreamKey(msg: ServerMessage): string | null {
    const type = String((msg as any).type || "");
    if (type !== "text" && type !== "thinking") return null;
    const identity = String((msg as any).entryId || (msg as any).streamId || "");
    return identity ? `${type}:${identity}` : null;
  }

  private sendImmediately(msg: ServerMessage): void {
    const deliveryAware = [...this.clientSockets].some(
      (socket) => (socket as any).supportsSessionEventAck === true,
    );
    const monitorDeliveryAware = this.clientSockets.size > 0 && [...this.clientSockets].every(
      (socket) => (socket as any).supportsMonitorOutputAck === true,
    );
    const shouldPrepare = deliveryAware
      && ((msg as any).type !== "monitor_output" || monitorDeliveryAware);
    const outgoing = shouldPrepare
      ? this.sessionEventDelivery.prepare(msg as any)
      : msg;
    this.dispatchToClients(outgoing as ServerMessage);
  }

  private sendSdkEvent(msg: ServerMessage): void {
    const recipients: WebSocket[] = [];
    for (const socket of [...this.clientSockets]) {
      if (socket.readyState === WebSocket.OPEN && (socket as any).supportsRawSdkEvents === true) {
        recipients.push(socket);
      } else if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        this.clientSockets.delete(socket);
      }
    }
    if (recipients.length === 0) return;
    const payload = JSON.stringify(redactSecretsDeep(msg));
    for (const socket of recipients) socket.send(payload);
  }

  private dispatchToClients(msg: ServerMessage): void {
    const payload = JSON.stringify(redactSecretsDeep(msg));
    for (const socket of [...this.clientSockets]) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        this.clientSockets.delete(socket);
      }
    }
  }

  getSessionContext(): SessionContext {
    const sid = this.sessionId || "";
    return {
      sessionId: sid,
      cwd: this.cwd,
      send: (msg) => this.send(msg as ServerMessage),
      appendHistory: (entry) => { if (sid) appendHistory(sid, entry); },
      pendingQuestions: this.pendingQuestions,
      questionCounter: { next: () => createInteractiveRequestId("q") },
    };
  }

  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingQuestions.delete(questionId);
      // Mark as answered in persisted history
      if (this.sessionId) {
        markQuestionAnswered(this.sessionId, questionId, answers);
      }
      return true;
    }
    return false;
  }

  async abort(): Promise<void> {
    this._stopRequested = true;
    this._pendingBoundaryContext = [];
    this.streamSnapshots.flushAll();
    this._leaveWarmIdle();
    this.abortController?.abort();
    this.activeInputQueue?.close();
    this.activeInputQueue = null;
    // close() forcefully terminates the CLI subprocess and all its children
    if (this.activeQuery) {
      try { this.activeQuery.close(); } catch {}
      this.activeQuery = null;
    }
    this._resetSdkTaskTracking("stopped", "Stopped by user");
    this._rejectPendingTurns(new Error("Claude session aborted"));
    this._isRunning = false;
    this._isCompacting = false;
    this._runStartedAt = null;
    this._compactStartedAt = null;
    // Kill both legacy task-tail monitors and durable Monitor-owned commands.
    await Promise.all([
      this._hardCleanupAllMonitors(),
      (this.sessionId || this._resumeSessionId)
        ? stopAppMonitorsForSession((this.sessionId || this._resumeSessionId)!)
        : Promise.resolve(0),
    ]);
    // Stop all background bash watchers
    for (const [taskId] of this._bgBashWatchers) {
      this._stopBgBashWatcher(taskId);
    }
  }

  closeWarmIdle(): void {
    if (!this._isWarmIdle) return;
    this.streamSnapshots.flushAll();
    this._leaveWarmIdle();
    this.activeInputQueue?.close();
    try { this.activeQuery?.close(); } catch {}
  }

  /** Gracefully stop the current query between turns — session stays alive and can continue */
  interrupt(): void {
    this._stopRequested = true;
    this._pendingBoundaryContext = [];
    if (this.activeQuery) {
      this.activeQuery.interrupt();
    }
  }

  /**
   * A tool call came back with Claude Code's cancellation sentinel instead of
   * running. If we asked for the stop that is expected. If we did not, the
   * backend aborted the turn on its own — the abort signal stays set, so every
   * remaining tool call this run is cancelled the same way while the model keeps
   * generating. The model reads the sentinel as a refusal from the user and
   * reports being blocked, which is not what happened, so say so explicitly.
   */
  private _reportCancelledTool(toolUseId: string, parentToolUseId: string | null): void {
    if (this._stopRequested) {
      console.log(`[Cancelled] Tool ${toolUseId} cancelled by requested stop`);
      return;
    }
    this._unexpectedCancellations++;
    console.warn(
      `[Cancelled] Tool ${toolUseId} was cancelled by the backend without a stop request `
      + `(#${this._unexpectedCancellations} this run). The turn's abort signal is set; `
      + `further tool calls will also be cancelled.`,
    );
    if (this._unexpectedCancellations !== 1) return;  // one card per run

    const summary =
      "Claude Code cancelled this tool call before running it. This was not a permission "
      + "denial and you did not stop anything — the backend aborted the turn. Remaining tool "
      + "calls this turn will be cancelled too, so send a new message to continue.";
    this.send({
      type: "task_notification",
      taskId: "",
      status: "cancelled",
      summary,
      originToolUseId: toolUseId,
      parentToolUseId: parentToolUseId || null,
      sessionId: this.sessionId || "",
    } as any);
    if (this.sessionId) {
      appendHistory(this.sessionId, {
        role: "notification",
        content: summary,
        status: "cancelled",
        originToolUseId: toolUseId,
        parentToolUseId: parentToolUseId || null,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Switch model mid-session. Pass undefined to reset to default. */
  async setModel(model?: string): Promise<void> {
    this._requestedModel = model ?? null;
    this._sessionModel = model ?? null;
    if (this.activeQuery) {
      await this.activeQuery.setModel(model);
      console.log(`[Model] Set to ${model || 'default'} for session ${this.sessionId || '(pending)'}`);
    }
    this.persistAgentSettings({ model });
  }

  private publishSupportedModels(
    models: Array<Record<string, unknown>>,
    options: { cached?: boolean; updatedAt?: string } = {},
  ): void {
    if (models.length === 0) return;
    const currentModel = this._requestedModel || this._sessionModel || undefined;
    const message = {
      type: "supported_models",
      models,
      ...(currentModel ? { currentModel } : {}),
      sessionId: this.sessionId || this._resumeSessionId || "",
      backend: "claude",
      ...options,
    } as ServerMessage;
    this._lastSupportedModels = message;
    this.send(message);
  }

  async refreshSupportedModels(force = false): Promise<void> {
    const cached = getCachedModelCatalog("claude");
    if (cached) {
      this.publishSupportedModels(cached.models, {
        cached: true,
        updatedAt: cached.updatedAt,
      });
      if (!force && modelCatalogIsFresh(cached)) return;
    }
    try {
      const models = await discoverClaudeSupportedModels(this.cwd);
      if (models.length === 0) return;
      const saved = saveCachedModelCatalog("claude", models);
      this.publishSupportedModels(saved.models, { updatedAt: saved.updatedAt });
    } catch (err: any) {
      console.warn(`[ClaudeModels] Failed to discover models before a turn: ${err?.message || err}`);
    }
  }

  getAgentSettings(): AgentSessionSettings {
    return {
      ...(this._requestedModel || this._sessionModel ? { model: this._requestedModel || this._sessionModel || undefined } : {}),
      effort: this._effort,
      thinking: this._thinking,
      claudeAutoCompact: this._autoCompactEnabled,
      ...(this._autoCompactWindowOverride !== undefined
        ? { claudeAutoCompactWindow: this._autoCompactWindowOverride }
        : {}),
      disallowedTools: [...this._disallowedTools],
      ...(this._systemPromptOverride !== undefined ? { systemPrompt: this._systemPromptOverride } : {}),
    };
  }

  private persistAgentSettings(patch: Partial<AgentSessionSettings>): void {
    const sid = this.sessionId;
    if (sid) updateSessionAgentSettings(sid, patch);
  }

  /** Switch permission mode mid-session (e.g., 'plan', 'default', 'acceptEdits'). */
  async setPermissionMode(mode: string): Promise<void> {
    this._permissionMode = mode;
    this.persistPermissionMode(mode);
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(mode as any);
      console.log(`[PermissionMode] Set to ${mode} for session ${this.sessionId || '(pending)'}`);
    }
  }

  private persistPermissionMode(mode: string): void {
    if (!this.sessionId) return;
    const session = getSession(this.sessionId);
    if (session) {
      session.permissionMode = mode;
      saveSession(session);
    }
    appendHistory(this.sessionId, {
      role: "permission_mode",
      content: "",
      permissionMode: mode,
      timestamp: new Date().toISOString(),
    });
  }

  /** Get MCP server health status */
  async mcpServerStatus(): Promise<any> {
    if (this.activeQuery) {
      return this.activeQuery.mcpServerStatus();
    }
    return null;
  }

  /** Reconnect a failed MCP server */
  async reconnectMcpServer(name: string): Promise<any> {
    if (this.activeQuery) {
      return (this.activeQuery as any).reconnectMcpServer(name);
    }
    return null;
  }

  /** Toggle an MCP server on/off */
  async toggleMcpServer(name: string, enabled: boolean): Promise<any> {
    if (this.activeQuery) {
      return (this.activeQuery as any).toggleMcpServer(name, enabled);
    }
    return null;
  }

  /** Rewind files to a specific message UUID (requires file checkpointing) */
  async rewindFiles(uuid: string, dryRun = false): Promise<any> {
    if (this.activeQuery) {
      return this.activeQuery.rewindFiles(uuid, { dryRun });
    }
    return null;
  }

  /**
   * Inject a user message into the running conversation.
   *
   *  'now'   - priority 'now'. The backend aborts the running tool to deliver it.
   *  'next'  - held by SocketAgent until PostToolBatch, whose additionalContext
   *            is inserted after every tool in the batch resolves and before the
   *            next model request. If the turn ends first, the message starts a
   *            seamless follow-up turn. We deliberately do not call streamInput
   *            while Claude is generating: even shouldQuery:false can hit the
   *            SDK's cancellation path at that timing.
   *  'later' - priority 'later'. The backend holds it until the whole task ends.
   */
  async injectMessage(text: string, priority: 'now' | 'next' | 'later' = 'next', messageId?: string): Promise<void> {
    if (!this.activeQuery || !this._isRunning) return;
    const atNextBoundary = priority === 'next';
    console.log(
      `[Inject] Queuing message (${atNextBoundary ? 'SocketAgent boundary queue' : `priority=${priority}`}):`
      + ` ${text.slice(0, 80)}...`,
    );

    const sessionId = this.sessionId || "";
    // Stable caller IDs let durable external events (such as a completed Work
    // Review) reuse one transcript/backend identity when delivery is replayed.
    const userMsgUuid = messageId || crypto.randomUUID();

    // Log injected message to history so it persists across sessions
    if (sessionId) {
      const historyEntry = appendHistory(sessionId, {
        role: "user",
        content: text,
        uuid: userMsgUuid,
        timestamp: new Date().toISOString(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userMsgUuid,
        sessionId,
        entryId: historyEntry.entryId,
        sessionSeq: historyEntry.sessionSeq,
        revision: historyEntry.revision,
        ...(messageId ? { clientMessageId: messageId } : {}),
      } as any);
    }

    if (atNextBoundary) {
      this._pendingBoundaryContext.push({ text, uuid: userMsgUuid });
      console.log(`[Inject] Message retained for the next safe boundary`);
      return;
    }

    const userMessage = this._createUserMessage(
      text,
      sessionId,
      userMsgUuid,
      priority,
    );
    const singleMessageStream = async function* () {
      yield userMessage;
    };

    try {
      await this.activeQuery.streamInput(singleMessageStream() as any);
      console.log(`[Inject] Message injected successfully`);
    } catch (e) {
      console.error(`[Inject] streamInput error: ${e}`);
    }
  }

  private async _runWarmPrompt(
    prompt: string,
    resumeSessionId?: string,
    messageId?: string,
  ): Promise<void> {
    if (!this.activeQuery || !this.activeInputQueue) {
      throw new Error("Claude warm session is not available");
    }
    this._leaveWarmIdle();
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this._authErrorSent = false;
    this._streamingText.clear();
    this._streamingThinking.clear();
    this._thinkingProgress = null;
    this._lastPreview = "";
    this.onActivity?.();

    const sid = resumeSessionId || this.sessionId || "";
    const userMsgUuid = messageId || crypto.randomUUID();
    const turnPromise = this._trackPendingTurn();

    if (sid) {
      const historyEntry = appendHistory(sid, {
        role: "user",
        content: prompt,
        uuid: userMsgUuid,
        timestamp: new Date().toISOString(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userMsgUuid,
        sessionId: sid,
        entryId: historyEntry.entryId,
        sessionSeq: historyEntry.sessionSeq,
        revision: historyEntry.revision,
        ...(messageId ? { clientMessageId: messageId } : {}),
      } as any);
    }

    this.activeInputQueue.push(this._createUserMessage(prompt, sid, userMsgUuid));
    console.log(`[WarmIdle] Reusing Claude SDK stream for ${sid || "(pending)"}, prompt=${prompt.slice(0, 80)}...`);
    return turnPromise;
  }

  async runQuery(
    prompt: string,
    resumeSessionId?: string,
    messageId?: string,
  ): Promise<void> {
    // The SDK stream also remains reusable while a completed root turn waits
    // for background work. A new phone prompt must join that process rather
    // than replacing activeQuery and orphaning its task lifecycle events.
    if (this.activeQuery && this.activeInputQueue && !this._isRunning) {
      return this._runWarmPrompt(prompt, resumeSessionId, messageId);
    }

    if (this._activeSubagents.size > 0 || this._sdkBackgroundTasks.size > 0) {
      this._resetSdkTaskTracking("failed", "Previous Claude SDK process ended", false);
    }
    this.abortController = new AbortController();
    this._stopRequested = false;
    this._unexpectedCancellations = 0;
    this._lastThinkingTokensSentAt = 0;
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this._isWarmIdle = false;
    this._clearWarmIdleTimer();
    this._authErrorSent = false;
    this._streamingText.clear();
    this._streamingThinking.clear();
    this._thinkingProgress = null;
    this._lastPreview = "";
    this.onActivity?.();

    try {
      // Strip CLAUDECODE env var to allow running inside a Claude Code session
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "CLAUDECODE" && v !== undefined) {
          cleanEnv[k] = v;
        }
      }
      // Inject session ID for tools that need to reach the app
      const sid = resumeSessionId || this.sessionId || "";
      if (sid) cleanEnv["CLAUDE_SESSION_ID"] = sid;
      // Enable file checkpointing for rewind support
      cleanEnv["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"] = "1";
      // Give MCP tool results more time to propagate before stream closes
      cleanEnv["CLAUDE_CODE_STREAM_CLOSE_TIMEOUT"] = "10000";
      // Force-enable prompt suggestions
      cleanEnv["CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"] = "1";
      // Enable fine-grained tool output streaming (streams bash output incrementally)
      cleanEnv["CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"] = "1";
      // Enable bash_progress events in tool_progress (SDK only emits in remote/container mode)
      cleanEnv["CLAUDE_CODE_CONTAINER_ID"] = "socketagent";
      // Enable session state change events (idle/running/requires_action)
      cleanEnv["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"] = "1";

      // Merge plugin environment variables
      for (const plugin of this.plugins) {
        if (plugin.envVars) {
          Object.assign(cleanEnv, plugin.envVars());
        }
      }

      const appToolContext: AppToolContext = {
        getSessionId: () => this.sessionId || "",
        getDelegationSupervisorSessionId: () =>
          String(
            (this as any)._delegationSupervisorSessionId ||
              getSession(this.sessionId || "")?.delegationSupervisorSessionId ||
              this.sessionId ||
              "",
          ),
        getCwd: () => this.cwd,
        getBackend: () => "claude",
        send: (msg) => this.send(msg as ServerMessage),
        appendHistory: (entry) => {
          if (this.sessionId) return appendHistory(this.sessionId, entry as HistoryEntry);
        },
        getTtsEngine: () => this._ttsEngine,
        getKokoroVoice: () => this._kokoroVoice,
        getKokoroSpeed: () => this._kokoroSpeed,
        isRunning: () => this._isRunning,
        injectMessage: (text, priority) => this.injectMessage(text, priority),
        onMonitorOutput: (text) => this.onMonitorOutput?.(text),
        manageAgentSession: (args) => {
          if (!this.onAgentSessionRequest) {
            throw new Error("AgentSession runtime is not attached");
          }
          return this.onAgentSessionRequest(args);
        },
      };

      // Build the MCP server with app-facing tools.
      const appTools = createSdkMcpServer({
        name: "app",
        tools: [
          tool(
            "HtmlPlan",
            HTML_PLAN_TOOL_DESCRIPTION,
            {
              title: z.string().describe("Short descriptive plan title"),
              html: z.string().describe("Complete polished HTML document for the detailed implementation/design plan. SocketAgent preserves and displays this value exactly. Inline assets and HTTPS resources are supported; viewer JavaScript is disabled."),
              plan_id: z.string().optional().describe("Existing plan ID to update. Omit when creating a new plan."),
            },
            async (args) => handleHtmlPlanTool(appToolContext, args)
          ),
          tool(
            "WorkReview",
            WORK_REVIEW_TOOL_DESCRIPTION,
            {
              action: z.enum(["create", "get", "list", "export", "new_round", "archive"]),
              review_id: z.string().optional().describe("Required for get, new_round, and archive"),
              idempotency_key: z.string().optional().describe("Stable caller-generated key required for create and new_round; reuse it when retrying"),
              title: z.string().optional().describe("Required for create and new_round"),
              purpose: z.string().optional().describe("Optional workflow purpose, such as pre-deployment, QA, design review, audit, or informational"),
              summary: z.string().optional().describe("Concise description of the work completed"),
              instructions: z.string().optional().describe("Instructions applying to the whole review"),
              approval_meaning: z.string().optional().describe("What approval authorizes or confirms, including deployment authorization when applicable"),
              linked_html_plan_id: z.string().optional().describe("Same-session HtmlPlan ID to display once for html_plan item targets"),
              items: z.array(z.object({
                item_id: z.string().optional().describe("Stable item ID; omit to generate one"),
                title: z.string(),
                description: z.string().optional(),
                instructions: z.string().optional().describe("What the reviewer should inspect or verify"),
                primary_target: z.object({
                  kind: z.enum(["url", "file", "image", "html", "html_plan", "diff", "session", "custom"]),
                  uri: z.string().describe("Address or identifier the reviewer opens or inspects"),
                  label: z.string().optional(),
                  environment: z.string().optional().describe("For example production, development, sandbox, or local"),
                  displayMode: z.enum(["auto", "embedded"]).optional().describe(
                    "Primary HTTP(S) targets are embedded beneath the review panel. Use auto or embedded.",
                  ),
                  description: z.string().optional(),
                }),
                supporting_targets: z.array(z.object({
                  kind: z.enum(["url", "file", "image", "html", "html_plan", "diff", "session", "custom"]),
                  uri: z.string(),
                  label: z.string().optional(),
                  environment: z.string().optional(),
                  displayMode: z.enum(["auto", "embedded", "external"]).optional(),
                  description: z.string().optional(),
                })).optional(),
              })).optional().describe("Required non-empty list for create and new_round"),
              include_archived: z.boolean().optional().describe("Include archived reviews for list/export"),
            },
            async (args) => handleWorkReviewTool(appToolContext, args as any)
          ),
          tool(
            "BrowserSession",
            "Open and control a persistent isolated browser profile. Normal HTTP and HTTPS redirects are allowed across domains. Use snapshots, refs, and clipboard actions only for non-sensitive interaction. Never type or read passwords, recovery codes, tokens, MFA values, or other credentials with this tool; ask the user to enter them in the protected phone browser. Device-bound passkeys may require the site's alternate sign-in method. Use clear only when the user explicitly asks to delete a saved browser profile.",
            {
              action: z.enum(["open", "list", "status", "snapshot", "navigate", "click", "type", "key", "scroll", "clipboard_read", "clipboard_write", "close", "clear"]),
              profile: z.string().optional().describe("Stable isolated profile name, for example google-play-william"),
              url: z.string().optional().describe("HTTP or HTTPS URL for open or navigate"),
              label: z.string().optional().describe("User-facing profile label used when opening"),
              ref: z.string().optional().describe("Element ref returned by snapshot"),
              text: z.string().optional().describe("Non-sensitive text to enter or write to the browser clipboard. Never pass a secret here."),
              key: z.string().optional().describe("Enter, Tab, Backspace, Escape, or Ctrl+A"),
              delta_y: z.number().optional().describe("Vertical scroll distance in CSS pixels"),
            },
            async (args) => handleBrowserSessionTool(appToolContext, args)
          ),
          tool(
            "Speak",
            "Speak text aloud to the user via text-to-speech. Use this to provide a concise spoken summary of your response. Keep it natural and conversational — no markdown, no code, no formatting. Summarize rather than reading everything verbatim. Only call this once per response. Avoid starting with a very short sentence — lead with a substantial opening sentence so audio playback begins with meaningful content.",
            { text: z.string().describe("The text to speak aloud to the user") },
            async (args) => handleSpeakTool(appToolContext, args)
          ),
          tool(
            "SendFile",
            "Send a file to the user's mobile device for download. Registers the file so the user can download it on-demand from the app. Use this when the user asks you to send, share, or transfer a file to their phone. NOTE: If this tool returns 'Stream closed' or similar transport error, the file was ALREADY sent successfully — do NOT retry.",
            {
              file_path: z.string().describe("Absolute path to the file to send"),
            },
            async (args) => handleSendFileTool(appToolContext, args)
          ),
          tool(
            "RequestSecureInput",
            "Ask the user to enter a credential, API key, token, or other secret through a secure app card. The secret is saved to a local 0600 file on the server, and this tool returns only the file path and metadata. Use this instead of asking the user to paste secrets into chat.",
            {
              label: z.string().describe("Short label for the secret, e.g. OPENAI_API_KEY or GitHub token"),
              reason: z.string().optional().describe("Why you need this secret, shown to the user"),
              envHint: z.string().optional().describe("Suggested environment variable name"),
              scope: z.enum(["session", "project", "global"]).optional().describe("Where to store it. Default: session"),
              timeoutSeconds: z.number().optional().describe("How long to wait for the user, 30-3600 seconds. Default: 600"),
            },
            async (args) => handleRequestSecureInputTool(appToolContext, args as any)
          ),
          tool(
            "ScheduleReminder",
            "Schedule a reminder notification on the user's mobile device. The notification will fire at the specified time even if the app is backgrounded. Use this when the user asks to be reminded about something at a specific time.",
            {
              title: z.string().describe("Short title for the reminder notification"),
              body: z.string().describe("Optional longer description for the notification body. Use empty string if not needed."),
              scheduledTime: z.string().describe("When to fire the reminder, in ISO 8601 format (e.g. 2026-02-18T15:30:00)"),
            },
            async (args) => handleScheduleReminderTool(appToolContext, args)
          ),
          tool(
            "NotifyUser",
            "Send an immediate notification to the user's mobile device. Use this when the user needs to know about an important result, especially from quiet scheduled tasks. Do not use for routine success messages unless the user explicitly asked to be notified.",
            {
              title: z.string().describe("Short notification title"),
              body: z.string().describe("Optional notification body. Use empty string if not needed."),
            },
            async (args) => handleNotifyUserTool(appToolContext, args)
          ),
          tool(
            "ScheduleTask",
            "Schedule a Claude or Codex prompt to run automatically at a future time. Creates a new session in the specified directory and executes the prompt when the scheduled time arrives. The server runs 24/7 so the task will execute even if the app is closed. Use this when the user wants to defer a task to run later. Supports provider, model, effort, permission, recurrence, and session-reuse settings.",
            {
              name: z.string().optional().describe("Short human-readable label for the task, used in task lists and notifications"),
              prompt: z.string().describe("The prompt/instructions for Claude to execute at the scheduled time"),
              cwd: z.string().describe("Working directory for the scheduled task (absolute path)"),
              backend: z.enum(["claude", "codex"]).optional().describe("Agent provider. Defaults to Claude."),
              model: z.string().optional().describe("Provider model ID. Omit to use the provider default."),
              effort: z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional().describe("Reasoning effort for the scheduled run."),
              permissionMode: z.enum(["plan", "default", "auto", "acceptEdits", "bypassPermissions", "superYolo"]).optional().describe("Sandbox/permission mode for the scheduled run."),
              scheduledTime: z.string().describe("When to run the task, in ISO 8601 format (e.g. 2026-03-13T09:00:00)"),
              recurrenceType: z.enum(["once", "daily", "weekly", "monthly", "custom"]).optional().describe("How often to repeat. Default: once (no recurrence)"),
              customIntervalMs: z.number().optional().describe("Custom interval in milliseconds (only used when recurrenceType is 'custom')"),
              reuseSession: z.boolean().optional().describe("If true and recurring, start each occurrence in a fresh session with summaries from the two most recent runs"),
              notificationMode: z.enum(["completion", "quiet"]).optional().describe("completion sends the normal completion notification. quiet sends no automatic notifications; the scheduled agent must call NotifyUser if the user should be alerted."),
            },
            async (args) => {
              const scheduledDate = new Date(args.scheduledTime);
              if (isNaN(scheduledDate.getTime())) {
                return { content: [{ type: "text" as const, text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
              }
              if (scheduledDate.getTime() <= Date.now()) {
                return { content: [{ type: "text" as const, text: `Scheduled time is in the past. Please provide a future time.` }] };
              }

              const recurrenceType = args.recurrenceType || "once";
              const recurrence: RecurrenceConfig | undefined = recurrenceType !== "once" ? {
                type: recurrenceType,
                intervalMs: recurrenceType === "custom" ? args.customIntervalMs : undefined,
              } : undefined;

              const backend = (args.backend || "claude") as Backend;
              const task: ScheduledTask = {
                id: crypto.randomUUID(),
                ...(args.name?.trim() ? { name: args.name.trim() } : {}),
                prompt: args.prompt,
                cwd: args.cwd,
                backend,
                ...(backend === "codex" ? { codexDriver: "app-server" as const } : {}),
                ...(args.model?.trim() ? { model: args.model.trim() } : {}),
                ...(args.effort ? { effort: args.effort } : {}),
                ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
                scheduledTime: args.scheduledTime,
                createdAt: new Date().toISOString(),
                status: "pending",
                createdBySessionId:
                  appToolContext.getDelegationSupervisorSessionId?.() ||
                  this.sessionId ||
                  undefined,
                recurrence,
                reuseSession: args.reuseSession || false,
                notificationMode: args.notificationMode === "quiet" ? "quiet" : "completion",
                runCount: 0,
                runs: [],
              };
              saveScheduledTask(task);

              // Notify the app about the new task
              this.send({
                type: "scheduled_task_update",
                task,
              } as any);

              const when = scheduledDate.toLocaleString();
              const recurrenceLabel = recurrence ? ` (recurring: ${recurrence.type})` : "";
              const notificationLabel = task.notificationMode === "quiet" ? " Quiet mode is on." : "";
              const label = task.name ? `"${task.name}"` : "Task";
              return { content: [{ type: "text" as const, text: `${label} scheduled for ${when}${recurrenceLabel} in ${args.cwd}.${notificationLabel}\n"${args.prompt.slice(0, 300)}"` }] };
            }
          ),
          tool(
            "TaskBatch",
            "Manage SocketAgent session working tasks in bulk. Use one call for two or more task changes instead of repeatedly calling TaskCreate or TaskUpdate. Modes: replace the managed task set, upsert several tasks, delete several IDs, clear completed tasks, or list the managed set. Native Claude tasks remain untouched.",
            {
              mode: z.enum(["replace", "upsert", "delete", "clear_completed", "list"]).describe("Bulk operation to perform"),
              tasks: z.array(z.object({
                task_id: z.string().optional().describe("Existing SocketAgent task ID for updates; omit when creating"),
                subject: z.string().optional().describe("Short imperative task title; required when creating"),
                description: z.string().optional().describe("Detailed task description"),
                active_form: z.string().optional().describe("Present-continuous label shown while in progress"),
                status: z.enum(["pending", "in_progress", "completed"]).optional(),
                owner: z.string().optional(),
                blocked_by: z.array(z.string()).optional(),
                blocks: z.array(z.string()).optional(),
              })).max(200).optional().describe("Tasks for replace or upsert"),
              task_ids: z.array(z.string()).max(200).optional().describe("Task IDs for delete"),
            },
            async (args) => handleTaskBatchTool(appToolContext, args as any)
          ),
          tool(
            "AgentSession",
            AGENT_SESSION_TOOL_DESCRIPTION,
            {
              action: z.enum(["start", "message", "status", "tail", "list", "stop"]).describe("start a child; message an existing child; optionally inspect status or interim activity; list children; or stop one. Completion is delivered automatically; do not poll merely to wait"),
              prompt: z.string().optional().describe("Required for start and message. A message to a running child is queued at its next safe boundary."),
              session_id: z.string().optional().describe("Child session ID returned by start; required for message/status/tail/stop unless delegation_id is used"),
              delegation_id: z.string().optional().describe("Stable delegation ID returned by start; alternative to session_id"),
              after_session_seq: z.number().int().nonnegative().optional().describe("For tail, return durable activity after this cursor. Omit for the newest page."),
              limit: z.number().int().min(1).max(50).optional().describe("For tail, maximum durable activity entries to return. Default 20."),
              backend: z.enum(["claude", "codex"]).optional().describe("Backend for start. Defaults to the supervising agent's backend."),
              cwd: z.string().optional().describe("Absolute working directory for start. Defaults to the supervisor's directory."),
              label: z.string().optional().describe("Short human-readable label for the delegated work"),
              model: z.string().optional().describe("Optional provider model ID for start"),
              effort: z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional().describe("Optional reasoning effort for start"),
              permissionMode: z.enum(["plan", "default", "auto", "acceptEdits", "bypassPermissions", "superYolo"]).optional().describe("Optional child permission mode"),
            },
            async (args) => handleAgentSessionTool(appToolContext, args as any)
          ),
          tool(
            "Remember",
            REMEMBER_TOOL_DESCRIPTION,
            {
              action: z.enum(["search", "list", "get", "context", "runs"]),
              query: z.string().optional().describe("Keyword or phrase for search"),
              session_seq: z.number().int().positive().optional().describe("Stable sequence returned by search/runs; required for context or usable for get"),
              entry_id: z.string().optional().describe("Stable entry ID returned by search; alternative selector for get"),
              before: z.number().int().min(0).max(20).optional().describe("Context entries before session_seq. Default 3"),
              after: z.number().int().min(0).max(20).optional().describe("Context entries after session_seq. Default 3"),
              direction: z.enum(["before", "after"]).optional().describe("For list, page before or after session_seq. Default before; omit session_seq for the latest page"),
              roles: z.array(z.enum(["user", "assistant", "tool_call", "tool_result", "thinking", "task_state", "run_boundary", "monitor", "question", "secure_input", "work_review", "html_plan"])).optional().describe("Search role filters. Defaults to user and assistant"),
              tool_name: z.string().optional().describe("Search only calls/results for this tool name"),
              since: z.string().optional().describe("Optional ISO timestamp lower bound for search"),
              until: z.string().optional().describe("Optional ISO timestamp upper bound for search"),
              limit: z.number().int().min(1).max(50).optional().describe("Search result or run count. Default 10"),
              offset: z.number().int().nonnegative().optional().describe("Search pagination offset"),
              max_chars: z.number().int().min(2000).max(200000).optional().describe("Maximum returned text size. Default 60000"),
            },
            async (args) => handleRememberTool(appToolContext, args as any)
          ),
          tool(
            "Monitor",
            "Monitor background process output. Two modes:\n1. Start a NEW background process with monitoring: provide command + description.\n2. Toggle monitoring on/off for an EXISTING background task: provide taskId.\nWhen monitoring is on, process output is debounced (5s batching) and delivered to you automatically so you can react. Timeout stops monitoring only — the process keeps running. To stop the process itself, use the existing task stop mechanism.",
            {
              command: z.string().optional().describe("Shell command to run in background with monitoring enabled (spawn mode)"),
              description: z.string().optional().describe("Human-readable description of what this process does"),
              timeoutSeconds: z.number().optional().describe("Auto-stop monitoring after N seconds (process keeps running)"),
              taskId: z.string().optional().describe("Existing background task ID to toggle monitoring for (toggle mode)"),
              enabled: z.boolean().optional().describe("Enable (true) or disable (false) monitoring. Default: true"),
            },
            async (args) => {
              // Monitor-owned commands run in the durable worker. Existing
              // background task IDs keep the legacy output-file tailer.
              if (args.command || args.taskId?.startsWith("monitor-")) {
                return handleMonitorTool(appToolContext, args);
              }
              try {
                const isSpawn = !!args.command;
                const isToggle = !!args.taskId && !args.command;

                if (!isSpawn && !isToggle) {
                  return { content: [{ type: "text" as const, text: "Monitor requires either 'command' (spawn mode) or 'taskId' (toggle mode)." }], isError: true };
                }

                if (isToggle) {
                  // ── Toggle mode: enable/disable monitoring on an existing background task ──
                  const taskId = args.taskId!;
                  const enabled = args.enabled !== false;

                  if (!enabled) {
                    if (this._monitoredTasks.has(taskId)) {
                      this._cleanupMonitor(taskId, true);
                      return { content: [{ type: "text" as const, text: `Monitoring disabled for task ${taskId}. Process continues running.` }] };
                    }
                    return { content: [{ type: "text" as const, text: `Task ${taskId} is not being monitored.` }] };
                  }

                  if (this._monitoredTasks.has(taskId)) {
                    return { content: [{ type: "text" as const, text: `Already monitoring task ${taskId}.` }] };
                  }

                  // Look up the output file for this task
                  const outputFile = this._taskOutputFiles.get(taskId);
                  if (!outputFile) {
                    // Also check by toolUseId (app sends toolUseId, SDK uses taskId)
                    let foundTaskId: string | undefined;
                    for (const [tid, tuid] of this._taskIdToToolUseId.entries()) {
                      if (tuid === taskId) { foundTaskId = tid; break; }
                    }
                    if (foundTaskId && this._taskOutputFiles.has(foundTaskId)) {
                      // Re-call with the correct SDK taskId
                      const realOutputFile = this._taskOutputFiles.get(foundTaskId)!;
                      const desc = args.description || `Task ${foundTaskId}`;
                      const monitorState: MonitorState = {
                        monitoring: true,
                        description: desc,
                        outputFile: realOutputFile,
                        lastSize: 0,
                        readerInterval: null,
                        debounceTimer: null,
                        outputBuffer: [],
                        timeoutTimer: null,
                        timeoutSeconds: args.timeoutSeconds || null,
                      };
                      this._monitoredTasks.set(foundTaskId, monitorState);
                      this._startMonitorReader(foundTaskId);
                      if (args.timeoutSeconds) {
                        monitorState.timeoutTimer = setTimeout(() => {
                          console.log(`[Monitor] Timeout reached for ${foundTaskId}`);
                          this._cleanupMonitor(foundTaskId!, true);
                        }, args.timeoutSeconds * 1000);
                      }
                      this.send({ type: "monitor_started", taskId: foundTaskId, description: desc, monitoring: true, sessionId: this.sessionId || "" } as any);
                      return { content: [{ type: "text" as const, text: `Monitoring enabled for task ${foundTaskId}.${args.timeoutSeconds ? ` Timeout: ${args.timeoutSeconds}s.` : ""}` }] };
                    }
                    return { content: [{ type: "text" as const, text: `No output file found for task ${taskId}. The task may not be a backgrounded bash command, or it may have already completed.` }], isError: true };
                  }

                  const desc = args.description || `Task ${taskId}`;
                  const monitorState: MonitorState = {
                    monitoring: true,
                    description: desc,
                    outputFile,
                    lastSize: 0,
                    readerInterval: null,
                    debounceTimer: null,
                    outputBuffer: [],
                    timeoutTimer: null,
                    timeoutSeconds: args.timeoutSeconds || null,
                  };
                  this._monitoredTasks.set(taskId, monitorState);
                  this._startMonitorReader(taskId);
                  if (args.timeoutSeconds) {
                    monitorState.timeoutTimer = setTimeout(() => {
                      console.log(`[Monitor] Timeout reached for ${taskId}`);
                      this._cleanupMonitor(taskId, true);
                    }, args.timeoutSeconds * 1000);
                  }
                  this.send({ type: "monitor_started", taskId, description: desc, monitoring: true, sessionId: this.sessionId || "" } as any);
                  return { content: [{ type: "text" as const, text: `Monitoring enabled for task ${taskId}.${args.timeoutSeconds ? ` Timeout: ${args.timeoutSeconds}s.` : ""}` }] };
                }

                // ── Spawn mode: start a new background process with monitoring ──
                const command = args.command!;
                const description = args.description || command.slice(0, 60);
                const taskId = `monitor-${crypto.randomUUID().slice(0, 8)}`;
                const outputFile = `/tmp/claude-monitor-${taskId}.log`;
                const syntheticToolUseId = `monitor-${taskId}`;

                console.log(`[Monitor] Spawning: ${command} → ${outputFile}`);

                // Create output file and spawn process
                const fd = fs.openSync(outputFile, "w");
                const child = spawn(command, [], {
                  shell: true,
                  detached: true,
                  stdio: ["ignore", fd, fd],
                  cwd: this.cwd,
                  windowsHide: true,
                });
                child.unref();
                fs.closeSync(fd);

                // Register in task tracking so it appears in the task pane
                this._taskIdToToolUseId.set(taskId, syntheticToolUseId);
                this._taskOutputFiles.set(taskId, outputFile);

                // Create monitor state
                const monitorState: MonitorState = {
                  monitoring: true,
                  description,
                  outputFile,
                  lastSize: 0,
                  readerInterval: null,
                  debounceTimer: null,
                  outputBuffer: [],
                  timeoutTimer: null,
                  timeoutSeconds: args.timeoutSeconds || null,
                  process: child,
                };
                this._monitoredTasks.set(taskId, monitorState);
                this._startMonitorReader(taskId);

                // Set timeout if specified
                if (args.timeoutSeconds) {
                  monitorState.timeoutTimer = setTimeout(() => {
                    console.log(`[Monitor] Timeout reached for ${taskId}`);
                    this._cleanupMonitor(taskId, true);
                  }, args.timeoutSeconds * 1000);
                }

                // Notify app about the new task + monitoring state
                this.send({ type: "task_started", taskId, toolUseId: syntheticToolUseId, description, taskType: "monitor", sessionId: this.sessionId || "" } as any);
                this.send({ type: "monitor_started", taskId, description, monitoring: true, command, sessionId: this.sessionId || "" } as any);

                // Listen for process exit
                child.on("exit", (code, signal) => {
                  console.log(`[Monitor] Process ${taskId} exited: code=${code} signal=${signal}`);
                  const state = this._monitoredTasks.get(taskId);
                  if (state) {
                    // Stop reader and flush remaining output
                    this._stopMonitorReader(taskId);
                    // Read any remaining output from file
                    try {
                      if (fs.existsSync(outputFile)) {
                        const stat = fs.statSync(outputFile);
                        if (stat.size > state.lastSize) {
                          const fd2 = fs.openSync(outputFile, "r");
                          const buf = Buffer.alloc(stat.size - state.lastSize);
                          fs.readSync(fd2, buf, 0, buf.length, state.lastSize);
                          fs.closeSync(fd2);
                          const remaining = buf.toString("utf8").split("\n").filter(l => l.length > 0);
                          if (remaining.length > 0) state.outputBuffer.push(...remaining);
                        }
                      }
                    } catch {}

                    // Flush buffer + send final exit message
                    if (state.outputBuffer.length > 0) {
                      this._flushMonitorBuffer(taskId);
                    }

                    const exitMsg = `[Monitor: "${description}" (${taskId})] Process exited with code ${code ?? "unknown"} (signal: ${signal || "none"})`;
                    if (this._isRunning && this.activeQuery) {
                      this.injectMessage(exitMsg, 'next').catch(() => {});
                    } else if (this.onMonitorOutput) {
                      this.onMonitorOutput(exitMsg);
                    }

                    // Clean up (don't flush again)
                    this._cleanupMonitor(taskId, false);
                  }

                  // Clean up task tracking
                  this._taskIdToToolUseId.delete(taskId);
                  this._taskOutputFiles.delete(taskId);

                  // Notify app task completed
                  this.send({
                    type: "task_notification",
                    taskId,
                    status: code === 0 ? "completed" : "failed",
                    summary: `Process exited with code ${code ?? "unknown"}`,
                    sessionId: this.sessionId || "",
                  } as any);
                });

                return { content: [{ type: "text" as const, text: `Process started and monitoring enabled. Task ID: ${taskId}. PID: ${child.pid || "unknown"}.${args.timeoutSeconds ? ` Monitoring timeout: ${args.timeoutSeconds}s.` : ""}` }] };
              } catch (e: any) {
                console.error(`[Monitor] Error: ${e.message}`, e.stack);
                return { content: [{ type: "text" as const, text: `Monitor error: ${e.message}` }], isError: true };
              }
            }
          ),
        ],
      });

      // Prepend tool context to the first prompt in a session
      const ttsInstruction = this._ttsEnabled
        ? `\n\nIMPORTANT: Text-to-speech is enabled. Before writing your final text response, you MUST call the Speak tool with a concise, natural spoken summary. Keep it brief and conversational — don't read code, URLs, or markdown aloud. If your response is short and simple, speak it nearly verbatim. If it's long or technical, summarize the key points. Always still write your full text response after speaking.`
        : "";

      // Collect plugin tool context fragments
      let pluginContext = "";
      for (const plugin of this.plugins) {
        if (plugin.toolContextFragment) {
          const fragment = plugin.toolContextFragment();
          if (fragment) pluginContext += "\n" + fragment;
        }
      }

      const secureInputInventory = secureInputInventoryForAgent(this.sessionId || undefined, this.cwd);
      const toolContext = `${buildSocketAgentIntegrationInstructions({
        mcpServerName: "app",
        toolNames: [
          "HtmlPlan",
          "WorkReview",
          "BrowserSession",
          "SendFile",
          "RequestSecureInput",
          "Speak",
          "ScheduleReminder",
          "NotifyUser",
          "ScheduleTask",
          "TaskBatch",
          "AgentSession",
          "Remember",
          "Monitor",
          "SearchSkills",
          "ReadSkill",
        ],
        secureInventory: secureInputInventory,
        monitorToolReference: "mcp__app__Monitor",
      })}${ttsInstruction}${pluginContext}`;

      // Handle fork: use fork source as resume target + set forkSession flag
      const shouldFork = !!this._forkFromSessionId;
      const forkSourceId = this._forkFromSessionId;
      this._forkFromSessionId = undefined;

      const resumeTarget = shouldFork
        ? forkSourceId
        : (resumeSessionId || this.sessionId || undefined);

      // Consume resumeSessionAt (conversation rewind point)
      const resumeAt = this._resumeSessionAt;
      this._resumeSessionAt = undefined;

      // Pre-assign a UUID for this user message so we can wire up rewind support
      // immediately, without waiting for the SDK to echo it back. (Recent SDK versions stopped
      // emitting a `user` message echo for string prompts; we control the UUID here
      // and pass it via streaming-input mode so it lands in the SDK transcript with
      // the same ID we hand to the app.)
      const userMsgUuid = messageId || crypto.randomUUID();
      const promptSessionId = resumeTarget || this.sessionId || "";
      const transferContext = this._pendingTransferContext;
      const nativePrompt = transferContext
        ? `<socketagent_session_handoff>\n${transferContext}\n</socketagent_session_handoff>\n\nCurrent user message:\n${prompt}`
        : prompt;
      const promptStream = new ClaudeInputQueue();
      this.activeInputQueue = promptStream;
      promptStream.push(this._createUserMessage(nativePrompt, promptSessionId, userMsgUuid));
      // Validate and persist resumed-session history before query() launches a
      // Claude subprocess. A corrupt crash snapshot must not strand an orphan.
      let promptLogged = false;
      if (this.sessionId || resumeSessionId) {
        const sid = this.sessionId || resumeSessionId || "";
        const historyEntry = appendHistory(sid, {
          role: "user",
          content: prompt,
          uuid: userMsgUuid,
          timestamp: new Date().toISOString(),
        });
        this.send({
          type: "user_message_uuid",
          uuid: userMsgUuid,
          sessionId: sid,
          entryId: historyEntry.entryId,
          sessionSeq: historyEntry.sessionSeq,
          revision: historyEntry.revision,
          ...(messageId ? { clientMessageId: messageId } : {}),
        } as any);
        promptLogged = true;
      }

      console.log(`Starting query: resume=${resumeTarget || 'none'}${shouldFork ? ' (FORK)' : ''}${resumeAt ? ` resumeAt=${resumeAt}` : ''}, effort=${this._effort}, thinking=${JSON.stringify(this._thinking)}, prompt=${prompt.slice(0, 80)}..., uuid=${userMsgUuid}, cwd=${this.cwd}`);

      const initialPermissionMode = this._permissionMode || "bypassPermissions";

      const q = this.activeQuery = query({
        prompt: promptStream as any,
        options: {
          cwd: this.cwd,
          ...claudeExecutableQueryOptions(),
          permissionMode: initialPermissionMode as any,
          allowDangerouslySkipPermissions: initialPermissionMode === "bypassPermissions",
          includePartialMessages: true,
          includeHookEvents: true,
          // Complete subagent messages carry parent_tool_use_id. Forward their
          // text/thinking so the app can render the nested transcript instead
          // of receiving only otherwise-contextless child tool cards.
          forwardSubagentText: true,
          resume: resumeTarget,
          forkSession: shouldFork || undefined,
          resumeSessionAt: resumeAt,
          abortController: this.abortController,
          effort: this._effort as any,
          thinking: this._thinking as any,
          ...(this._requestedModel ? { model: this._requestedModel } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: this._appendSystemPrompt ? toolContext + '\n\n' + this._appendSystemPrompt : toolContext } as any,
          tools: { type: "preset", preset: "claude_code" },
          disallowedTools: claudeDisallowedTools(this._disallowedTools),
          settings: this.claudeFlagSettings(),
          enableFileCheckpointing: true,
          promptSuggestions: true,
          agentProgressSummaries: true,
          toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
          settingSources: ["user", "project", "local"],
          mcpServers: (() => {
            const servers: Record<string, any> = { "app": appTools };
            for (const plugin of this.plugins) {
              if (plugin.mcpServers) Object.assign(servers, plugin.mcpServers());
            }
            return servers;
          })(),
          allowedTools: (() => {
            const tools = ["mcp__app__*"];
            for (const plugin of this.plugins) {
              if (plugin.allowedTools) tools.push(...plugin.allowedTools());
            }
            return tools;
          })(),
          env: cleanEnv,
          hooks: {
            PreToolUse: [{
              hooks: [async (input: any) => {
                const toolName = input.tool_name || "";
                const toolInput = input.tool_input || {};

                // Run plugin interceptors
                const sessionCtx = this.getSessionContext();
                let pluginAllowed = false;
                console.log(`[Hook] PreToolUse: tool=${toolName} plugins=${this.plugins.length} cmd=${toolName === 'Bash' ? String(toolInput.command || '').slice(0, 100) : '...'}`);
                for (const plugin of this.plugins) {
                  if (plugin.canUseToolInterceptor) {
                    console.log(`[Hook] Running plugin interceptor: ${plugin.name || 'unnamed'}`);
                    const result = await plugin.canUseToolInterceptor(toolName, toolInput, sessionCtx);
                    console.log(`[Hook] Plugin result: ${JSON.stringify(result)?.slice(0, 200)}`);
                    if (result !== null && result !== undefined) {
                      if (result.behavior === "deny") {
                        console.log(`[Hook] PreToolUse DENIED by plugin: ${toolName}`);
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: result.message || "Blocked by plugin",
                          },
                        };
                      }
                      // Plugin explicitly allowed — continue to bash wrapping check
                      console.log(`[Hook] PreToolUse ALLOWED by plugin: ${toolName}`);
                      pluginAllowed = true;
                      break;
                    }
                  }
                }

                // Stop our file watcher before TaskOutput reads the same file
                if (toolName === "TaskOutput") {
                  console.log(`[Hook] PreToolUse TaskOutput — stopping bash watcher to avoid conflict`);
                  this._stopBashWatcher();
                  return { continue: true };
                }

                // Wrap Bash commands with tee for live streaming output
                if (toolName === "Bash" && toolInput.command) {
                  const toolUseId = input.tool_use_id || "unknown";
                  const outFile = `/tmp/claude-bash-${toolUseId}.log`;
                  try { fs.writeFileSync(outFile, ""); } catch {}
                  const wrapped = `set -o pipefail; (${toolInput.command}) 2>&1 | stdbuf -oL tee ${outFile}`;
                  console.log(`[Hook] Bash tee: toolUseId=${toolUseId} outFile=${outFile}`);
                  // Log the updatedInput to verify it's being applied
                  const result = {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "allow" as const,
                      updatedInput: { command: wrapped },
                    },
                  };
                  console.log(`[Hook] Bash returning updatedInput command length=${wrapped.length}`);
                  return result;
                }

                // No modification needed — allow
                if (pluginAllowed) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                    },
                  };
                }
                return { continue: true };
              }],
            }],
            PostToolUse: [{
              hooks: [async (input: any) => {
                try {
                  const toolName = String(input.tool_name || "");
                  const toolInput = input.tool_input && typeof input.tool_input === "object"
                    ? input.tool_input
                    : {};
                  const toolResponse = input.tool_response && typeof input.tool_response === "object"
                    ? input.tool_response
                    : {};
                  if (toolName === "TaskCreate") {
                    const task = toolResponse.task && typeof toolResponse.task === "object"
                      ? toolResponse.task
                      : {};
                    this._publishClaudeTaskUpdate({
                      taskId: String(task.id || ""),
                      subject: String(task.subject || toolInput.subject || ""),
                      description: String(toolInput.description || "") || undefined,
                      status: "pending",
                    });
                  } else if (toolName === "TaskUpdate" && toolResponse.success !== false) {
                    const status = String(
                      toolResponse.statusChange?.to
                      || toolInput.status
                      || "",
                    );
                    this._publishClaudeTaskUpdate({
                      taskId: String(toolResponse.taskId || toolInput.taskId || ""),
                      subject: String(toolInput.subject || "") || undefined,
                      status: status === "pending"
                        || status === "in_progress"
                        || status === "completed"
                        || status === "deleted"
                        ? status
                        : undefined,
                    });
                  } else if (toolName === "TaskGet" && toolResponse.task) {
                    const task = toolResponse.task;
                    this._publishClaudeTaskUpdate({
                      taskId: String(task.id || ""),
                      subject: String(task.subject || ""),
                      description: String(task.description || "") || undefined,
                      teammateName: String(task.owner || "") || undefined,
                      status: task.status,
                    });
                  } else if (toolName === "TaskList" && Array.isArray(toolResponse.tasks)) {
                    this._publishClaudeTaskSnapshot(toolResponse.tasks);
                  }
                } catch (error) {
                  console.warn(`[Hook] Failed to persist Claude task state: ${error}`);
                }
                return { continue: true };
              }],
            }],
            PostToolBatch: [{
              hooks: [async (input: any) => {
                // Subagent batches belong to their own context. Only feed
                // phone-authored context into the main thread.
                if (input.agent_id) return { continue: true };
                const pending = this._takePendingBoundaryContext();
                if (pending.length === 0) return { continue: true };
                console.log(
                  `[Inject] Delivering ${pending.length} queued message(s) through PostToolBatch`,
                );
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PostToolBatch" as const,
                    additionalContext: formatClaudeBoundaryContext(pending),
                  },
                };
              }],
            }],
            SubagentStart: [{
              hooks: [async (input: any) => {
                try {
                  const agentId = input.agent_id || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SubagentStart: agentId=${agentId} type=${agentType}`);
                } catch {}
                return { continue: true };
              }],
            }],
            SubagentStop: [{
              hooks: [async (input: any) => {
                try {
                  const agentId = input.agent_id || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SubagentStop: agentId=${agentId} type=${agentType}`);
                } catch {}
                return { continue: true };
              }],
            }],
            SessionStart: [{
              hooks: [async (input: any) => {
                try {
                  const source = input.source || "unknown";
                  const model = input.model || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SessionStart: source=${source} model=${model} agentType=${agentType}`);
                  if (model) this._sessionModel = model;
                  if (model) this.persistAgentSettings({ model });
                  this.send({
                    type: "session_lifecycle",
                    event: "start",
                    source,
                    model: model || undefined,
                    agentType: agentType || undefined,
                    sessionId: this.sessionId || "",
                  } as any);
                  // Persist in history for restore on session resume
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[session_lifecycle:start:${source}${model ? ':' + model : ''}]`,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch {}
                return { continue: true };
              }],
            }],
            SessionEnd: [{
              hooks: [async (input: any) => {
                try {
                  const reason = input.reason || "unknown";
                  console.log(`[Hook] SessionEnd: reason=${reason}`);
                  this.send({
                    type: "session_lifecycle",
                    event: "end",
                    reason,
                    sessionId: this.sessionId || "",
                  } as any);
                  // Persist in history for restore on session resume
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[session_lifecycle:end:${reason}]`,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch {}
                return { continue: true };
              }],
            }],
            TaskCreated: [{
              hooks: [async (input: any) => {
                try {
                  const taskId = input.task_id || "";
                  const subject = input.task_subject || "";
                  const description = input.task_description || "";
                  const teammateName = input.teammate_name || "";
                  console.log(`[Hook] TaskCreated: id=${taskId} subject=${subject}`);
                  this._publishClaudeTaskUpdate({
                    taskId,
                    subject,
                    description: description || undefined,
                    teammateName: teammateName || undefined,
                    status: "pending",
                  });
                } catch {}
                return { continue: true };
              }],
            }],
            TaskCompleted: [{
              hooks: [async (input: any) => {
                try {
                  const taskId = input.task_id || "";
                  const subject = input.task_subject || "";
                  const description = input.task_description || "";
                  const teammateName = input.teammate_name || "";
                  console.log(`[Hook] TaskCompleted: id=${taskId} subject=${subject} desc=${description?.slice(0, 80)}`);
                  this._publishClaudeTaskUpdate({
                    taskId,
                    subject,
                    description: description || undefined,
                    teammateName: teammateName || undefined,
                    status: "completed",
                  });
                } catch {}
                return { continue: true };
              }],
            }],
          },
          stderr: (data: string) => {
            const trimmed = data.trimEnd();
            if (trimmed) {
              // Filter out SDK internal errors (stream closing race conditions).
              // The CLI dumps multi-line source context between the header and the
              // trailing `error: Stream closed`, so we match across newlines.
              if (/Error in hook callback.*Stream closed/is.test(trimmed)
                  || /^error: Stream closed\b[\s\S]*at sendRequest/i.test(trimmed)) {
                console.warn(`[Claude stderr] (suppressed SDK hook error) ${trimmed.slice(0, 100)}`);
                return;
              }
              console.error(`[Claude stderr] ${trimmed}`);
              // Forward stderr as streaming tool output to the app
              this.send({
                type: "tool_stderr",
                content: trimmed,
                sessionId: this.sessionId || "",
              } as any);
            }
          },
          canUseTool: async (toolName, input, { signal, suggestions, blockedPath, decisionReason, toolUseID, agentID } = {} as any) => {
            console.log(`canUseTool called: ${toolName}${agentID ? ` (agent: ${agentID})` : ''}${decisionReason ? ` reason: ${decisionReason}` : ''}`);

            // NOTE: Plugin interceptors run in PreToolUse hook (not here).
            // In bypassPermissions mode, canUseTool is only called for interactive tools.

            if (toolName === "AskUserQuestion") {
              const qId = createInteractiveRequestId("q");
              const questions: QuestionItem[] = [];
              const inputQuestions = (input as any).questions;

              if (Array.isArray(inputQuestions)) {
                for (const q of inputQuestions) {
                  questions.push({
                    question: q.question || "",
                    header: q.header,
                    options: Array.isArray(q.options)
                      ? q.options.map((o: any) => ({
                          label: o.label || "",
                          description: o.description,
                          preview: o.preview || undefined,
                        }))
                      : [],
                    multiSelect: q.multiSelect,
                  });
                }
              }

              const questionMsg: ServerMessage = {
                type: "question",
                questionId: qId,
                questions,
                sessionId: this.sessionId || "",
                agentId: agentID || undefined,
                decisionReason: decisionReason || undefined,
              } as any;
              this.send(questionMsg);

              // Persist to history so questions survive reconnects
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "question",
                  content: "",
                  questionId: qId,
                  questions,
                  timestamp: new Date().toISOString(),
                });
              }

              const answers = await new Promise<Record<string, string>>(
                (resolve) => {
                  this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
                }
              );

              return {
                behavior: "allow" as const,
                updatedInput: { ...input, answers },
              };
            }

            // Intercept ExitPlanMode — show plan to user for approval
            if (toolName === "ExitPlanMode") {
              // Use planFilePath from SDK input (v0.2.76+), fall back to directory search
              const planFilePath = (input as any).planFilePath;
              let planContent = "";
              try {
                if (planFilePath && fs.existsSync(planFilePath)) {
                  planContent = fs.readFileSync(planFilePath, "utf-8");
                  console.log(`[Plan] Read plan from SDK planFilePath: ${planFilePath}`);
                } else {
                  // Fallback: search plans directory for most recent .md file
                  const homeDir = process.env.HOME || require("os").homedir();
                  const plansDir = path.join(homeDir, ".claude", "plans");
                  if (fs.existsSync(plansDir)) {
                    const files = fs.readdirSync(plansDir)
                      .filter(f => f.endsWith(".md"))
                      .map(f => ({
                        name: f,
                        mtime: fs.statSync(path.join(plansDir, f)).mtimeMs,
                      }))
                      .sort((a, b) => b.mtime - a.mtime);
                    if (files.length > 0) {
                      planContent = fs.readFileSync(
                        path.join(plansDir, files[0].name), "utf-8"
                      );
                    }
                  }
                }
              } catch (e) {
                console.error(`[Plan] Error reading plan file: ${e}`);
              }

              const qId = createInteractiveRequestId("q");
              const planQuestions: QuestionItem[] = [
                {
                  question: planContent || "Claude has proposed a plan. Approve or reject?",
                  header: "Plan Review",
                  options: [
                    { label: "Approve", description: "Accept this plan and proceed with implementation" },
                    { label: "Reject", description: "Reject this plan" },
                  ],
                  multiSelect: false,
                },
              ];
              const questionMsg: ServerMessage = {
                type: "question",
                questionId: qId,
                questions: planQuestions,
                sessionId: this.sessionId || "",
              };
              this.send(questionMsg);

              // Persist to history so plan reviews survive reconnects
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "question",
                  content: "",
                  questionId: qId,
                  questions: planQuestions,
                  timestamp: new Date().toISOString(),
                });
              }

              const answers = await new Promise<Record<string, string>>(
                (resolve) => {
                  this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
                }
              );

              const firstAnswer = Object.values(answers)[0] || "";
              if (firstAnswer.toLowerCase().includes("approve")) {
                // Notify app that we're exiting plan mode
                this.send({
                  type: "permission_mode_changed",
                  permissionMode: "bypassPermissions",
                  sessionId: this.sessionId || "",
                } as any);
                return { behavior: "allow" as const, updatedInput: input };
              } else {
                return { behavior: "deny" as const, message: "User rejected the plan." };
              }
            }

            return { behavior: "allow" as const, updatedInput: input };
          },
          onElicitation: async (request: any, { signal }: { signal: AbortSignal }) => {
            const { serverName, message, mode, url, elicitationId, requestedSchema } = request;
            console.log(`[Elicitation] server=${serverName} mode=${mode || 'form'} msg=${message?.slice(0, 100)}`);

            if (mode === 'url' && url) {
              // URL-mode: send a dedicated card so the app can open the URL
              const qId = createInteractiveRequestId("elicit");
              const elicitMsg: ServerMessage = {
                type: "elicitation_url",
                questionId: qId,
                mcpServerName: serverName,
                message: message || `${serverName} requires authentication`,
                url,
                elicitationId: elicitationId || undefined,
                sessionId: this.sessionId || "",
              } as any;
              this.send(elicitMsg);

              // Persist to history so it survives session resume
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "elicitation_url",
                  content: message || `${serverName} requires authentication`,
                  questionId: qId,
                  mcpServerName: serverName,
                  url,
                  timestamp: new Date().toISOString(),
                });
              }

              // Wait for user to complete the URL flow or cancel
              const answers = await new Promise<Record<string, string>>((resolve) => {
                this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: elicitMsg });
              });
              const action = Object.values(answers)[0] || "";
              if (action.toLowerCase().includes("cancel") || action.toLowerCase().includes("decline")) {
                return { action: "decline" as const };
              }
              return { action: "accept" as const };
            }

            // Form-mode: convert requestedSchema to QuestionItems and use question card
            const qId = createInteractiveRequestId("elicit");
            const questions: QuestionItem[] = [];

            if (requestedSchema && typeof requestedSchema === 'object') {
              const props = (requestedSchema as any).properties || {};
              const required = (requestedSchema as any).required || [];
              for (const [key, schema] of Object.entries(props) as [string, any][]) {
                const desc = schema.description || key;
                const isRequired = required.includes(key);
                const options: { label: string; description?: string }[] = [];
                // If the schema has enum values, create options for them
                if (Array.isArray(schema.enum)) {
                  for (const val of schema.enum) {
                    options.push({ label: String(val) });
                  }
                }
                questions.push({
                  question: `${desc}${isRequired ? ' (required)' : ''}`,
                  header: key,
                  options,
                  multiSelect: false,
                });
              }
            }

            // Fallback if no schema properties: single text input with the message
            if (questions.length === 0) {
              questions.push({
                question: message || `${serverName} is requesting input`,
                options: [],
                multiSelect: false,
              });
            }

            const questionMsg: ServerMessage = {
              type: "question",
              questionId: qId,
              questions,
              sessionId: this.sessionId || "",
              mcpServerName: serverName,
            } as any;
            this.send(questionMsg);

            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "question",
                content: "",
                questionId: qId,
                questions,
                timestamp: new Date().toISOString(),
              });
            }

            const answers = await new Promise<Record<string, string>>((resolve) => {
              this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
            });

            // Check if user cancelled
            const firstAnswer = Object.values(answers)[0] || "";
            if (firstAnswer.toLowerCase() === "cancel" || firstAnswer.toLowerCase() === "decline") {
              return { action: "decline" as const };
            }

            // Map answers back to the schema structure
            const content: Record<string, string | number | boolean | string[]> = {};
            if (requestedSchema && (requestedSchema as any).properties) {
              const props = (requestedSchema as any).properties;
              for (const [key] of Object.entries(props)) {
                if (answers[key] !== undefined) {
                  content[key] = answers[key];
                }
              }
            } else {
              // Single-field fallback
              const val = Object.values(answers)[0];
              if (val) content["value"] = val;
            }

            return { action: "accept" as const, content };
          },
        },
      });
      this._pendingTransferContext = null;
      if (transferContext) {
        const transferSessionId = this.sessionId || this.replacesSessionId || resumeTarget;
        if (transferSessionId) clearSessionPendingHandoffContext(transferSessionId);
      }

      let currentText = "";
      let sawMainAssistantText = false;
      let lastResultContent = "";
      const now = () => new Date().toISOString();

      // SDK event persistence: coalesce content block deltas independently for
      // the main agent and every concurrently streaming subagent.
      const sdkBlocks = new Map<string, {
        text: string;
        index: number | null;
        type: string | null;
        toolName: string | null;
        toolUseId: string | null;
        deltaCount: number;
      }>();

      // Track per-turn usage from stream events to get current context size
      let lastTurnInputTokens = 0;
      let lastTurnOutputTokens = 0;
      let lastTurnCacheReadTokens = 0;
      let lastTurnCacheCreateTokens = 0;

      const initialTurnPromise = this._trackPendingTurn();

      const consumeQuery = async () => {
        try {
          for await (const message of q) {
        // Debug: log all message types to understand SDK event flow
        const msgType = message.type;
        const subtype = (message as any).subtype || (message as any).event?.type || '';
        if (msgType === 'stream_event') {
          const evt = (message as any).event;
          if (evt?.type && evt.type !== 'content_block_delta' && evt.type !== 'message_start' && evt.type !== 'message_delta') {
            console.log(`[SDK stream] event=${evt.type} ${JSON.stringify(evt).slice(0, 200)}`);
          }
        } else if (msgType === 'tool_progress') {
          const tp = message as any;
          console.log(`[SDK msg] type=tool_progress tool=${tp.tool_name} elapsed=${tp.elapsed_time_seconds}s id=${tp.tool_use_id}`);
        } else {
          console.log(`[SDK msg] type=${msgType} subtype=${subtype}`);
        }

        if (message.type === "assistant") {
          this._retractClaudeMessages((message as any).supersedes);
        }
        if (message.type === "system" && (message as any).subtype === "model_refusal_fallback") {
          this._retractClaudeMessages((message as any).retracted_message_uuids);
        }
        if (message.type === "conversation_reset") {
          this._handleClaudeConversationReset(message);
        }

        // Forward raw SDK event to app for debug mode + persist to JSONL
        try {
          const sdkPayload: any = { type: "sdk_event", sdkType: msgType };
          if (msgType === "stream_event") {
            const evt = (message as any).event;
            sdkPayload.event = evt;

            // Coalesced persistence: accumulate deltas, write on block_stop
            const sid = this.sessionId;
            if (sid && evt) {
              const evtType = evt.type;
              const blockKey = `${this._streamKey(message)}:${evt.index ?? "current"}`;
              if (evtType === "content_block_start") {
                const cb = evt.content_block || {};
                sdkBlocks.set(blockKey, {
                  text: "",
                  index: evt.index ?? null,
                  type: cb.type || null,
                  toolName: cb.name || null,
                  toolUseId: cb.id || null,
                  deltaCount: 0,
                });
              } else if (evtType === "content_block_delta") {
                const block = sdkBlocks.get(blockKey) || {
                  text: "",
                  index: evt.index ?? null,
                  type: null,
                  toolName: null,
                  toolUseId: null,
                  deltaCount: 0,
                };
                const delta = evt.delta || {};
                if (delta.type === "text_delta") block.text += delta.text || "";
                else if (delta.type === "input_json_delta") block.text += delta.partial_json || "";
                else if (delta.type === "thinking_delta") block.text += delta.thinking || "";
                block.deltaCount++;
                sdkBlocks.set(blockKey, block);
              } else if (evtType === "content_block_stop") {
                const block = sdkBlocks.get(blockKey);
                if (block) {
                  // Write coalesced content block entry
                  appendSdkEvent(sid, {
                    ts: now(),
                    sdkType: "content_block",
                    blockIndex: block.index,
                    blockType: block.type,
                    toolName: block.toolName,
                    toolUseId: block.toolUseId,
                    text: block.text,
                    deltaCount: block.deltaCount,
                  });
                  sdkBlocks.delete(blockKey);
                }
              } else if (evtType === "message_start") {
                const msg2 = evt.message || {};
                appendSdkEvent(sid, {
                  ts: now(),
                  sdkType: "message_start",
                  model: msg2.model,
                  usage: msg2.usage,
                });
              } else if (evtType === "message_delta") {
                appendSdkEvent(sid, {
                  ts: now(),
                  sdkType: "message_delta",
                  usage: evt.usage,
                  stopReason: evt.delta?.stop_reason,
                });
              } else if (evtType === "message_stop") {
                appendSdkEvent(sid, { ts: now(), sdkType: "message_stop" });
              }
            }
          } else {
            // Shallow copy, skip huge fields
            const raw = message as any;
            sdkPayload.subtype = raw.subtype;
            if (raw.session_id) sdkPayload.sessionId = raw.session_id;
            // assistant/user messages store content under .message.content
            const contentSource = raw.content || raw.message?.content;
            if (contentSource) {
              const blocks = Array.isArray(contentSource) ? contentSource : [];
              sdkPayload.blocks = blocks.map((b: any) => {
                if (b.type === "text") return { type: "text", text: b.text?.slice(0, 200) };
                if (b.type === "tool_use") return { type: "tool_use", name: b.name, id: b.id };
                if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content.slice(0, 200) : '(structured)' };
                return { type: b.type };
              });
            }
            if (raw.tool_name) sdkPayload.toolName = raw.tool_name;
            if (raw.tool_use_id) sdkPayload.toolUseId = raw.tool_use_id;
            if (raw.elapsed_time_seconds) sdkPayload.elapsed = raw.elapsed_time_seconds;
            if (raw.duration_ms) sdkPayload.durationMs = raw.duration_ms;
            if (raw.cost_usd) sdkPayload.cost = raw.cost_usd;
            if (raw.num_turns) sdkPayload.numTurns = raw.num_turns;
            if (raw.is_error) sdkPayload.isError = raw.is_error;
            if (raw.model_usage) sdkPayload.modelUsage = raw.model_usage;
            // System event fields
            if (raw.status) sdkPayload.status = raw.status;
            if (raw.compact_metadata) sdkPayload.compactMetadata = raw.compact_metadata;
            if (raw.task_id) sdkPayload.taskId = raw.task_id;
            if (raw.summary) sdkPayload.summary = raw.summary?.slice(0, 300);
            if (raw.trigger) sdkPayload.trigger = raw.trigger;

            // Persist non-stream events directly
            const sid = this.sessionId;
            if (sid) {
              appendSdkEvent(sid, { ts: now(), ...sdkPayload, type: undefined });
            }
          }
          this.sendSdkEvent(sdkPayload as any);
        } catch (_) {}

        if (message.type === "system" && (message as any).subtype === "init") {
          this.sessionId = message.session_id;
          const replacesSessionId = this.replacesSessionId;
          this.send({
            type: "session_created",
            sessionId: message.session_id,
            ...(replacesSessionId ? { replacesSessionId } : {}),
            cwd: this.cwd,
            backend: "claude",
          });

          if (replacesSessionId) {
            // Context was cleared — remap old session ID to this new one
            remapSession(replacesSessionId, message.session_id);
            remapSessionMemory(replacesSessionId, message.session_id);
            this.onSessionIdChanged?.(replacesSessionId, message.session_id);
            this.replacesSessionId = undefined;
          } else if (!resumeSessionId) {
            const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
            const sessionInfo: SessionInfo = {
              id: message.session_id,
              title,
              cwd: this.cwd,
              createdAt: new Date().toISOString(),
              lastActive: new Date().toISOString(),
              messagePreview: "",
              backend: "claude",
              agentSettings: this.getAgentSettings(),
            };
            saveSession(sessionInfo);
          }

          this.send({
            type: "session_settings",
            sessionId: message.session_id,
            settings: this.getAgentSettings(),
          } as any);

          // Forward init data to app (available agents, tools, MCP servers, model, etc.)
          const initMsg = message as any;
          const initPermissionMode = initMsg.permissionMode as string | undefined;
          if (initPermissionMode) {
            this._permissionMode = initPermissionMode;
            const session = getSession(this.sessionId || "");
            if (session) {
              session.permissionMode = initPermissionMode;
              saveSession(session);
            }
            if (!resumeSessionId && this.sessionId) {
              appendHistory(this.sessionId, {
                role: "permission_mode",
                content: "",
                permissionMode: initPermissionMode,
                timestamp: new Date().toISOString(),
              });
            }
          }
          this._lastSessionInit = {
            type: "session_init",
            agents: initMsg.agents || undefined,
            tools: initMsg.tools || undefined,
            mcpServers: initMsg.mcp_servers || undefined,
            model: initMsg.model || undefined,
            claudeCodeVersion: initMsg.claude_code_version || undefined,
            permissionMode: initPermissionMode || undefined,
            sessionId: this.sessionId || "",
          } as any;
          this.send(this._lastSessionInit!);

          // Query available models and forward to app for model picker
          if (this.activeQuery) {
            this.activeQuery.supportedModels().then((models: any) => {
              if (Array.isArray(models) && models.length > 0) {
                const saved = saveCachedModelCatalog("claude", models);
                this.publishSupportedModels(saved.models, { updatedAt: saved.updatedAt });
              }
            }).catch((e: any) => {
              console.error(`[Init] Failed to get supported models: ${e}`);
            });

            // Query available commands and agents (#18)
            // Wrapped in try-catch: older SDK versions may not have these methods,
            // and a synchronous TypeError would crash the message processing loop.
            try {
              console.log(`[Init] Querying supportedCommands...`);
              this.activeQuery.supportedCommands().then((commands: any) => {
                console.log(`[Init] supportedCommands returned: ${Array.isArray(commands) ? commands.length + ' commands' : typeof commands}`);
                if (commands && Array.isArray(commands) && commands.length > 0) {
                  this._lastSupportedCommands = {
                    type: "supported_commands",
                    commands,
                    sessionId: this.sessionId || "",
                  } as any;
                  this.send(this._lastSupportedCommands!);
                }
              }).catch((e: any) => {
                console.error(`[Init] Failed to get supported commands: ${e}`);
              });
            } catch (e) {
              console.warn(`[Init] supportedCommands not available: ${e}`);
            }

            try {
              console.log(`[Init] Querying supportedAgents...`);
              this.activeQuery.supportedAgents().then((agents: any) => {
                console.log(`[Init] supportedAgents returned: ${Array.isArray(agents) ? agents.length + ' agents' : typeof agents}`);
                if (agents && Array.isArray(agents) && agents.length > 0) {
                  this._lastSupportedAgents = {
                    type: "supported_agents",
                    agents,
                    sessionId: this.sessionId || "",
                  } as any;
                  this.send(this._lastSupportedAgents!);
                }
              }).catch((e: any) => {
                console.error(`[Init] Failed to get supported agents: ${e}`);
              });
            } catch (e) {
              console.warn(`[Init] supportedAgents not available: ${e}`);
            }

            // Fetch initial context usage
            this.activeQuery.getContextUsage().then((ctx: any) => {
              if (ctx) {
                this.send({
                  type: "context_usage",
                  sessionId: this.sessionId || "",
                  ...ctx,
                } as any);
                if (this.sessionId) updateSessionContextUsage(this.sessionId, ctx);
              }
            }).catch(() => {});
            this._refreshPlanRateLimits();
          }

          // Log user prompt now that we have the session ID (for new sessions)
          if (!promptLogged) {
            const historyEntry = appendHistory(message.session_id, {
              role: "user",
              content: prompt,
              uuid: userMsgUuid,
              timestamp: now(),
            });
            // Forward UUID once we know which session it belongs to.
            this.send({
              type: "user_message_uuid",
              uuid: userMsgUuid,
              sessionId: message.session_id,
              entryId: historyEntry.entryId,
              sessionSeq: historyEntry.sessionSeq,
              revision: historyEntry.revision,
              ...(messageId ? { clientMessageId: messageId } : {}),
            } as any);
            promptLogged = true;
          }
        }

        // Forward tool_progress to the app — shows elapsed time while tools run
        if (message.type === "tool_progress") {
          const tp = message as any;
          this.send({
            type: "tool_progress",
            toolUseId: tp.tool_use_id || "",
            toolName: tp.tool_name || "",
            elapsedSeconds: tp.elapsed_time_seconds || 0,
            sessionId: this.sessionId || "",
            parentToolUseId: tp.parent_tool_use_id || null,
            uuid: tp.uuid || undefined,
            taskId: tp.task_id || undefined,
            heartbeat: tp.heartbeat === true || undefined,
            subagentType: tp.subagent_type || undefined,
            ...(tp.subagent_retry ? {
              subagentRetry: {
                agentId: String(tp.subagent_retry.agent_id || ""),
                attempt: Number(tp.subagent_retry.attempt || 0),
                maxRetries: Number(tp.subagent_retry.max_retries || 0),
                retryDelayMs: Number(tp.subagent_retry.retry_delay_ms || 0),
                errorStatus: tp.subagent_retry.error_status ?? undefined,
                errorCategory: String(tp.subagent_retry.error_category || ""),
              },
            } : {}),
          });
        }

        // Forward files_persisted events — tells the app which files were written
        if (message.type === "system" && (message as any).subtype === "files_persisted") {
          const fp = message as any;
          console.log(`[SDK] Files persisted: ${fp.files?.length || 0} files, ${fp.failed?.length || 0} failed`);
          this.send({
            type: "files_persisted",
            files: fp.files || [],
            failed: fp.failed || [],
            sessionId: this.sessionId || "",
          } as any);
        }

        // Live thinking progress. When extended thinking is redacted the API
        // streams pings rather than text, so thinking_delta carries no words and
        // the only signal that reasoning is happening is this running token
        // estimate. Forward it so the app can show progress instead of either an
        // empty bubble or nothing at all.
        if (message.type === "system" && (message as any).subtype === "thinking_tokens") {
          const tt = message as any;
          this._thinkingProgress ??= {
            startedAtMs: Date.now(),
            estimatedTokens: 0,
            ...(tt.uuid ? { uuid: String(tt.uuid) } : {}),
          };
          this._thinkingProgress.estimatedTokens = Math.max(
            this._thinkingProgress.estimatedTokens,
            Number(tt.estimated_tokens || 0),
          );
          // These arrive once or twice a second for the whole thinking phase.
          // Coalesce so a phone on the relay isn't woken for every ping.
          const nowMs = Date.now();
          if (nowMs - this._lastThinkingTokensSentAt >= THINKING_TOKENS_MIN_INTERVAL_MS) {
            this._lastThinkingTokensSentAt = nowMs;
            this.send({
              type: "thinking_tokens",
              estimatedTokens: tt.estimated_tokens || 0,
              estimatedTokensDelta: tt.estimated_tokens_delta || 0,
              sessionId: this.sessionId || "",
              uuid: tt.uuid || undefined,
            } as any);
          }
        }

        // Forward auth status changes (authenticating state)
        if (message.type === "auth_status") {
          const auth = message as any;
          console.log(`[SDK] Auth status: isAuthenticating=${auth.isAuthenticating}`);
          this.send({
            type: "auth_status",
            isAuthenticating: auth.isAuthenticating || false,
            output: auth.output || [],
            error: auth.error || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Detect context compaction status changes
        if (message.type === "system" && (message as any).subtype === "status") {
          const status = (message as any).status as string | null;
          const permMode = (message as any).permissionMode as string | undefined;
          console.log(`[SDK] Status change: ${status}${permMode ? ` permissionMode=${permMode}` : ''}`);
          this._isCompacting = status === "compacting";
          if (this._isCompacting) {
            this._compactStartedAt ||= new Date().toISOString();
          } else {
            this._compactStartedAt = null;
          }
          this.send({
            type: "compacting",
            active: this._isCompacting,
            sessionId: this.sessionId || "",
          } as any);
          // Forward permission mode changes (e.g., entering/exiting plan mode)
          if (permMode) {
            const previousMode = this._permissionMode;
            this._permissionMode = permMode;
            if (previousMode !== permMode) {
              this.persistPermissionMode(permMode);
            }
            this.send({
              type: "permission_mode_changed",
              permissionMode: permMode,
              sessionId: this.sessionId || "",
            } as any);
          }
        }

        // Forward compact boundary events (token count before compaction)
        if (message.type === "system" && (message as any).subtype === "compact_boundary") {
          const meta = (message as any).compact_metadata || {};
          console.log(`[SDK] Compact boundary: trigger=${meta.trigger} preTokens=${meta.pre_tokens}`);
          this.send({
            type: "compact_boundary",
            trigger: meta.trigger || "auto",
            preTokens: meta.pre_tokens || 0,
            sessionId: this.sessionId || "",
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: `[compact_boundary:${meta.pre_tokens || 0}:${meta.trigger || "auto"}]`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Forward background task notifications (type=system, subtype=task_notification)
        if (message.type === "system" && (message as any).subtype === "task_notification") {
          const tn = message as any;
          const sdkTaskId = tn.task_id || "";
          // Prefer SDK's direct tool_use_id, fall back to our mapping
          const originToolUseId = tn.tool_use_id || this._taskIdToToolUseId.get(sdkTaskId) || undefined;
          const workflowRun = this._workflowRuns.get(sdkTaskId);
          const parentToolUseId = originToolUseId
            ? this._toolParentIds.get(originToolUseId)
            : undefined;
          const subagentState = originToolUseId
            ? this._activeSubagents.get(originToolUseId)
            : this._findSubagentByTaskId(sdkTaskId)?.[1];
          const taskUsage = this._taskUsage(tn.usage);
          console.log(`[SDK] Task notification: id=${sdkTaskId} status=${tn.status} originToolUseId=${originToolUseId} summary=${tn.summary?.slice(0, 80)}`);
          // If this task was being monitored, flush output and send final notification
          if (sdkTaskId && this._monitoredTasks.has(sdkTaskId)) {
            const mState = this._monitoredTasks.get(sdkTaskId)!;
            this._stopMonitorReader(sdkTaskId);
            // Read any remaining output
            try {
              if (fs.existsSync(mState.outputFile)) {
                const fStat = fs.statSync(mState.outputFile);
                if (fStat.size > mState.lastSize) {
                  const mFd = fs.openSync(mState.outputFile, "r");
                  const mBuf = Buffer.alloc(fStat.size - mState.lastSize);
                  fs.readSync(mFd, mBuf, 0, mBuf.length, mState.lastSize);
                  fs.closeSync(mFd);
                  const remaining = mBuf.toString("utf8").split("\n").filter(l => l.length > 0);
                  if (remaining.length > 0) mState.outputBuffer.push(...remaining);
                }
              }
            } catch {}
            if (mState.outputBuffer.length > 0) {
              this._flushMonitorBuffer(sdkTaskId);
            }
            const exitMsg = `[Monitor: "${mState.description}" (${sdkTaskId})] Process ${tn.status || "completed"}. ${tn.summary || ""}`;
            if (this._isRunning && this.activeQuery) {
              this.injectMessage(exitMsg, 'next').catch(() => {});
            } else if (this.onMonitorOutput) {
              this.onMonitorOutput(exitMsg);
            }
            this._cleanupMonitor(sdkTaskId, false);
          }

          // Read full output file before cleaning up (for history persistence)
          let bgOutputContent = "";
          const bgOutputFile = tn.output_file || (sdkTaskId ? this._taskOutputFiles.get(sdkTaskId) : undefined);
          if (bgOutputFile) {
            try {
              if (fs.existsSync(bgOutputFile)) {
                bgOutputContent = fs.readFileSync(bgOutputFile, "utf-8");
              }
            } catch {}
          }

          if (sdkTaskId) this._taskOutputFiles.delete(sdkTaskId);
          if (sdkTaskId) this._stopBgBashWatcher(sdkTaskId);

          // The terminal task event, not the Agent tool's async-launch
          // acknowledgement, completes a background card. Always emit a final
          // tool result for subagents so live UI and history settle identically,
          // including failed/stopped tasks with no output file.
          const terminalOutput = bgOutputContent
            || String(tn.summary || "")
            || `Task ${tn.status || "completed"}`;
          if (originToolUseId && (bgOutputContent || subagentState || workflowRun)) {
            this.send({
              type: "tool_result",
              toolUseId: originToolUseId,
              output: terminalOutput,
              backgroundPending: false,
              parentToolUseId: parentToolUseId || null,
              sessionId: this.sessionId || "",
            });
          }
          if (originToolUseId && (bgOutputContent || subagentState || workflowRun) && this.sessionId) {
            appendHistory(this.sessionId, {
              role: "tool_result",
              content: "",
              toolUseId: originToolUseId,
              toolOutput: terminalOutput,
              backgroundPending: false,
              parentToolUseId: parentToolUseId || null,
              timestamp: new Date().toISOString(),
            });
          }

          const workflowSnapshot = workflowRun
            ? this._finishWorkflowRun(
              sdkTaskId,
              tn.status || "completed",
              String(tn.summary || workflowRun.summary),
            )
            : undefined;
          this._persistTaskState({
            taskId: sdkTaskId,
            taskKind: workflowSnapshot
              ? "workflow"
              : subagentState
                ? "subagent"
                : "background",
            status: tn.status || "completed",
            content: terminalOutput,
            taskDescription: subagentState?.description || String(tn.summary || "") || undefined,
            originToolUseId,
            parentToolUseId: parentToolUseId || null,
            taskType: this._sdkBackgroundTasks.get(sdkTaskId)?.taskType || undefined,
            subagentType: subagentState?.subagentType || undefined,
            prompt: subagentState?.prompt,
            progressSummary: subagentState?.progressSummary,
            lastToolName: subagentState?.lastToolName,
            usage: taskUsage || subagentState?.usage,
            isBackgrounded: false,
            skipTranscript: tn.skip_transcript === true || undefined,
            workflowState: workflowSnapshot,
          });
          this.send({
            type: "task_notification",
            taskId: sdkTaskId,
            status: tn.status || "completed",
            outputFile: bgOutputFile || undefined,
            summary: tn.summary || "",
            originToolUseId,
            parentToolUseId: parentToolUseId || null,
            subagentType: subagentState?.subagentType || undefined,
            usage: taskUsage,
            skipTranscript: tn.skip_transcript === true || undefined,
            sessionId: this.sessionId || "",
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "notification",
              content: tn.summary || `Task ${tn.status}`,
              status: tn.status || "completed",
              originToolUseId,
              parentToolUseId: parentToolUseId || null,
              subagentType: subagentState?.subagentType || undefined,
              taskUsage,
              timestamp: new Date().toISOString(),
            });
          }
          if (originToolUseId) this._activeSubagents.delete(originToolUseId);
          else {
            const entry = this._findSubagentByTaskId(sdkTaskId);
            if (entry) this._activeSubagents.delete(entry[0]);
          }
          if (sdkTaskId) {
            this._sdkBackgroundTasks.delete(sdkTaskId);
            this._sdkTaskIds.delete(sdkTaskId);
            this._taskIdToToolUseId.delete(sdkTaskId);
          }
          if (originToolUseId) this._toolParentIds.delete(originToolUseId);
          this._emitActiveSubagentsSnapshot();
          if (!this._isRunning && !this._hasClaudeBackgroundWork()) this._enterWarmIdle();
          this.onActivity?.();
        }

        // Handle tool use summaries — clean human-readable summaries of tool groups
        if (message.type === "tool_use_summary") {
          const summary = message as any;
          console.log(`[SDK] Tool use summary: ${summary.summary?.slice(0, 100)}`);
          this.send({
            type: "tool_summary",
            summary: summary.summary || "",
            precedingToolUseIds: summary.preceding_tool_use_ids || [],
            parentToolUseId: summary.parent_tool_use_id || null,
            sessionId: this.sessionId || "",
            uuid: summary.uuid || undefined,
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: summary.summary || "",
              toolSummary: true,
              precedingToolUseIds: summary.preceding_tool_use_ids || [],
              parentToolUseId: summary.parent_tool_use_id || null,
              uuid: summary.uuid || undefined,
              timestamp: now(),
            });
          }
        }

        // Forward rate limit events to app (#7)
        if (message.type === "rate_limit_event") {
          const info = (message as any).rate_limit_info || {};
          console.log(`[SDK] Rate limit raw: ${JSON.stringify((message as any).rate_limit_info)}`);
          const event = buildClaudeRateLimitEvent(info, this.sessionId || "");
          recordRateLimitEvent(event);
          this.send(event as any);
        }

        // Forward background task lifecycle events (#8, #9)
        if (message.type === "system" && (message as any).subtype === "task_started") {
          const ts = message as any;
          console.log(`[SDK] Task started: id=${ts.task_id} toolUseId=${ts.tool_use_id} desc=${ts.description} type=${ts.task_type}`);
          this._handleSdkTaskStarted(ts);
        }

        if (message.type === "system" && (message as any).subtype === "task_progress") {
          const tp = message as any;
          console.log(`[SDK] Task progress: id=${tp.task_id} toolUseId=${tp.tool_use_id || this._taskIdToToolUseId.get(tp.task_id)} tool=${tp.last_tool_name} summary=${tp.summary?.slice(0, 60)}`);
          this._handleSdkTaskProgress(tp);
        }

        if (message.type === "system" && (message as any).subtype === "task_updated") {
          const tu = message as any;
          console.log(`[SDK] Task updated: id=${tu.task_id} patch=${JSON.stringify(tu.patch || {}).slice(0, 160)}`);
          this._handleSdkTaskUpdated(tu);
        }

        if (message.type === "system" && (message as any).subtype === "background_tasks_changed") {
          const btc = message as any;
          console.log(`[SDK] Background task snapshot: count=${Array.isArray(btc.tasks) ? btc.tasks.length : 0}`);
          this._handleSdkBackgroundTasksChanged(btc);
        }

        // Forward API retry events (#10 — defensive, needs SDK v0.2.77+)
        if (message.type === "system" && (message as any).subtype === "api_retry") {
          const ar = message as any;
          const delayMs = claudeApiRetryDelayMs(ar);
          console.log(`[SDK] API retry: attempt=${ar.attempt}/${ar.max_retries} delay=${delayMs}ms`);
          this.send({
            type: "api_retry",
            attempt: ar.attempt || 0,
            maxRetries: ar.max_retries || 0,
            delayMs,
            errorStatus: ar.error_status || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward hook lifecycle messages
        if (message.type === "system" && (message as any).subtype === "hook_started") {
          const hs = message as any;
          console.log(`[SDK] Hook started: ${hs.hook_name} (${hs.hook_event})`);
          this.send({
            type: "hook_started",
            hookId: hs.hook_id || "",
            hookName: hs.hook_name || "",
            hookEvent: hs.hook_event || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        if (message.type === "system" && (message as any).subtype === "hook_progress") {
          const hp = message as any;
          this.send({
            type: "hook_progress",
            hookId: hp.hook_id || "",
            hookName: hp.hook_name || "",
            hookEvent: hp.hook_event || "",
            stdout: hp.stdout || "",
            stderr: hp.stderr || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        if (message.type === "system" && (message as any).subtype === "hook_response") {
          const hr = message as any;
          console.log(`[SDK] Hook response: ${hr.hook_name} (${hr.hook_event}) outcome=${hr.outcome}`);
          this.send({
            type: "hook_response",
            hookId: hr.hook_id || "",
            hookName: hr.hook_name || "",
            hookEvent: hr.hook_event || "",
            stdout: hr.stdout || "",
            stderr: hr.stderr || "",
            exitCode: hr.exit_code,
            outcome: hr.outcome || "success",
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward session state changes (idle/running/requires_action)
        if (message.type === "system" && (message as any).subtype === "session_state_changed") {
          const sc = message as any;
          const state = sc.state || "idle";
          console.log(`[SDK] Session state: ${state}`);
          this.send({
            type: "session_state_changed",
            state,
            sessionId: this.sessionId || "",
            ...(this.activeStartedAt ? { activeStartedAt: this.activeStartedAt } : {}),
          } as any);
        }

        // Forward CWD changes to app
        if (message.type === "system" && (message as any).subtype === "cwd_changed") {
          const cc = message as any;
          const oldCwd = cc.old_cwd || "";
          const newCwd = cc.new_cwd || cc.cwd || "";
          if (newCwd) {
            console.log(`[SDK] CWD changed: ${oldCwd} → ${newCwd}`);
            this.cwd = newCwd;
            this.send({
              type: "cwd_changed",
              oldCwd,
              newCwd,
              sessionId: this.sessionId || "",
            } as any);
            // Persist to history for restore on resume
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "assistant",
                content: `[cwd_changed:${newCwd}]`,
                timestamp: new Date().toISOString(),
              });
            }
            // Update session store
            const sessionInfo = this.sessionId ? getSession(this.sessionId) : undefined;
            if (sessionInfo) {
              sessionInfo.cwd = newCwd;
              saveSession(sessionInfo);
            }
          }
        }

        // Forward local command output (#11)
        if (message.type === "system" && (message as any).subtype === "local_command_output") {
          const lco = message as any;
          console.log(`[SDK] Local command output: ${lco.content?.slice(0, 80)}`);
          this.send({
            type: "local_command_output",
            content: lco.content || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward prompt suggestions (#12)
        if (message.type === "prompt_suggestion") {
          const ps = message as any;
          const suggestion = ps.suggestion || "";
          console.log(`[SDK] Prompt suggestion: ${suggestion.slice(0, 80)}`);
          this.send({
            type: "prompt_suggestion",
            suggestion,
            sessionId: this.sessionId || "",
          } as any);
          // Persist in session history so it can be restored on resume
          if (this.sessionId && suggestion) {
            appendHistory(this.sessionId, {
              role: "prompt_suggestion",
              content: suggestion,
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            const parentToolUseId = (message as any).parent_tool_use_id || null;
            if (!parentToolUseId) currentText += event.delta.text;
            const streamId = this._appendLiveStream(
              this._streamingText,
              message,
              event.delta.text,
            );
            const accumulated = this._streamingText.get(streamId)?.content || event.delta.text;
            this._streamingThinking.delete(streamId);
            this.send({
              type: "text",
              content: accumulated,
              sessionId: this.sessionId || "",
              streamId,
              snapshot: true,
              parentToolUseId,
              uuid: (message as any).uuid || undefined,
            });
          }

          // Stream thinking deltas to client
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            const streamId = this._appendLiveStream(
              this._streamingThinking,
              message,
              event.delta.thinking || "",
            );
            const accumulated = this._streamingThinking.get(streamId)?.content
              || event.delta.thinking
              || "";
            // The API emits thinking_delta events carrying only a signature when
            // the thinking text itself is withheld. Forwarding those would render
            // an empty thinking bubble that never fills in.
            if (accumulated.trim()) {
              this.send({
                type: "thinking",
                content: accumulated,
                sessionId: this.sessionId || "",
                streamId,
                snapshot: true,
                parentToolUseId: (message as any).parent_tool_use_id || null,
                uuid: (message as any).uuid || undefined,
              });
            }
          }

          // Track per-turn usage from message_start (input tokens for this turn)
          if (
            !(message as any).parent_tool_use_id &&
            event?.type === "message_start" &&
            event.message?.usage
          ) {
            const u = event.message.usage;
            lastTurnInputTokens = u.input_tokens || 0;
            lastTurnCacheReadTokens = u.cache_read_input_tokens || 0;
            lastTurnCacheCreateTokens = u.cache_creation_input_tokens || 0;
            lastTurnOutputTokens = 0; // Reset, will be set by message_delta
            console.log(`[Usage] message_start: input=${lastTurnInputTokens} cacheRead=${lastTurnCacheReadTokens} cacheCreate=${lastTurnCacheCreateTokens}`);
            // Send mid-query usage update to the app
            this.send({
              type: "usage_update",
              inputTokens: lastTurnInputTokens,
              outputTokens: 0,
              cacheReadTokens: lastTurnCacheReadTokens,
              cacheCreateTokens: lastTurnCacheCreateTokens,
              contextWindow: this._lastContextWindow,
              sessionId: this.sessionId || "",
            } as any);
          }

          // Track output tokens from message_delta (end of turn)
          if (
            !(message as any).parent_tool_use_id &&
            event?.type === "message_delta" &&
            event.usage
          ) {
            lastTurnOutputTokens = event.usage.output_tokens || 0;
            console.log(`[Usage] message_delta: output=${lastTurnOutputTokens}`);
            // Send updated usage with output tokens so the app can display them in real-time
            this.send({
              type: "usage_update",
              inputTokens: lastTurnInputTokens,
              outputTokens: lastTurnOutputTokens,
              cacheReadTokens: lastTurnCacheReadTokens,
              cacheCreateTokens: lastTurnCacheCreateTokens,
              contextWindow: this._lastContextWindow,
              sessionId: this.sessionId || "",
            } as any);
          }

          if (event?.type === "message_stop") {
            this._finishSdkMessageStream(message);
          }
        }

        if (message.type === "assistant") {
          // Surface per-message error types (rate_limit, auth_failed, billing_error, etc.)
          const assistantError = (message as any).error;
          if (assistantError) {
            console.error(`[SDK] Assistant error: ${assistantError}`);
            if (assistantError === 'authentication_failed') {
              this._authErrorSent = true;
              this._startAuthLogin().then((url) => {
                if (url) {
                  this.send({
                    type: "claude_auth",
                    url,
                    sessionId: this.sessionId || "",
                  } as any);
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[claude_auth:${url}]`,
                      timestamp: now(),
                    });
                  }
                } else {
                  this.send({
                    type: "error",
                    message: `Authentication failed. Run \`claude auth login\` on the server to re-authenticate.`,
                    errorType: assistantError,
                    sessionId: this.sessionId || "",
                  } as any);
                }
              }).catch(() => {
                this.send({
                  type: "error",
                  message: `Authentication failed. Run \`claude auth login\` on the server to re-authenticate.`,
                  errorType: assistantError,
                  sessionId: this.sessionId || "",
                } as any);
              });
            } else {
              this.send({
                type: "error",
                message: `Assistant error: ${assistantError}`,
                errorType: assistantError,
                sessionId: this.sessionId || "",
              } as any);
            }
          }

          const apiMessage = (message as any).message;
          const completedThinkingParts = apiMessage?.content && Array.isArray(apiMessage.content)
            ? apiMessage.content
              .filter((b: any) => b.type === "thinking")
              .map((b: any) => b.thinking || b.text || "")
            : [];
          const thinkingStreamId = this._streamKey(message);
          const thinkingStream = this._streamingThinking.get(thinkingStreamId);
          const isRootMessage = !(message as any).parent_tool_use_id;
          const progress = isRootMessage ? this._thinkingProgress : null;
          const thinkingContent = completedThinkingParts.join("")
            || thinkingStream?.content
            || "";
          if (thinkingStream || progress || thinkingContent.trim()) {
            const startCandidates = [
              thinkingStream?.startedAtMs,
              progress?.startedAtMs,
            ].filter((value): value is number => typeof value === "number");
            const startedAtMs = startCandidates.length > 0
              ? Math.min(...startCandidates)
              : Date.now();
            const thinkingDurationMs = Math.max(1, Date.now() - startedAtMs);
            const thinkingTokens = Math.max(0, progress?.estimatedTokens || 0);
            const thinkingTimestamp = new Date(startedAtMs).toISOString();
            this.send({
              type: "thinking",
              content: thinkingContent,
              sessionId: this.sessionId || "",
              streamId: thinkingStreamId,
              snapshot: true,
              finalSnapshot: true,
              thinkingDurationMs,
              ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
              timestamp: thinkingTimestamp,
              parentToolUseId: (message as any).parent_tool_use_id || null,
              uuid: (message as any).uuid || progress?.uuid || undefined,
            } as any);
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "assistant",
                content: thinkingContent,
                thinking: true,
                streamId: thinkingStreamId,
                thinkingDurationMs,
                ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
                parentToolUseId: (message as any).parent_tool_use_id || null,
                uuid: (message as any).uuid || progress?.uuid || undefined,
                timestamp: thinkingTimestamp,
              });
            }
          }
          if (isRootMessage) this._thinkingProgress = null;
          const completedTextParts = apiMessage?.content && Array.isArray(apiMessage.content)
            ? apiMessage.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
            : [];
          if (completedTextParts.length > 0) {
            if (!(message as any).parent_tool_use_id) {
              sawMainAssistantText = true;
            }
            this.send({
              type: "text",
              content: completedTextParts.join(""),
              sessionId: this.sessionId || "",
              streamId: this._streamKey(message),
              snapshot: true,
              finalSnapshot: true,
              parentToolUseId: (message as any).parent_tool_use_id || null,
              uuid: (message as any).uuid || undefined,
            } as any);
          }
          // Only close the stream that produced this assistant message. Other
          // subagents can still be streaming concurrently.
          this._clearLiveStreamsForMessage(message);
          // Log the full assistant text once the message is complete
          // Skip persisting the raw error text when auth login is being handled
          console.log(`[SDK] Assistant message: content_blocks=${apiMessage?.content?.length || 0} types=${apiMessage?.content?.map((b: any) => b.type).join(',') || 'none'}`);
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            // Extract full text from assistant message
            const textParts = completedTextParts;
            if (textParts.length > 0) {
              if (!(message as any).parent_tool_use_id) {
                this._lastPreview = textParts.join("").slice(0, 200);
              }
              this.onActivity?.();
              if (this.sessionId && !this._authErrorSent) {
                appendHistory(this.sessionId, {
                  role: "assistant",
                  content: textParts.join(""),
                  streamId: this._streamKey(message),
                  parentToolUseId: (message as any).parent_tool_use_id || null,
                  uuid: (message as any).uuid || undefined,
                  timestamp: now(),
                });
              }
            }

            for (const block of apiMessage.content) {
              if (block.type === "tool_use") {
                if ((message as any).parent_tool_use_id) {
                  this._toolParentIds.set(block.id, (message as any).parent_tool_use_id);
                }
                // Don't send AskUserQuestion as a tool_call — it's handled
                // via canUseTool and rendered as a proper question card
                if (block.name === "AskUserQuestion") {
                  this._suppressedToolResultIds.add(block.id);
                  continue;
                }

                // Intercept TodoWrite — diff against stored state, only send if changed
                if (block.name === "TodoWrite") {
                  this._suppressedToolResultIds.add(block.id);
                  const todos = (block.input as any)?.todos;
                  if (Array.isArray(todos)) {
                    const prev = this.sessionId ? getTodos(this.sessionId) : [];
                    const next = replaceClaudeTodoWriteTodos(prev, todos);
                    const changed = JSON.stringify(next) !== JSON.stringify(prev);
                    if (this.sessionId) {
                      saveTodos(this.sessionId, next);
                      if (changed) {
                        appendHistory(this.sessionId, {
                          role: "todos_update",
                          content: JSON.stringify(next),
                          timestamp: now(),
                        });
                      }
                    }
                    if (changed) {
                      this.send({
                        type: "todos",
                        todos: next,
                        sessionId: this.sessionId || "",
                      } as any);
                    }
                  }
                  continue;
                }

                // Send MCP tool calls (Speak, SendFile, ScheduleReminder) for UI display
                const mcpName = block.name.replace("mcp__app__", "");
                if (mcpName === "Speak" || mcpName === "SendFile" || mcpName === "ScheduleReminder") {
                  this.send({
                    type: "tool_call",
                    tool: mcpName,
                    input: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    sessionId: this.sessionId || "",
                    parentToolUseId: (message as any).parent_tool_use_id || null,
                    uuid: (message as any).uuid || undefined,
                  });
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "tool_call",
                      content: "",
                      toolName: mcpName,
                      toolInput: block.input as Record<string, unknown>,
                      toolUseId: block.id,
                      parentToolUseId: (message as any).parent_tool_use_id || null,
                      uuid: (message as any).uuid || undefined,
                      timestamp: now(),
                    });
                  }
                  continue;
                }

                console.log(`[SDK] >>> tool_call: ${block.name} toolUseId=${block.id}`);
                // Track the currently-executing tool call
                this._activeToolUseId = block.id;
                this._activeToolName = block.name;
                this.send({
                  type: "tool_call",
                  tool: block.name,
                  input: block.input as Record<string, unknown>,
                  toolUseId: block.id,
                  sessionId: this.sessionId || "",
                  parentToolUseId: (message as any).parent_tool_use_id || null,
                  uuid: (message as any).uuid || undefined,
                });

                // Update preview with tool call description
                const inp = block.input as Record<string, unknown>;
                const previewDesc = (inp.file_path as string) || (inp.command as string) || (inp.pattern as string) || (inp.query as string) || (inp.prompt as string) || "";
                this._lastPreview = `[${block.name}] ${previewDesc}`.slice(0, 200);
                this.onActivity?.();

                // Track Read tool file paths for image extraction
                if (block.name === "Read") {
                  const filePath = (block.input as any)?.file_path || "";
                  if (filePath) {
                    this._readToolPaths.set(block.id, filePath);
                  }
                }

                // Start watching the global bash log file for streaming output
                // Start watching for bash output — file path derived from tool_use_id
                // (matches the path the PreToolUse hook uses for tee wrapping)
                if (block.name === "Bash") {
                  this._startBashWatcher(`/tmp/claude-bash-${block.id}.log`);
                }

                // Track all Agent (subagent) tool calls (renamed from "Task" in SDK 0.2.76)
                if (block.name === "Agent" || block.name === "Task") {
                  const desc = (block.input as any)?.description || "Agent";
                  const subagentType = (block.input as any)?.subagent_type || "";
                  // Claude Code 2.1.198+ backgrounds Agent calls by default.
                  // Only an explicit false means this invocation is foreground.
                  const isBackgrounded = claudeAgentRunsInBackground(block.input);
                  const mappedAgentId = Array.from(this._taskIdToToolUseId.entries())
                    .find(([, mappedToolUseId]) => mappedToolUseId === block.id)?.[0];
                  this._activeSubagents.set(block.id, {
                    ...(mappedAgentId ? { agentId: mappedAgentId } : {}),
                    toolUseId: block.id,
                    description: desc,
                    subagentType,
                    startedAt: now(),
                    prompt: String((block.input as any)?.prompt || ""),
                    isBackgrounded,
                    status: "running",
                    ...((message as any).parent_tool_use_id
                      ? { parentToolUseId: (message as any).parent_tool_use_id }
                      : {}),
                  });
                  console.log(`[SDK] Subagent started: ${desc} (toolUseId=${block.id}, type=${subagentType}, background=${isBackgrounded})`);
                }

                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_call",
                    content: "",
                    toolName: block.name,
                    toolInput: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    parentToolUseId: (message as any).parent_tool_use_id || null,
                    uuid: (message as any).uuid || undefined,
                    timestamp: now(),
                  });
                }
              }
            }
          }
        }

        if (message.type === "user") {
          // Forward user message UUID to app for rewind support
          // Only for real user prompts, not synthetic tool result messages
          const userMsgUuid = (message as any).uuid || undefined;
          if (userMsgUuid && isLiveClaudeUserEcho(message)) {
            this.send({
              type: "user_message_uuid",
              uuid: userMsgUuid,
              sessionId: this.sessionId || "",
            } as any);
          }
          const apiMessage = (message as any).message;
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              if (block.type === "tool_result") {
                const toolUseId = block.tool_use_id || "";

                // Skip results for suppressed tools (TodoWrite, AskUserQuestion)
                if (this._suppressedToolResultIds.has(toolUseId)) {
                  this._suppressedToolResultIds.delete(toolUseId);
                  continue;
                }

                let output =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n")
                      : JSON.stringify(block.content);
                const subagentState = this._activeSubagents.get(toolUseId);
                const structuredToolOutput = (message as any).tool_use_result
                  && typeof (message as any).tool_use_result === "object"
                  ? (message as any).tool_use_result as any
                  : undefined;
                const structuredAgentOutput = subagentState
                  ? structuredToolOutput
                  : undefined;
                let backgroundPending = false;
                if (isClaudeWorkflowLaunchOutput(structuredToolOutput)) {
                  this._trackWorkflowLaunch(structuredToolOutput, toolUseId);
                  backgroundPending = true;
                } else if (subagentState && isClaudeAgentLaunchOutput(structuredAgentOutput)) {
                  const isRemote = structuredAgentOutput.status === "remote_launched";
                  const agentId = String(
                    (isRemote ? structuredAgentOutput.taskId : structuredAgentOutput.agentId)
                    || subagentState.agentId
                    || "",
                  );
                  if (agentId) {
                    subagentState.agentId = agentId;
                    this._sdkTaskIds.add(agentId);
                    this._taskIdToToolUseId.set(agentId, toolUseId);
                    this._sdkBackgroundTasks.set(agentId, {
                      taskId: agentId,
                      taskType: isRemote ? "remote_agent" : "local_agent",
                      description: String(structuredAgentOutput.description || subagentState.description),
                    });
                  }
                  subagentState.description = String(structuredAgentOutput.description || subagentState.description);
                  subagentState.prompt = String(structuredAgentOutput.prompt || subagentState.prompt || "");
                  subagentState.resolvedModel = String(structuredAgentOutput.resolvedModel || "") || undefined;
                  subagentState.isBackgrounded = true;
                  subagentState.status = "running";
                  const outputFile = String(structuredAgentOutput.outputFile || "");
                  if (agentId && outputFile) this._taskOutputFiles.set(agentId, outputFile);
                  backgroundPending = true;
                } else if (subagentState && structuredAgentOutput?.status === "completed") {
                  const report = Array.isArray(structuredAgentOutput.content)
                    ? structuredAgentOutput.content
                      .filter((part: any) => part?.type === "text")
                      .map((part: any) => String(part.text || ""))
                      .join("\n")
                    : "";
                  if (report) output = report;
                  subagentState.status = "completed";
                  subagentState.resolvedModel = String(structuredAgentOutput.resolvedModel || "") || undefined;
                  subagentState.usage = {
                    totalTokens: Number(structuredAgentOutput.totalTokens || 0),
                    toolUses: Number(structuredAgentOutput.totalToolUseCount || 0),
                    durationMs: Number(structuredAgentOutput.totalDurationMs || 0),
                  };
                } else if (subagentState?.isBackgrounded) {
                  // Compatibility fallback for an older emitter that lacks
                  // structured AgentOutput. Current SDKs use async_launched.
                  backgroundPending = /(?:async|background|launched|output file)/i.test(output);
                }

                // Extract image blocks from tool results (e.g., Read on image files)
                if (Array.isArray(block.content)) {
                  for (const c of block.content as any[]) {
                    if (c.type === "image" && c.source?.type === "base64") {
                      const sourcePath = this._readToolPaths.get(toolUseId) || "";
                      const mimeType = c.source.media_type || "image/png";
                      let filePath = sourcePath;
                      try {
                        const bytes = Buffer.from(c.source.data, "base64");
                        if (this.sessionId) {
                          filePath = cacheToolImage(
                            this.sessionId,
                            toolUseId,
                            bytes,
                            mimeType,
                            sourcePath,
                          );
                        }
                      } catch (err: any) {
                        console.warn(`[SDK] Failed to cache tool image: ${err?.message || String(err)}`);
                      }
                      console.log(`[SDK] Image block found in tool result: ${sourcePath || toolUseId}`);
                      this.send({
                        type: "tool_image",
                        toolUseId,
                        imageData: c.source.data,
                        mimeType,
                        filePath,
                        sessionId: this.sessionId || "",
                      });
                      // Persist file path reference to history (NOT the base64 data)
                      if (this.sessionId) {
                        appendHistory(this.sessionId, {
                          role: "tool_image",
                          content: "",
                          toolUseId,
                          filePath,
                          mimeType,
                          timestamp: now(),
                        });
                      }
                    }
                  }
                  // Clean up tracked path
                  this._readToolPaths.delete(toolUseId);
                }

                // Detect bash command moved to background (timeout)
                const bgMatch = output.match(/Command running in background with ID: (\S+)\. Output is being written to: (\S+)/);
                if (bgMatch && this._activeBashStream) {
                  backgroundPending = true;
                  const bgTaskId = bgMatch[1];
                  const outputFile = bgMatch[2];
                  console.log(`[SDK] Bash moved to background: taskId=${bgTaskId}, outputFile=${outputFile}, toolUseId=${toolUseId}`);

                  // Track output file for Monitor toggle mode
                  this._taskOutputFiles.set(bgTaskId, outputFile);

                  // Stop the active bash watcher (will be replaced by next tool's watcher)
                  this._stopBashWatcher();

                  // Start an independent watcher that survives next tool calls
                  this._startBgBashWatcher(bgTaskId, toolUseId, outputFile);

                  // Send a background notification so the app tracks it
                  this.send({
                    type: "bash_backgrounded",
                    toolUseId,
                    taskId: bgTaskId,
                    outputFile,
                    sessionId: this.sessionId || "",
                  } as any);

                  // task_id ↔ tool_use_id mapping handled by task_started SDK message

                  // Don't replace card content — just send the tool_result normally
                  // but the app will handle it specially
                } else {
                  // Stop bash output watcher — tool finished normally
                  this._stopBashWatcher();
                }

                // A background Agent tool result is only the launch
                // acknowledgement. Its terminal task_notification owns
                // completion. Foreground Agent results complete immediately.
                if (this._activeSubagents.has(toolUseId)) {
                  const info = this._activeSubagents.get(toolUseId)!;
                  if (backgroundPending) {
                    console.log(`[SDK] Subagent backgrounded: ${info.description} (toolUseId=${toolUseId}, taskId=${info.agentId || "pending"})`);
                  } else {
                    console.log(`[SDK] Subagent completed: ${info.description} (toolUseId=${toolUseId})`);
                    this._activeSubagents.delete(toolUseId);
                  }
                }

                // Clear active tool tracking — tool has completed
                this._activeToolUseId = null;
                this._activeToolName = null;

                // Stream large tool output in chunks for progressive rendering
                const CHUNK_THRESHOLD = 500; // Only chunk if output > 500 chars
                const CHUNK_SIZE = 200; // ~200 chars per chunk (roughly 3-4 lines)
                const parentId = (message as any).parent_tool_use_id || null;
                const msgUuid = (message as any).uuid || undefined;
                if (output.length > CHUNK_THRESHOLD) {
                  const numChunks = Math.ceil(output.length / CHUNK_SIZE);
                  console.log(`[SDK] <<< tool_result_chunk: toolUseId=${toolUseId} len=${output.length} chunks=${numChunks}`);
                  let chunkIdx = 0;
                  for (let i = 0; i < output.length; i += CHUNK_SIZE) {
                    this.send({
                      type: "tool_result_chunk",
                      toolUseId,
                      chunkIndex: chunkIdx++,
                      content: output.slice(i, i + CHUNK_SIZE),
                      done: i + CHUNK_SIZE >= output.length,
                      sessionId: this.sessionId || "",
                      parentToolUseId: parentId,
                    } as any);
                  }
                } else {
                  console.log(`[SDK] <<< tool_result: toolUseId=${toolUseId} len=${output.length}`);
                  this.send({
                    type: "tool_result",
                    toolUseId,
                    output,
                    backgroundPending,
                    sessionId: this.sessionId || "",
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                  });
                }

                if (isCancelledToolResult(output)) {
                  this._reportCancelledTool(toolUseId, parentId);
                }
                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_result",
                    content: "",
                    toolUseId: block.tool_use_id || "",
                    toolOutput: output,
                    backgroundPending,
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                    timestamp: now(),
                  });
                }
                if (!bgMatch && !backgroundPending) {
                  this._toolParentIds.delete(toolUseId);
                }
                if (subagentState) {
                  this._emitActiveSubagentsSnapshot();
                  this.onActivity?.();
                }
              }
            }
          }
        }

        if (message.type === "result") {
          const result = message as any;
          const resultParentId = result.parent_tool_use_id || null;
          if (resultParentId) {
            console.log(`[SDK] Subagent result (parent_tool_use_id=${resultParentId}), subtype=${result.subtype}, cost=${result.total_cost_usd}, turns=${result.num_turns}`);
            // Send as subagent_result so the app can track it without mistaking it for the main query result
            this.send({
              type: "subagent_result",
              parentToolUseId: resultParentId,
              content: result.result || "",
              costUsd: result.total_cost_usd,
              durationMs: result.duration_ms,
              numTurns: result.num_turns,
              stopReason: result.stop_reason || undefined,
              subtype: result.subtype || undefined,
              terminalReason: result.terminal_reason || undefined,
              sessionId: this.sessionId || "",
            } as any);
            continue;
          }
          if (isClaudeTaskNotificationResult(result)) {
            // Claude may synthesize a main-thread follow-up after background
            // work completes. Its assistant content has already streamed, but
            // this Result is not the completion of a phone-authored prompt:
            // do not resolve a pending turn, emit a second "session finished",
            // or overwrite the user's last-result bookkeeping.
            console.log(`[SDK] Background task follow-up result: subtype=${result.subtype} turns=${result.num_turns}`);
            currentText = "";
            sawMainAssistantText = false;
            this.onActivity?.();
            continue;
          }
          lastResultContent =
            result.result || currentText || "Task completed.";
          console.log(`[SDK] Result: subtype=${result.subtype} num_turns=${result.num_turns} result_len=${result.result?.length || 0} currentText_len=${currentText.length}`);

          // For slash commands / local commands: if result has content but no text
          // was streamed during this query, send the result as a text message
          if (shouldEmitClaudeResultFallback(
            result.result,
            currentText,
            sawMainAssistantText,
          )) {
            console.log(`[SDK] Slash command result: ${result.result.slice(0, 100)}`);
            this.send({
              type: "text",
              content: result.result,
              sessionId: this.sessionId || "",
            });
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "assistant",
                content: result.result,
                timestamp: now(),
              });
            }
          }

          // Use last turn's per-turn usage (from stream events) for current context size.
          // modelUsage contains cumulative totals across ALL turns — not useful for context fill.
          let contextWindow = 0;
          if (result.modelUsage) {
            for (const model of Object.values(result.modelUsage) as any[]) {
              if (model.contextWindow > contextWindow) {
                contextWindow = model.contextWindow;
              }
            }
          }
          // Cache contextWindow for mid-query usage updates in future queries
          if (contextWindow > 0) {
            this._lastContextWindow = contextWindow;
          }
          console.log(`[Usage] Last turn: input=${lastTurnInputTokens} output=${lastTurnOutputTokens} cacheRead=${lastTurnCacheReadTokens} cacheCreate=${lastTurnCacheCreateTokens} contextWindow=${contextWindow}`);

          const usageInfo = {
            inputTokens: lastTurnInputTokens,
            outputTokens: lastTurnOutputTokens,
            cacheReadTokens: lastTurnCacheReadTokens,
            cacheCreateTokens: lastTurnCacheCreateTokens,
            contextWindow,
          };

          // Total usage across ALL turns (from SDK result.usage)
          const totalUsage = result.usage ? {
            inputTokens: result.usage.inputTokens || 0,
            outputTokens: result.usage.outputTokens || 0,
            cacheReadTokens: result.usage.cacheReadInputTokens || 0,
            cacheCreateTokens: result.usage.cacheCreationInputTokens || 0,
            costUsd: result.usage.costUSD || 0,
          } : undefined;

          // "next" context is normally delivered by PostToolBatch. A
          // text-only turn has no such boundary, so continue the same live
          // run with a fresh SDK input turn instead of resolving the phone
          // prompt and sending a false completion notification.
          const pendingContinuation = this._takePendingBoundaryContext();
          let continuationPending = false;
          if (pendingContinuation.length > 0 && this.activeInputQueue) {
            try {
              for (const userMessage of createClaudeContinuationMessages(
                pendingContinuation,
                this.sessionId || "",
              )) {
                this.activeInputQueue.push(userMessage);
              }
              continuationPending = true;
              console.log(
                `[Inject] Continuing after result with ${pendingContinuation.length} queued message(s)`,
              );
            } catch (error) {
              this._pendingBoundaryContext.unshift(...pendingContinuation);
              console.error(`[Inject] Failed to start continuation: ${error}`);
            }
          }

          this.send({
            type: "result",
            content: lastResultContent,
            sessionId: this.sessionId || "",
            continuationPending: continuationPending || undefined,
            costUsd: result.total_cost_usd,
            durationMs: result.duration_ms,
            durationApiMs: result.duration_api_ms || undefined,
            usage: usageInfo,
            totalUsage,
            numTurns: result.num_turns,
            stopReason: result.stop_reason || undefined,
            resultSubtype: result.subtype || undefined,
            terminalReason: result.terminal_reason || undefined,
            fastModeState: result.fast_mode_state || undefined,
            errors: result.errors?.length ? result.errors : undefined,
            permissionDenials: result.permission_denials?.length ? result.permission_denials : undefined,
          });

          this._lastPreview = lastResultContent.slice(0, 200);

          if (this.sessionId) {
            const usageWithCost = usageInfo
              ? { ...usageInfo, costUsd: result.total_cost_usd, numTurns: result.num_turns }
              : undefined;
            updateSessionActivity(this.sessionId, lastResultContent, usageWithCost);
          }

          // Fetch detailed context usage breakdown from SDK (async, non-blocking)
          if (this.activeQuery) {
            this.activeQuery.getContextUsage().then((ctx: any) => {
              if (ctx) {
                this.send({
                  type: "context_usage",
                  sessionId: this.sessionId || "",
                  ...ctx,
                } as any);
                if (this.sessionId) updateSessionContextUsage(this.sessionId, ctx);
              }
            }).catch(() => {});
            this._refreshPlanRateLimits();
          }

          if (continuationPending) {
            currentText = "";
            sawMainAssistantText = false;
            lastTurnInputTokens = 0;
            lastTurnOutputTokens = 0;
            lastTurnCacheReadTokens = 0;
            lastTurnCacheCreateTokens = 0;
            this.onActivity?.();
            continue;
          }

          this._isRunning = false;
          this._runStartedAt = null;
          if (CLAUDE_WARM_IDLE_TIMEOUT_MS > 0) {
            this._enterWarmIdle();
          } else {
            this.activeInputQueue?.close();
            try { this.activeQuery?.close(); } catch {}
          }
          this._resolvePendingTurn();
          this.onActivity?.();
          currentText = "";
          sawMainAssistantText = false;
        }
      }
    } catch (err: unknown) {
      const errMsg = formatClaudeQueryError(err, "Unknown error during query", this.cwd);
      console.error("Query error:", errMsg);
      if (err instanceof Error && err.stack) console.error(err.stack);
      this._rejectPendingTurns(new Error(errMsg));

      // Skip if we already sent a login URL for this auth failure
      if (!this._authErrorSent) {
        this.send({
          type: "error",
          message: errMsg,
        });
      }
    } finally {
      this._pendingBoundaryContext = [];
      if (this._activeSubagents.size > 0 || this._sdkBackgroundTasks.size > 0) {
        this._resetSdkTaskTracking(
          this._stopRequested ? "stopped" : "failed",
          this._stopRequested
            ? "Stopped by user"
            : "Claude SDK process ended before the task reported completion",
        );
      }
      this._leaveWarmIdle();
      this._isRunning = false;
      this._isWarmIdle = false;
      this._isCompacting = false;
      this._runStartedAt = null;
      this._compactStartedAt = null;
      this._pendingBoundaryContext = [];
      this.activeInputQueue?.close();
      this.activeInputQueue = null;
      try { this.activeQuery?.close(); } catch {}
      this.activeQuery = null;
      this._rejectPendingTurns(new Error("Claude SDK stream closed"));
      this.onActivity?.();
      this.onClose?.();
    }
      };
      void consumeQuery();
      return initialTurnPromise;
    } catch (err: unknown) {
      const errMsg = formatClaudeQueryError(err, "Unknown error starting query", this.cwd);
      console.error("Query setup error:", errMsg);
      if (err instanceof Error && err.stack) console.error(err.stack);
      this._leaveWarmIdle();
      this._isRunning = false;
      this._isWarmIdle = false;
      this._isCompacting = false;
      this._runStartedAt = null;
      this._compactStartedAt = null;
      this.activeInputQueue?.close();
      this.activeInputQueue = null;
      this.activeQuery = null;
      this._rejectPendingTurns(new Error(errMsg));
      if (!this._authErrorSent) {
        this.send({
          type: "error",
          message: errMsg,
        });
      }
      this.onActivity?.();
      this.onClose?.();
    }
  }

  /** Generate our own OAuth PKCE auth URL (no CLI subprocess needed). */
  private _startAuthLogin(): Promise<string | null> {
    this._authRequest = createClaudeAuthRequest();
    console.log(`[Auth] Generated OAuth URL: ${this._authRequest.authUrl}`);
    console.log(`[Auth] code_verifier: ${this._authRequest.codeVerifier.substring(0, 10)}...`);
    return Promise.resolve(this._authRequest.authUrl);
  }

  /** Exchange the OAuth code for tokens and save to ~/.claude/.credentials.json */
  submitAuthCode(code: string): void {
    console.log(`[Auth] submitAuthCode called — pending=${!!this._authRequest}`);
    if (!this._authRequest) {
      console.error("[Auth] No pending auth flow (missing code_verifier or state)");
      this.send({
        type: "error",
        message: "No pending login session. Try sending a message to trigger auth again.",
      });
      return;
    }

    const request = this._authRequest;
    exchangeClaudeAuthCode(request, code)
      .then(() => {
      console.log("[Auth] Saved Claude OAuth tokens");
      this._sendAuthResult(true);
    })
      .catch((e: any) => {
      console.error(`[Auth] Claude auth failed: ${e.message}`);
      this.send({ type: "error", message: `Authentication failed: ${e.message}` });
      this._sendAuthResult(false);
    });
  }

  private _sendAuthResult(success: boolean): void {
    this._authRequest = null;
    this.send({
      type: "claude_auth_result",
      success,
      sessionId: this.sessionId || "",
    } as any);
    if (this.sessionId) {
      appendHistory(this.sessionId, {
        role: "assistant",
        content: `[claude_auth_result:${success ? "success" : "failure"}]`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
