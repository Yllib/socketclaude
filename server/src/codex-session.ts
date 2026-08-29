/**
 * Codex backend mirroring claude-session.ts. Drives the OpenAI Codex app-server
 * protocol under the user's ChatGPT subscription (auth_mode: "chatgpt" in
 * ~/.codex/auth.json — no API key required).
 */

import { spawnSync } from "child_process";
import { WebSocket } from "ws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentSessionSettings,
  ServerMessage,
  Backend,
  SessionInfo,
  HistoryEntry,
  CodexDriver,
  CodexGoal,
  CodexGoalStatus,
} from "./protocol";
import { SessionContext, SocketAgentPlugin } from "./plugin-api";
import {
  saveSession,
  getSession,
  appendHistory,
  appendHistoryBulk,
  appendSdkEvent,
  updateSessionActivity,
  updateSessionContextUsage,
  updateSessionAgentSettings,
  remapSession,
  cacheToolImage,
  markQuestionAnswered,
  positionSessionMessage,
  clearSessionPendingHandoffContext,
} from "./session-store";
import type { ClaudeSession } from "./claude-session";
import { AppToolContext, stopAppMonitor, stopAppMonitorsForSession } from "./app-tool-handlers";
import type {
  AgentSessionToolExecutor,
  DelegatedAgentLiveActivity,
} from "./delegated-agent-types";
import { registerCodexAppMcp, SOCKETAGENT_APP_TOOLS } from "./codex-app-mcp";
import { buildSocketAgentIntegrationInstructions } from "./socketagent-instructions";
import { pendingSecureInputMessagesForSession, redactSecretsDeep, secureInputInventoryForAgent } from "./secure-input-store";
import { SessionEventDelivery } from "./session-event-delivery";
import { getCachedModelCatalog, modelCatalogIsFresh, saveCachedModelCatalog } from "./model-catalog-store";
import {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerClient,
  CodexAppServerRequestTimeoutError,
  CodexAppServerNotification,
  CodexAppServerRequestResponder,
  CodexAppServerUserInput,
} from "./codex-app-server-client";
import { buildCodexSpawn } from "./codex-env";
import { listSkills, SkillEntry } from "./skills-manager";
import { getClaudeAvailability } from "./claude-session";
import { maybeSendAgentAttentionPush } from "./push-notifications";
import { LatestSnapshotDispatcher } from "./latest-snapshot-dispatcher";
import { createInteractiveRequestId } from "./interactive-request-id";
import { buildCodexRateLimitEvents } from "./rate-limit-events";
import { recordRateLimitEvent } from "./rate-limit-cache";
import {
  recordSessionMemoryCompaction,
  recordSessionMemoryContextUsage,
  remapSessionMemory,
} from "./session-memory-store";

const TRANSIENT_CODEX_RAW_EVENT_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "turn/diff/updated",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
]);

function playReviewModeEnabled(): boolean {
  return process.env.SOCKETAGENT_PLAY_REVIEW_MODE === "1";
}

const CODEX_GOAL_STATUSES = new Set<CodexGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export function isTimedOutCodexThreadResume(
  error: unknown,
): error is CodexAppServerRequestTimeoutError {
  return error instanceof CodexAppServerRequestTimeoutError
    && error.method === "thread/resume";
}

export function isCodexActiveWriterError(error: unknown): boolean {
  const detail = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
  return /thread\b.*already has an active writer/i.test(detail || "");
}

function normalizeCodexGoal(value: unknown): CodexGoal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const threadId = typeof raw.threadId === "string" ? raw.threadId : "";
  const objective = typeof raw.objective === "string" ? raw.objective : "";
  const status = typeof raw.status === "string" && CODEX_GOAL_STATUSES.has(raw.status as CodexGoalStatus)
    ? raw.status as CodexGoalStatus
    : null;
  if (!threadId || !status) return null;
  const finiteInt = (candidate: unknown): number => {
    const number = Number(candidate);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  };
  const budget = raw.tokenBudget == null ? null : finiteInt(raw.tokenBudget);
  return {
    threadId,
    objective,
    status,
    tokenBudget: budget,
    tokensUsed: finiteInt(raw.tokensUsed),
    timeUsedSeconds: finiteInt(raw.timeUsedSeconds),
    createdAt: finiteInt(raw.createdAt),
    updatedAt: finiteInt(raw.updatedAt),
  };
}

function unwrapExecResultEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const isExecEnvelope = "output" in record && [
    "chunk_id",
    "session_id",
    "exit_code",
    "wall_time_seconds",
    "original_token_count",
  ].some((key) => key in record);
  if (!isExecEnvelope) return null;
  if (typeof record.output === "string") return record.output;
  return record.output == null ? "" : JSON.stringify(record.output, null, 2);
}

function dynamicToolContentText(value: unknown, depth = 0): string[] {
  if (value == null || depth > 4) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => dynamicToolContentText(item, depth + 1));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const execOutput = unwrapExecResultEnvelope(parsed);
        if (execOutput !== null) return execOutput ? [execOutput] : [];
        if (Array.isArray(parsed)
          || (parsed && typeof parsed === "object"
            && ["input_text", "output_text", "text"].includes(String(parsed.type || "")))) {
          return dynamicToolContentText(parsed, depth + 1);
        }
      } catch {
        // This is ordinary text that happens to begin with a JSON delimiter.
      }
    }
    return value ? [value] : [];
  }
  if (typeof value !== "object") return [String(value)];

  const record = value as Record<string, unknown>;
  const execOutput = unwrapExecResultEnvelope(record);
  if (execOutput !== null) return execOutput ? [execOutput] : [];
  if (typeof record.text === "string") {
    return dynamicToolContentText(record.text, depth + 1);
  }
  if (record.content != null) {
    const content = dynamicToolContentText(record.content, depth + 1);
    if (content.length > 0) return content;
  }
  const type = String(record.type || "").toLowerCase();
  if (type.includes("image")) return ["[image]"];
  if (typeof record.url === "string") return [record.url];
  return [JSON.stringify(record, null, 2)];
}

function formatDynamicToolOutput(item: any): string {
  const blocks = dynamicToolContentText(item?.contentItems)
    .map((block) => block.trimEnd())
    .filter((block) => block.trim().length > 0);
  if (blocks.length > 0) return blocks.join("\n");
  if (item?.success === false) {
    const errorBlocks = dynamicToolContentText(item?.error);
    return errorBlocks.length > 0 ? `Tool failed: ${errorBlocks.join("\n")}` : "Tool failed";
  }
  return "Tool completed";
}

function dynamicToolDisplayName(item: any): string {
  const tool = String(item?.tool || "tool");
  const namespace = String(item?.namespace || "");
  if (tool.toLowerCase() === "exec" && (!namespace || namespace === "functions")) {
    return "Exec";
  }
  return namespace ? `${namespace}/${tool}` : tool;
}

function shortPath(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const home = os.homedir().replace(/\/+$/, "");
  return raw === home ? "~" : raw.startsWith(`${home}/`) ? `~/${raw.slice(home.length + 1)}` : raw;
}

export function summarizeCodexCommandActions(
  actions: unknown,
  command: unknown,
): string {
  const summaries = (Array.isArray(actions) ? actions : [])
    .map((raw): string => {
      const action = raw && typeof raw === "object"
        ? raw as Record<string, unknown>
        : {};
      const type = String(action.type || "");
      if (type === "read") {
        const name = String(action.name || "").trim()
          || path.basename(String(action.path || ""));
        return name ? `Read ${name}` : "Read a file";
      }
      if (type === "listFiles") {
        const target = shortPath(action.path);
        return target ? `List files in ${target}` : "List files";
      }
      if (type === "search") {
        const query = String(action.query || "").trim();
        const target = shortPath(action.path);
        if (query && target) return `Search ${target} for ${query}`;
        if (query) return `Search for ${query}`;
        return target ? `Search ${target}` : "Search files";
      }
      return "";
    })
    .filter(Boolean);
  if (summaries.length > 0) {
    const visible = summaries.slice(0, 2).join(" · ");
    return summaries.length > 2 ? `${visible} · +${summaries.length - 2} more` : visible;
  }

  const rawCommand = String(command || "").trim();
  if (!rawCommand) return "Run command";
  const firstLine = rawCommand.split(/\r?\n/, 1)[0]
    .split(/\s*(?:&&|;|\|\|)\s*/, 1)[0]
    .trim();
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}…` : firstLine;
}
import {
  prepareCodexMcpElicitation,
  resolveCodexMcpElicitation,
} from "./codex-elicitation";

const now = (): string => new Date().toISOString();

const DEFAULT_CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
})();

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

type QueuedPrompt = {
  text: string;
  priority: "now" | "next" | "later";
  messageId?: string;
  fastMode?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingAppServerSteer = QueuedPrompt & {
  uuid: string;
  steerSent?: boolean;
  steerAttempts?: number;
};

function authoritativeTurnIdFromSteerError(error: unknown): string | null {
  const candidate = error as any;
  const structured = candidate?.data?.activeTurnId
    || candidate?.data?.currentTurnId
    || candidate?.error?.data?.activeTurnId
    || candidate?.error?.data?.currentTurnId;
  if (typeof structured === "string" && structured.trim()) return structured.trim();
  const message = String(candidate?.message || candidate || "");
  const match = message.match(/expected active turn id [`'"]?[^`'"\s]+[`'"]? but found [`'"]?([^`'"\s}]+)[`'"]?/i);
  return match?.[1]?.trim() || null;
}

export function codexAgentMessagePhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

interface PendingQuestion {
  questionId: string;
  resolve: (answers: Record<string, string>) => void;
  questionData?: ServerMessage;
}

interface ConnectedAppConfirmation {
  appKey: string;
  appLabel: string;
  approveLabel: string;
  sessionLabel: string;
}

function connectedAppConfirmation(
  question: string,
  options: Array<{ label?: string }> = [],
): ConnectedAppConfirmation | null {
  const match = question.trim().match(/^Allow\s+(.+?)\s+to\b/i);
  if (!match) return null;
  const approve = options.find((option) => /^(?:approve|allow|yes)$/i.test(String(option.label || "").trim()));
  const decline = options.find((option) => /^(?:decline|deny|reject|cancel|no)$/i.test(String(option.label || "").trim()));
  if (!approve || !decline) return null;
  const appLabel = match[1].trim();
  const appKey = appLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!appKey) return null;
  return {
    appKey,
    appLabel,
    approveLabel: String(approve.label).trim(),
    sessionLabel: `Allow ${appLabel} for this session`,
  };
}

export type CodexSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  availability?: "app-server" | "any";
};

type CodexRunOptions = {
  fastMode?: boolean;
  messageId?: string;
};

export const CODEX_NATIVE_SLASH_COMMANDS: CodexSlashCommand[] = [
  {
    name: "status",
    description: "Show Codex session status.",
    availability: "any",
  },
  {
    name: "compact",
    description: "Compact the current Codex thread.",
    availability: "app-server",
  },
  {
    name: "goal",
    description: "View, set, pause, resume, or clear the current goal.",
    argumentHint: "[text|pause|resume|clear]",
    availability: "app-server",
  },
  {
    name: "review",
    description: "Review uncommitted changes, or review with custom instructions.",
    argumentHint: "[instructions]",
    availability: "app-server",
  },
  {
    name: "mcp",
    description: "Show configured Codex MCP server status.",
    availability: "app-server",
  },
  {
    name: "model",
    description: "Show available models or set the active model.",
    argumentHint: "[model]",
    availability: "app-server",
  },
  {
    name: "permissions",
    description: "Show or set Codex permission mode.",
    argumentHint: "[ask|yolo|super-yolo|read-only]",
    availability: "any",
  },
  {
    name: "archive",
    description: "Archive the current Codex thread.",
    availability: "app-server",
  },
  {
    name: "fork",
    description: "Fork the current Codex thread.",
    availability: "app-server",
  },
];

export function isCodexAuthError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();

  return /\b(token_invalidated|invalidated|signing in again|sign in again|signed out)\b/i.test(message)
    || /\b(auth|authentication|authorize|authorization|login|sign[- ]?in|credential|token)\b.*\b(invalid|invalidated|expired|required|missing|failed|denied|unauthorized)\b/i.test(message)
    || /\b(invalid|invalidated|expired|required|missing|failed|denied|unauthorized)\b.*\b(auth|authentication|authorization|login|sign[- ]?in|credential|token)\b/i.test(message)
    || /\bnot authenticated\b/i.test(message)
    || /\bunauthorized\b/i.test(message)
    || /\b401\b/.test(message);
}

type CodexAuthScope = "openai" | "mcp" | "unknown";

export function isMcpAuthSignal(value: unknown): boolean {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return /\bmcp(?:Server)?\b|mcp client|codex_apps|reauthenticationRequired/i.test(text)
    && isCodexAuthError(text);
}

export function codexAuthScopeFromAccountRead(
  raw: unknown,
  hintedMcp: boolean,
): CodexAuthScope {
  const result = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  if (result.requiresOpenaiAuth === true && result.account == null) {
    return "openai";
  }
  if (result.account != null) return hintedMcp ? "mcp" : "unknown";
  return hintedMcp ? "mcp" : "unknown";
}

function codexAppServerErrorMessage(params: any, fallback: string): string {
  return params?.error?.message
    || params?.status?.error?.message
    || params?.status?.message
    || params?.message
    || fallback;
}

/**
 * Codex reports response-stream reconnect attempts through its generic error
 * notification channel even though the turn is still alive. They are progress
 * events, not terminal failures; rejecting the turn here races Codex's own
 * successful retry and leaves late activity attached to a falsely closed run.
 */
export function isRecoverableCodexAppServerError(params: any): boolean {
  const error = params?.error || params;
  const message = String(error?.message || params?.message || "");
  const errorInfo = error?.codexErrorInfo || params?.codexErrorInfo;
  return /^reconnecting(?:\.{3}|…)?\s*(?:\d+\s*\/\s*\d+)?$/i.test(message.trim())
    && errorInfo?.responseStreamDisconnected != null;
}

type CodexSubagentStatus = "pending" | "running" | "completed" | "interrupted" | "errored" | "shutdown";

type CodexSubagentState = {
  agentId: string;
  toolUseId: string;
  description: string;
  subagentType: string;
  startedAt: string;
  status: CodexSubagentStatus;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  agentPath?: string;
  parentToolUseId?: string;
  everActive: boolean;
  resultSent: boolean;
};

// Codex can complete one app-server turn and immediately start another when
// an active goal auto-continues. Treat that short boundary as one SocketAgent
// run so the app never loses its running state or Stop control between turns.
const CODEX_TURN_COMPLETION_GRACE_MS = 500;

// ─── CodexSession ─────────────────────────────────────────────────────────

export class CodexSession {
  private sessionId: string | null = null; // SocketAgent session id (= codex thread_id)
  private threadId: string | null = null;  // codex thread_id (for resume)
  private appServer: CodexAppServerClient | null = null;
  private appServerStopPromise: Promise<void> | null = null;
  private appServerInitialized = false;
  private appServerInitializePromise: Promise<void> | null = null;
  private appServerIdleStopTimer: ReturnType<typeof setTimeout> | null = null;
  private appServerAuthenticationInvalidated = false;
  private appServerMcpRegistration: ReturnType<typeof registerCodexAppMcp> | null = null;
  private activeAppServerTurnId: string | null = null;
  private appServerTurnSettler: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private pendingAppServerTurnCompletion: ReturnType<typeof setTimeout> | null = null;
  private appServerAgentText = new Map<string, string>();
  private appServerReasoningText = new Map<string, string>();
  private appServerReasoningParents = new Map<string, string>();
  private appServerReasoningStartedAt = new Map<string, number>();
  private appServerPlanText = new Map<string, string>();
  private appServerToolOutput = new Map<string, string>();
  private appServerActiveToolCalls = new Map<string, {
    tool: string;
    input: Record<string, unknown>;
    parentToolUseId?: string;
  }>();
  private appServerFileChangeDiff = new Map<string, string>();
  private appServerFileChangePaths = new Map<string, string[]>();
  private appServerSeenUserMessageItems = new Set<string>();
  private appServerStreamParents = new Map<string, string>();
  private appServerAgentPhases = new Map<string, "commentary" | "final_answer">();
  private codexSubagents = new Map<string, CodexSubagentState>();
  private lastSubagentSnapshotFingerprint: string | null = null;
  private _isCompacting = false;
  private _compactStartedAt: string | null = null;
  private _compactBoundaryEmitted = false;
  private _compactBoundaryTrigger: "auto" | "manual" = "auto";
  private _isRunning = false;
  private _runStartedAt: string | null = null;
  private _model: string | null = null;
  private _effort: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra" = "high";
  private _fastMode = false;
  private _sandbox: SandboxMode = "danger-full-access";
  private _approvalPolicy: CodexAppServerApprovalPolicy = "never";
  private _approvalsReviewer: CodexAppServerApprovalsReviewer = "user";
  private _permissionMode = "bypassPermissions";
  private _appendSystemPrompt = "";
  private _systemPromptOverride: string | undefined;
  private _pendingTransferContext: string | null = null;
  private _preparedRolloverSessionId: string | null = null;
  private _disallowedTools: string[] = [];
  private _collaborationMode = "default";
  private _ttsEnabled = false;
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice = "af_heart";
  private _kokoroSpeed = 1.0;
  private _stderrBuffer: string[] = [];
  private _abortRequested = false;
  // Persistence state — see runQuery/handleEvent for the buffer-then-flush
  // dance for the user prompt (prompt arrives before sessionId on first turn).
  private _sessionInfoSaved = false;
  private _pendingUserPrompt: { text: string; uuid: string; messageId?: string } | null = null;
  private _currentClientMessageId: string | null = null;
  private _currentPrompt = "";   // for SessionInfo.title on first save
  private _lastAssistantText = ""; // for messagePreview on turn.completed
  private _lastUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    contextWindow: number;
  } | null = null;
  private _lastSupportedModels: ServerMessage | null = null;
  private _queuedPrompts: QueuedPrompt[] = [];
  private _pendingAppServerSteers: PendingAppServerSteer[] = [];
  private pendingQuestions = new Map<string, PendingQuestion>();
  private appServerQuestionByRequestId = new Map<string, string>();
  private connectedAppApprovals = new Set<string>();
  private clientSockets = new Set<WebSocket>();
  private sessionEventDelivery = new SessionEventDelivery((message) => {
    this.dispatchToClients(message as ServerMessage);
  });
  private streamSnapshots = new LatestSnapshotDispatcher<ServerMessage>((message) => {
    this.sendImmediately(message);
  });
  private appServerAuthCheck: Promise<CodexAuthScope> | null = null;
  private lastPrimaryAuthRequiredAt = 0;
  private surfacedMcpAuth = new Set<string>();

  public onActivity?: () => void;
  public onClose?: () => void;
  public onSessionIdChanged?: (previousSessionId: string, nextSessionId: string) => void;
  public onMonitorOutput?: (text: string) => void;
  public onAgentSessionRequest?: AgentSessionToolExecutor;
  public replacesSessionId?: string;
  // Mirrors the cast-accessed private on ClaudeSession; used by index.ts to
  // tell us "this is a resume of session X" before runQuery is called.
  public _resumeSessionId?: string;

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private _plugins: SocketAgentPlugin[] = [],
  ) {
    this.attachWebSocket(ws);
  }

  // ─── Public API (subset of ClaudeSession) ────────────────────────────

  get isRunning(): boolean { return this._isRunning; }
  get isCompacting(): boolean { return this._isCompacting; }
  getDelegatedLiveActivity(): DelegatedAgentLiveActivity {
    const assistantText = [...this.appServerAgentText.entries()]
      .slice(-5)
      .map(([streamId, content]) => ({
        stream_id: streamId,
        content: content.slice(-6_000),
        ...(this.appServerStreamParents.get(streamId)
          ? {
              parent_tool_use_id:
                this.appServerStreamParents.get(streamId),
            }
          : {}),
      }));
    const activeTools = [...this.appServerActiveToolCalls.entries()]
      .slice(-10)
      .map(([toolUseId, call]) => ({
        tool_use_id: toolUseId,
        tool: call.tool,
        input: call.input,
        ...(call.parentToolUseId
          ? { parent_tool_use_id: call.parentToolUseId }
          : {}),
      }));
    return {
      running: this.isBusy,
      ...(assistantText.length > 0 ? { assistant_text: assistantText } : {}),
      ...(activeTools.length > 0 ? { active_tools: activeTools } : {}),
      ...(this.appServerReasoningText.size > 0
        ? { reasoning: { in_progress: true } }
        : {}),
    };
  }
  get isWarmIdle(): boolean {
    return !!this.appServer && !this.isBusy;
  }
  private get hasRunningSubagents(): boolean {
    return [...this.codexSubagents.values()].some(
      (agent) => agent.status === "pending" || agent.status === "running",
    );
  }
  get isBusy(): boolean {
    return this._isRunning
      || this.pendingAppServerTurnCompletion !== null
      || this._isCompacting
      || this.appServerTurnSettler !== null
      || this._pendingUserPrompt !== null
      || this._queuedPrompts.length > 0
      || this._pendingAppServerSteers.length > 0
      || this.pendingQuestions.size > 0
      || this.hasRunningSubagents;
  }

  private cancelPendingAppServerTurnCompletion(): boolean {
    if (!this.pendingAppServerTurnCompletion) return false;
    clearTimeout(this.pendingAppServerTurnCompletion);
    this.pendingAppServerTurnCompletion = null;
    return true;
  }

  /**
   * A completed root turn cannot still own an active foreground tool. Codex
   * occasionally omits item/completed after interruption or process trouble;
   * settle those calls once so pooled-session replay cannot resurrect them.
   */
  private settleActiveAppServerToolCalls(output: string): void {
    const sid = this.sessionId;
    if (!sid || this.appServerActiveToolCalls.size === 0) return;
    const historyEntries: HistoryEntry[] = [];
    for (const [toolUseId, call] of this.appServerActiveToolCalls.entries()) {
      this.send({
        type: "tool_result",
        toolUseId,
        output,
        sessionId: sid,
        ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
      } as any);
      historyEntries.push({
        role: "tool_result",
        content: output,
        toolUseId,
        toolOutput: output,
        ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
        timestamp: now(),
      });
      this.appServerToolOutput.delete(toolUseId);
    }
    appendHistoryBulk(sid, historyEntries);
    this.appServerActiveToolCalls.clear();
  }

  private scheduleAppServerTurnCompletion(): void {
    this.cancelPendingAppServerTurnCompletion();
    this.pendingAppServerTurnCompletion = setTimeout(() => {
      this.pendingAppServerTurnCompletion = null;
      this.settleActiveAppServerToolCalls("");
      const sid = this.sessionId;
      if (sid) {
        const usage = this._lastUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          contextWindow: 0,
        };
        this.send({
          type: "result",
          content: this._lastAssistantText,
          sessionId: sid,
          usage,
        } as ServerMessage);
        updateSessionActivity(sid, this._lastAssistantText, usage);
      }
      this._isRunning = false;
      this._runStartedAt = null;
      this.onActivity?.();
      const settler = this.appServerTurnSettler;
      this.appServerTurnSettler = null;
      settler?.resolve();
    }, CODEX_TURN_COMPLETION_GRACE_MS);
    this.pendingAppServerTurnCompletion.unref?.();
  }
  get activeStartedAt(): string | null {
    if (this._isCompacting) return this._compactStartedAt || this._runStartedAt;
    if (this.isBusy) {
      return this._runStartedAt
        || [...this.codexSubagents.values()]
          .filter((agent) => agent.status === "pending" || agent.status === "running")
          .map((agent) => agent.startedAt)
          .sort()[0]
        || null;
    }
    return null;
  }
  get driver(): CodexDriver { return "app-server"; }
  get permissionMode(): string | null {
    return this._permissionMode;
  }
  get sessionModel(): string | null { return this._model; }
  get lastUsage(): NonNullable<CodexSession["_lastUsage"]> | null { return this._lastUsage; }
  get activeBackgroundTasks(): Map<string, string> { return new Map(); }
  get lastPreview(): string { return this._lastAssistantText; }
  getSessionId(): string | null { return this.sessionId; }
  getCwd(): string { return this.cwd; }
  getActiveToolCall(): { toolUseId: string; name: string } | null {
    if (!this._isRunning && !this.pendingAppServerTurnCompletion) return null;
    const activeCalls = [...this.appServerActiveToolCalls.entries()];
    const active = activeCalls.length > 0
      ? activeCalls[activeCalls.length - 1]
      : undefined;
    return active ? { toolUseId: active[0], name: active[1].tool } : null;
  }
  getAccumulatedBashOutput(): string | null { return null; }
  setSandbox(mode: SandboxMode): void {
    this._sandbox = mode;
    this._permissionMode = mode === "read-only"
      ? "plan"
      : mode === "danger-full-access"
        ? "bypassPermissions"
        : "default";
  }

  /** Mirrors ClaudeSession.setModel — async to match signature. */
  async setModel(model?: string): Promise<void> {
    this._model = model ?? null;
    this.normalizeEffortForModel(this._model);
    this.persistAgentSettings({ model: this._model || undefined, effort: this._effort });
    this.updateCachedSupportedModelSelection();
    if (this._lastSupportedModels) this.send(this._lastSupportedModels);
  }

  /**
   * Maps SocketAgent permission modes onto Codex sandbox + approval policy.
   * Regular Yolo keeps approval callbacks enabled so SocketAgent can still
   * enforce protected-file rules while auto-approving everything else.
   */
  async setPermissionMode(mode: string, options: { recordHistory?: boolean } = {}): Promise<void> {
    const previousMode = this._permissionMode;
    this._permissionMode = mode;
    this._approvalsReviewer = "user";
    switch (mode) {
      case "plan":
        this._sandbox = "read-only";
        this._approvalPolicy = "untrusted";
        break;
      case "bypassPermissions":
        this._sandbox = "danger-full-access";
        this._approvalPolicy = "untrusted";
        break;
      case "superYolo":
        this._sandbox = "danger-full-access";
        this._approvalPolicy = "never";
        break;
      default:
        this._sandbox = "workspace-write";
        this._approvalPolicy = "untrusted";
        break;
    }
    this.persistPermissionMode();
    if (options.recordHistory !== false && previousMode !== this._permissionMode) {
      this.appendPermissionModeHistory();
    }
    if (mode === "superYolo") this.resolvePendingSuperYoloGitHubConfirmations();
  }

  private currentConnectedAppApprovals(): Set<string> {
    const approvals = new Set(this.connectedAppApprovals);
    const sid = this.sessionId || this._resumeSessionId;
    const stored = sid ? getSession(sid)?.agentSettings?.connectedAppApprovals : undefined;
    for (const app of stored || []) {
      const normalized = String(app || "").trim().toLowerCase();
      if (normalized) approvals.add(normalized);
    }
    return approvals;
  }

  private rememberConnectedAppApproval(appKey: string): void {
    this.connectedAppApprovals.add(appKey);
    const sid = this.sessionId || this._resumeSessionId;
    if (!sid) return;
    updateSessionAgentSettings(sid, {
      connectedAppApprovals: [...this.currentConnectedAppApprovals()].sort(),
    });
  }

  private shouldAutoApproveConnectedApp(appKey: string): boolean {
    return this.currentConnectedAppApprovals().has(appKey)
      || (this._permissionMode === "superYolo" && appKey === "github");
  }

  private resolvePendingSuperYoloGitHubConfirmations(): void {
    for (const [questionId, pending] of [...this.pendingQuestions]) {
      const questions = (pending.questionData as any)?.questions;
      if (!Array.isArray(questions) || questions.length === 0) continue;
      const confirmations = questions.map((question: any) =>
        connectedAppConfirmation(String(question?.question || ""), question?.options || []),
      );
      if (confirmations.some((confirmation: ConnectedAppConfirmation | null) => confirmation?.appKey !== "github")) {
        continue;
      }
      const answers: Record<string, string> = {};
      questions.forEach((question: any, index: number) => {
        answers[String(question.question)] = confirmations[index]!.approveLabel;
      });
      this.pendingQuestions.delete(questionId);
      this.clearAppServerQuestionMapping(questionId);
      pending.resolve(answers);
      const sid = this.sessionId || this._resumeSessionId || "";
      if (sid) markQuestionAnswered(sid, questionId, answers);
      this.send({ type: "question_answered", questionId, sessionId: sid, answers } as any);
    }
  }

  private persistPermissionMode(): void {
    if (!this.sessionId) return;
    const session = getSession(this.sessionId);
    if (!session) return;
    session.permissionMode = this._permissionMode;
    saveSession(session);
  }

  private appendPermissionModeHistory(): void {
    if (!this.sessionId) return;
    appendHistory(this.sessionId, {
      role: "permission_mode",
      content: "",
      permissionMode: this._permissionMode,
      timestamp: now(),
    });
  }

  setWebSocket(ws: WebSocket, deferLiveReplay = false): void {
    this.attachWebSocket(ws);
    if (this._lastSupportedModels) this.sendTo(ws, this._lastSupportedModels);
    if (!deferLiveReplay) {
      this.sessionEventDelivery.replayTo((message) => {
        this.sendTo(ws, message as ServerMessage);
      });
    }
  }

  acknowledgeSessionEvent(deliveryId: string): boolean {
    return this.sessionEventDelivery.acknowledge(deliveryId);
  }
  replayLiveState(ws: WebSocket = this.ws): void {
    const sid = this.sessionId || "";
    if (!sid) return;

    if (!this._isRunning && !this.pendingAppServerTurnCompletion) {
      this.settleActiveAppServerToolCalls("");
    }

    this.sessionEventDelivery.replayTo((message) => {
      this.sendTo(ws, message as ServerMessage);
    });

    for (const [toolUseId, call] of this.appServerActiveToolCalls.entries()) {
      if (this.sessionEventDelivery.hasPending("tool_call", toolUseId)) continue;
      this.sendTo(ws, {
        type: "tool_call",
        tool: call.tool,
        input: call.input,
        toolUseId,
        sessionId: sid,
        replay: true,
        ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
      } as any);
    }

    for (const [itemId, content] of this.appServerReasoningText.entries()) {
      if (content) {
        const parentToolUseId = this.appServerReasoningParents.get(itemId);
        this.sendTo(ws, {
          type: "thinking",
          content,
          sessionId: sid,
          streamId: itemId,
          replay: true,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as any);
      }
    }

    for (const [streamId, content] of this.appServerAgentText.entries()) {
      if (content) {
        const parentToolUseId = this.appServerStreamParents.get(streamId);
        this.sendTo(ws, {
          type: "text",
          content,
          sessionId: sid,
          streamId,
          replay: true,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as any);
      }
    }
    for (const pendingSecureInput of pendingSecureInputMessagesForSession(sid)) {
      this.sendTo(ws, pendingSecureInput as ServerMessage);
    }
    for (const pending of this.pendingQuestions.values()) {
      if (pending.questionData) this.sendTo(ws, pending.questionData);
    }
    this.sendSubagentSnapshot(ws);
  }

  private codexSubagentToolUseId(agentId: string): string {
    return `codex-subagent:${agentId}`;
  }

  private subagentDescription(agentPath: string, agentId: string): string {
    const leaf = agentPath.split(/[\\/]/).filter(Boolean).pop() || "Codex agent";
    const readable = leaf.replace(/[_-]+/g, " ").trim();
    return readable || `Codex agent ${agentId.slice(0, 8)}`;
  }

  private sendSubagentSnapshot(ws?: WebSocket): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const activeAgents = [...this.codexSubagents.values()].filter(
      (agent) => agent.status === "pending" || agent.status === "running",
    );
    const tasks = activeAgents.map((agent) => ({
      agentId: agent.agentId,
      toolUseId: agent.toolUseId,
      description: agent.description,
      subagentType: agent.subagentType,
      startedAt: agent.startedAt,
      status: agent.status,
      ...(agent.prompt ? { prompt: agent.prompt } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      ...(agent.agentPath ? { agentPath: agent.agentPath } : {}),
      ...(agent.parentToolUseId ? { parentToolUseId: agent.parentToolUseId } : {}),
    }));
    const fingerprint = JSON.stringify(tasks);
    if (!ws && fingerprint === this.lastSubagentSnapshotFingerprint) return;
    if (!ws) this.lastSubagentSnapshotFingerprint = fingerprint;
    const message = {
      type: "active_subagents",
      sessionId,
      backend: "codex",
      replace: true,
      tasks,
    } as any;
    if (ws) this.sendTo(ws, message);
    else this.send(message);
  }

  private registerCodexSubagent(
    agentId: string,
    options: {
      agentPath?: string;
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      startedAt?: string;
      parentToolUseId?: string;
    } = {},
  ): CodexSubagentState | null {
    const sessionId = this.sessionId;
    if (!sessionId || !agentId || agentId === this.threadId) return null;
    const existing = this.codexSubagents.get(agentId);
    if (existing) {
      let changed = false;
      if (options.agentPath && options.agentPath !== existing.agentPath) {
        existing.agentPath = options.agentPath;
        existing.subagentType = options.agentPath.split(/[\\/]/).filter(Boolean).pop() || existing.subagentType;
        if (!existing.prompt) {
          existing.description = this.subagentDescription(options.agentPath, agentId);
        }
        changed = true;
      }
      if (options.prompt && options.prompt !== existing.prompt) {
        existing.prompt = options.prompt;
        existing.description = options.prompt.trim().slice(0, 160);
        changed = true;
      }
      if (options.model && options.model !== existing.model) {
        existing.model = options.model;
        changed = true;
      }
      if (options.reasoningEffort && options.reasoningEffort !== existing.reasoningEffort) {
        existing.reasoningEffort = options.reasoningEffort;
        changed = true;
      }
      if (options.parentToolUseId && options.parentToolUseId !== existing.parentToolUseId) {
        existing.parentToolUseId = options.parentToolUseId;
        changed = true;
      }
      if (changed) this.publishCodexSubagent(existing);
      return existing;
    }

    const agentPath = options.agentPath || "";
    const description = options.prompt?.trim().slice(0, 160)
      || this.subagentDescription(agentPath, agentId);
    const state: CodexSubagentState = {
      agentId,
      toolUseId: this.codexSubagentToolUseId(agentId),
      description,
      subagentType: agentPath.split(/[\\/]/).filter(Boolean).pop() || "codex",
      startedAt: options.startedAt || now(),
      status: "pending",
      ...(options.prompt ? { prompt: options.prompt } : {}),
      model: options.model || this.codexModel(),
      reasoningEffort: options.reasoningEffort || this.codexReasoningEffort(),
      ...(agentPath ? { agentPath } : {}),
      ...(options.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
      everActive: false,
      resultSent: false,
    };
    this.codexSubagents.set(agentId, state);
    this.onActivity?.();

    this.publishCodexSubagent(state);
    return state;
  }

  private codexSubagentInput(state: CodexSubagentState): Record<string, unknown> {
    return {
      description: state.description,
      prompt: state.prompt || "",
      subagent_type: state.subagentType,
      agentId: state.agentId,
      ...(state.model ? { model: state.model } : {}),
      ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
      ...(state.agentPath ? { agentPath: state.agentPath } : {}),
    };
  }

  private publishCodexSubagent(state: CodexSubagentState): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const input = this.codexSubagentInput(state);
    this.send({
      type: "tool_call",
      tool: "Agent",
      input,
      toolUseId: state.toolUseId,
      sessionId,
      ...(state.parentToolUseId ? { parentToolUseId: state.parentToolUseId } : {}),
    } as any);
    appendHistory(sessionId, {
      role: "tool_call",
      content: state.description,
      toolName: "Agent",
      toolInput: input,
      toolUseId: state.toolUseId,
      ...(state.parentToolUseId ? { parentToolUseId: state.parentToolUseId } : {}),
      timestamp: state.startedAt,
    });
    this.sendSubagentSnapshot();
  }

  private reportCodexSubagentAssignment(agentPath: string, prompt: string): boolean {
    const normalizedPath = agentPath.trim().replace(/\/+$/, "");
    const normalizedPrompt = prompt.trim();
    if (!normalizedPath || !normalizedPrompt) return false;
    const agent = [...this.codexSubagents.values()].find(
      (candidate) => candidate.agentPath?.trim().replace(/\/+$/, "") === normalizedPath,
    );
    if (!agent) return false;
    this.registerCodexSubagent(agent.agentId, {
      agentPath: normalizedPath,
      prompt: normalizedPrompt,
    });
    return true;
  }

  private updateCodexSubagentStatus(agentId: string, rawStatus: string, message?: string): void {
    const agent = this.codexSubagents.get(agentId);
    if (!agent) return;
    let status: CodexSubagentStatus | null = null;
    if (rawStatus === "active" || rawStatus === "running" || rawStatus === "pendingInit") {
      status = "running";
      agent.everActive = true;
      agent.resultSent = false;
    } else if (rawStatus === "idle" || rawStatus === "completed" || rawStatus === "notLoaded" || rawStatus === "notFound") {
      if (!agent.everActive && rawStatus === "idle") return;
      status = "completed";
    } else if (rawStatus === "interrupted") {
      status = "interrupted";
    } else if (rawStatus === "errored" || rawStatus === "systemError" || rawStatus === "failed") {
      status = "errored";
    } else if (rawStatus === "shutdown") {
      status = "shutdown";
    }
    if (!status) return;
    if (agent.status === status) return;
    agent.status = status;
    this.onActivity?.();

    if (status !== "running" && !agent.resultSent && this.sessionId) {
      agent.resultSent = true;
      const output = message || `Codex subagent ${status}`;
      this.send({
        type: "tool_result",
        toolUseId: agent.toolUseId,
        output,
        sessionId: this.sessionId,
      } as any);
      this.send({
        type: "subagent_result",
        parentToolUseId: agent.toolUseId,
        content: output,
        sessionId: this.sessionId,
      } as any);
      appendHistory(this.sessionId, {
        role: "tool_result",
        content: output,
        toolUseId: agent.toolUseId,
        toolOutput: output,
        timestamp: now(),
      });
    }
    this.sendSubagentSnapshot();
    if (!this.hasRunningSubagents && !this._isRunning) {
      this.scheduleAppServerIdleStop();
    }
  }

  private parentToolUseIdForThread(threadId: unknown): string | undefined {
    const id = String(threadId || "");
    if (!id || id === this.threadId) return undefined;
    return this.codexSubagents.get(id)?.toolUseId
      || this.registerCodexSubagent(id)?.toolUseId;
  }
  detachWebSocket(): void {
    // Keep attached sockets until they close so a second resume cannot steal
    // the live stream from an existing app view. The app filters by sessionId.
  }

  // ─── Shims for ClaudeSession surface area ────────────────────────────
  // Some are meaningful for Codex, others remain no-ops where Codex has no
  // matching runtime control.
  setEffort(e: string): void {
    if (e === "minimal" || e === "low" || e === "medium" || e === "high" || e === "max" || e === "xhigh" || e === "ultra") {
      this._effort = e;
      this.persistAgentSettings({ effort: e });
    }
  }
  setCodexFastMode(enabled: boolean): void {
    this._fastMode = enabled;
    this.persistAgentSettings({ codexFastMode: enabled });
  }
  setThinking(_t: unknown): void {}
  setDisallowedTools(tools: string[]): void {
    this._disallowedTools = [...tools];
    this.persistAgentSettings({ disallowedTools: this._disallowedTools });
  }
  setAppendSystemPrompt(s: string, options: { inherited?: boolean; clearOverride?: boolean } = {}): void {
    this._appendSystemPrompt = s;
    if (options.clearOverride) {
      this._systemPromptOverride = undefined;
      this.persistAgentSettings({ systemPrompt: undefined });
    } else if (!options.inherited) {
      this._systemPromptOverride = s;
      this.persistAgentSettings({ systemPrompt: s });
    }
  }
  setPendingTransferContext(context: string): void {
    this._pendingTransferContext = context.trim() || null;
  }
  prepareContextRollover(previousSessionId: string, context: string): void {
    if (this.isBusy) throw new Error("Cannot roll over a running Codex session");
    this._preparedRolloverSessionId = previousSessionId;
    this.replacesSessionId = previousSessionId;
    this.sessionId = null;
    this.threadId = null;
    this._resumeSessionId = undefined;
    this._sessionInfoSaved = false;
    this._lastUsage = null;
    this.setPendingTransferContext(context);
  }
  setCodexCollaborationMode(mode: string): void {
    const trimmed = (mode || "default").trim();
    this._collaborationMode = trimmed || "default";
    this.persistAgentSettings({ codexCollaborationMode: this._collaborationMode });
  }
  getCodexCollaborationMode(): string {
    return this._collaborationMode;
  }
  getCodexFastMode(): boolean {
    return this._fastMode;
  }
  getAgentSettings(): AgentSessionSettings {
    return {
      ...(this._model ? { model: this._model } : {}),
      effort: this._effort,
      codexFastMode: this._fastMode,
      codexCollaborationMode: this._collaborationMode,
      disallowedTools: [...this._disallowedTools],
      ...(this._systemPromptOverride !== undefined ? { systemPrompt: this._systemPromptOverride } : {}),
    };
  }

  private persistAgentSettings(patch: Partial<AgentSessionSettings>): void {
    const sid = this.sessionId || this._resumeSessionId;
    if (sid) updateSessionAgentSettings(sid, patch);
  }
  setForkSource(_id: string): void {}
  setResumeSessionAt(_uuid: string): void {}
  setTtsEnabled(b: boolean): void { this._ttsEnabled = b; }
  setTtsEngine(e: string): void {
    if (e === "system" || e === "kokoro_server" || e === "kokoro_device") {
      this._ttsEngine = e;
    }
  }
  setKokoroVoice(v: string): void { this._kokoroVoice = v; }
  setKokoroSpeed(s: number): void { this._kokoroSpeed = s; }
  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    this.pendingQuestions.delete(questionId);
    this.clearAppServerQuestionMapping(questionId);
    pending.resolve(answers);
    const sid = this.sessionId || this._resumeSessionId;
    if (sid) markQuestionAnswered(sid, questionId, answers);
    return true;
  }

  private clearAppServerQuestionMapping(questionId: string): void {
    for (const [requestId, mappedQuestionId] of this.appServerQuestionByRequestId) {
      if (mappedQuestionId === questionId) this.appServerQuestionByRequestId.delete(requestId);
    }
  }

  private resolveAppServerRequest(requestId: unknown): void {
    const key = String(requestId ?? "");
    const questionId = this.appServerQuestionByRequestId.get(key);
    if (!questionId) return;
    this.appServerQuestionByRequestId.delete(key);
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);
    pending.resolve({});
    const sid = this.sessionId || this._resumeSessionId || "";
    if (sid) markQuestionAnswered(sid, questionId, {});
    this.send({ type: "question_answered", questionId, sessionId: sid, answers: {} } as any);
  }
  submitAuthCode(_code: string): void {}
  interrupt(): void { this.abort(); }
  stopMonitoring(taskId: string): void {
    // The app's stop button is a process stop, not merely an unsubscribe.
    // The Monitor tool's enabled=false path still leaves the process running.
    stopAppMonitor(taskId, true, true);
  }

  async stopTask(_taskId: string): Promise<void> {}
  async mcpServerStatus(): Promise<unknown[]> { return []; }
  async reconnectMcpServer(_name: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "MCP not supported on codex backend" };
  }
  async toggleMcpServer(_name: string, _enabled: boolean): Promise<void> {}
  async rewindFiles(_uuid: string, _dryRun = false): Promise<{ success: boolean; restored: string[] }> {
    return { success: false, restored: [] };
  }

  async forkAppServerThread(sourceThreadId: string): Promise<{ threadId: string }> {
    await this.ensureAppServer();
    const forked = await this.appServer!.forkThread({
      ...this.buildAppServerThreadParams(),
      threadId: sourceThreadId,
    });
    const threadId = this.extractThreadId(forked);
    if (!threadId) throw new Error("codex app-server did not return a forked thread id");
    this.threadId = threadId;
    this.sessionId = threadId;
    this._sessionInfoSaved = true;
    return { threadId };
  }

  async compactAppServerThread(threadId = this.threadId || this.sessionId || this._resumeSessionId): Promise<void> {
    if (!threadId) throw new Error("No Codex thread id to compact");
    await this.ensureAppServer();
    this._isCompacting = true;
    this._compactStartedAt = new Date().toISOString();
    this._compactBoundaryEmitted = false;
    this._compactBoundaryTrigger = "manual";
    this.send({ type: "compacting", active: true, sessionId: threadId } as any);
    await this.appServer!.compactThread(threadId);
  }

  async rollbackAppServerThread(numTurns: number, threadId = this.threadId || this.sessionId || this._resumeSessionId): Promise<void> {
    if (!threadId) throw new Error("No Codex thread id to roll back");
    if (!Number.isFinite(numTurns) || numTurns < 1) throw new Error("Rollback must drop at least one turn");
    await this.ensureAppServer();
    await this.appServer!.rollbackThread(threadId, Math.floor(numTurns));
  }

  async getAppServerGoal(
    threadId = this.threadId || this.sessionId || this._resumeSessionId,
  ): Promise<CodexGoal | null> {
    if (!threadId) throw new Error("No Codex thread id for goal");
    await this.ensureAppServer();
    const result = await this.appServer!.getGoal(threadId) as { goal?: unknown };
    return normalizeCodexGoal(result?.goal);
  }

  async setAppServerGoal(
    update: { objective?: string; status?: CodexGoalStatus; tokenBudget?: number | null },
    threadId = this.threadId || this.sessionId || this._resumeSessionId,
  ): Promise<CodexGoal> {
    if (!threadId) throw new Error("No Codex thread id for goal");
    await this.ensureAppServer();
    const result = await this.appServer!.setGoal(threadId, update) as { goal?: unknown };
    const goal = normalizeCodexGoal(result?.goal);
    if (!goal) throw new Error("Codex returned an invalid goal state");
    return goal;
  }

  async clearAppServerGoal(
    threadId = this.threadId || this.sessionId || this._resumeSessionId,
  ): Promise<void> {
    if (!threadId) throw new Error("No Codex thread id for goal");
    await this.ensureAppServer();
    await this.appServer!.clearGoal(threadId);
  }

  async executeCodexSlashCommand(name: string, args = ""): Promise<void> {
    const command = name.trim().replace(/^\//, "").toLowerCase();
    const commandArgs = args.trim();
    const threadId = this.threadId || this.sessionId || this._resumeSessionId || "";
    const commandDef = CODEX_NATIVE_SLASH_COMMANDS.find((candidate) => candidate.name === command);
    if (!commandDef) {
      throw new Error(`Unsupported Codex slash command: /${command}`);
    }
    switch (command) {
      case "status": {
        const result = await this.buildStatusResult(threadId);
        this.emitSlashCommandResult(command, result.summary, "completed", result.payload);
        return;
      }

      case "compact": {
        await this.compactAppServerThread(threadId);
        this.emitSlashCommandResult(command, "Codex thread compaction started.");
        return;
      }

      case "goal": {
        if (!threadId) throw new Error("No Codex thread id for /goal");
        await this.ensureAppServer();
        if (!commandArgs) {
          const result = await this.appServer!.getGoal(threadId);
          const goal = (result as any)?.goal;
          this.emitSlashCommandResult(
            command,
            goal
              ? `Goal: ${goal.objective || ""}\nStatus: ${goal.status || "unknown"}`
              : "No active goal.",
          );
          return;
        }
        const action = commandArgs.toLowerCase();
        if (action === "clear") {
          await this.appServer!.clearGoal(threadId);
          this.emitSlashCommandResult(command, "Goal cleared.");
          return;
        }
        if (action === "pause" || action === "paused") {
          await this.appServer!.setGoal(threadId, { status: "paused" });
          this.emitSlashCommandResult(command, "Goal paused.");
          return;
        }
        if (action === "resume" || action === "active") {
          await this.appServer!.setGoal(threadId, { status: "active" });
          this.emitSlashCommandResult(command, "Goal resumed.");
          return;
        }
        await this.appServer!.setGoal(threadId, { objective: commandArgs, status: "active" });
        this.emitSlashCommandResult(command, `Goal set: ${commandArgs}`);
        return;
      }

      case "review": {
        if (!threadId) throw new Error("No Codex thread id for /review");
        await this.ensureAppServer();
        await this.appServer!.startReview(threadId, commandArgs);
        this.emitSlashCommandResult(command, "Codex review started.");
        return;
      }

      case "mcp": {
        await this.ensureAppServer();
        this.appServerConfig();
        const result = await this.appServer!.listMcpServerStatus(undefined);
        const servers = Array.isArray((result as any)?.data) ? (result as any).data : [];
        const displayServers = servers.map((server: any) => ({
          name: String(server.name || server.serverName || "unnamed"),
          authStatus: this.formatMcpAuthStatus(server.authStatus || server.status || server.startupStatus || server.state || "unknown"),
          toolCount: server.tools && typeof server.tools === "object" ? Object.keys(server.tools).length : 0,
          resourceCount: Array.isArray(server.resources) ? server.resources.length : 0,
          templateCount: Array.isArray(server.resourceTemplates) ? server.resourceTemplates.length : 0,
          tools: server.tools && typeof server.tools === "object" ? Object.keys(server.tools) : [],
        }));
        if (!displayServers.some((server: any) => server.name === "socketagent_app")) {
          displayServers.unshift({
            name: "socketagent_app",
            authStatus: this.appServerMcpRegistration ? "registered" : "configured",
            toolCount: SOCKETAGENT_APP_TOOLS.length,
            resourceCount: 0,
            templateCount: 0,
            tools: SOCKETAGENT_APP_TOOLS.map((tool) => tool.name),
          });
        }
        const summary = displayServers.length === 0
          ? "No Codex MCP servers reported."
          : displayServers.map((server: any) => `${server.name}: ${server.authStatus} (${server.toolCount} tools, ${server.resourceCount} resources, ${server.templateCount} templates)`).join("\n");
        this.emitSlashCommandResult(command, summary, "completed", {
          servers: displayServers,
        });
        return;
      }

      case "model": {
        if (commandArgs) {
          await this.setModel(commandArgs.split(/\s+/)[0]);
          this.emitSlashCommandResult(command, `Model set to ${this._model}.`);
          return;
        }
        await this.ensureAppServer();
        const result = await this.appServer!.listModels();
        const models = Array.isArray((result as any)?.data) ? (result as any).data : [];
        const names = models
          .filter((model: any) => model && model.hidden !== true)
          .slice(0, 12)
          .map((model: any) => {
            const id = String(model.id || model.model || "unknown");
            const display = model.displayName ? ` (${model.displayName})` : "";
            const current = id === this._model || (!this._model && model.isDefault) ? " current" : "";
            const tier = Array.isArray(model.serviceTiers) && model.serviceTiers.length > 0
              ? `; tiers: ${model.serviceTiers.map((tier: any) => tier.name || tier.id).filter(Boolean).join(", ")}`
              : "";
            return `${id}${display}${current}${tier}`;
          });
        this.emitSlashCommandResult(command, names.length > 0 ? names.join("\n") : `Current model: ${this._model || "default"}`, "completed", {
          models: models
            .filter((model: any) => model && model.hidden !== true)
            .slice(0, 12)
            .map((model: any) => ({
              id: String(model.id || model.model || "unknown"),
              displayName: String(model.displayName || model.id || model.model || "unknown"),
              description: String(model.description || ""),
              current: String(model.id || model.model || "") === this._model || (!this._model && model.isDefault === true),
              tiers: Array.isArray(model.serviceTiers) ? model.serviceTiers.map((tier: any) => tier.name || tier.id).filter(Boolean) : [],
            })),
        });
        return;
      }

      case "permissions": {
        if (!commandArgs) {
          this.emitSlashCommandResult(command, `Current permission mode: ${this.formatPermissionMode(this._permissionMode)}`, "completed", {
            mode: this._permissionMode,
            label: this.formatPermissionMode(this._permissionMode),
          });
          return;
        }
        const normalized = this.normalizeSlashPermissionMode(commandArgs);
        await this.setPermissionMode(normalized);
        this.emitSlashCommandResult(command, `Permission mode set to ${this.formatPermissionMode(this._permissionMode)}.`, "completed", {
          mode: this._permissionMode,
          label: this.formatPermissionMode(this._permissionMode),
        });
        return;
      }

      case "archive": {
        if (!threadId) throw new Error("No Codex thread id for /archive");
        await this.ensureAppServer();
        await this.appServer!.archiveThread(threadId);
        this.emitSlashCommandResult(command, "Codex thread archived.");
        return;
      }

      default:
        throw new Error(`Unsupported Codex slash command: /${command}`);
    }
  }

  private normalizeSlashPermissionMode(value: string): string {
    const mode = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
    switch (mode) {
      case "ask":
      case "default":
      case "workspace":
      case "workspace-write":
        return "default";
      case "read-only":
      case "readonly":
      case "plan":
        return "plan";
      case "yolo":
      case "auto":
      case "bypass":
      case "bypass-permissions":
        return "bypassPermissions";
      case "super-yolo":
      case "superyolo":
      case "never":
        return "superYolo";
      default:
        throw new Error(`Unknown permission mode '${value}'. Use ask, yolo, super-yolo, or read-only.`);
    }
  }

  async buildStatusResult(threadId: string): Promise<{ summary: string; payload: Record<string, unknown> }> {
    const lines: string[] = [];
    let config: any = null;
    let thread: any = null;
    let rateLimits: any = null;
    let usage: any = null;

    await this.ensureAppServer();
    const [configResult, threadResult, limitsResult, usageResult] = await Promise.allSettled([
      this.appServer!.readConfig(this.cwd),
      threadId ? this.appServer!.readThread({ threadId, includeTurns: false }) : Promise.resolve(null),
      this.appServer!.readAccountRateLimits(),
      this.appServer!.readAccountUsage(),
    ]);
    if (configResult.status === "fulfilled") config = (configResult.value as any)?.config || null;
    if (threadResult.status === "fulfilled") thread = (threadResult.value as any)?.thread || null;
    if (limitsResult.status === "fulfilled") rateLimits = limitsResult.value;
    if (usageResult.status === "fulfilled") usage = usageResult.value;

    const threadStatus = thread?.status?.type
      || (this._isCompacting ? "compacting" : this._isRunning ? "running" : "idle");
    const model = this._model || config?.model || "default";
    const effort = config?.model_reasoning_effort || this._effort;

    lines.push(`Thread: ${threadId || "not started"}`);
    if (thread?.name) lines.push(`Title: ${thread.name}`);
    lines.push(`State: ${threadStatus}`);
    lines.push(`CWD: ${thread?.cwd || this.cwd}`);
    lines.push("Driver: app-server");
    lines.push(`Model: ${model}`);
    lines.push(`Effort: ${effort || "default"}`);
    lines.push(`Fast mode: ${this._fastMode ? "on" : "off"}`);
    if (config?.service_tier) lines.push(`Service tier: ${config.service_tier}`);
    lines.push(`Permissions: ${this.formatPermissionMode(this._permissionMode)}`);
    if (config?.sandbox_mode || config?.approval_policy) {
      lines.push(`Codex policy: sandbox=${this.formatScalar(config.sandbox_mode || "default")}, approvals=${this.formatScalar(config.approval_policy || "default")}`);
    }

    const limitPayload = this.buildRateLimitPayload(rateLimits);
    const limitLines = this.formatRateLimitSummary(rateLimits);
    if (limitLines.length > 0) {
      lines.push("");
      lines.push("Limits:");
      lines.push(...limitLines);
    }

    const usagePayload = this.buildUsagePayload(usage);
    const usageLines = this.formatUsageSummary(usage);
    if (usageLines.length > 0) {
      lines.push("");
      lines.push("Usage:");
      lines.push(...usageLines);
    }

    return {
      summary: lines.join("\n"),
      payload: {
        thread: {
          id: threadId || "",
          title: thread?.name || "",
          state: threadStatus,
          cwd: thread?.cwd || this.cwd,
        },
        config: {
          driver: "app-server",
          model,
          effort: effort || "default",
          serviceTier: this._fastMode ? "fast" : config?.service_tier || "",
          fastMode: this._fastMode,
          permissionMode: this._permissionMode,
          permissionLabel: this.formatPermissionMode(this._permissionMode),
          sandbox: config?.sandbox_mode || "default",
          approvals: config?.approval_policy || "default",
        },
        limits: limitPayload,
        usage: usagePayload,
      },
    };
  }

  private buildRateLimitPayload(value: any): Array<Record<string, unknown>> {
    if (!value) return [];
    const byId = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
      ? Object.values(value.rateLimitsByLimitId)
      : [];
    const limits = (byId.length > 0 ? byId : [value.rateLimits]).filter(Boolean) as any[];
    return limits.slice(0, 4).map((limit) => ({
      label: String(limit.limitName || limit.limitId || "Codex"),
      plan: limit.planType ? String(limit.planType) : "",
      credits: limit.credits
        ? (limit.credits.unlimited ? "unlimited" : String(limit.credits.balance ?? "0"))
        : "",
      reached: limit.rateLimitReachedType ? this.formatScalar(limit.rateLimitReachedType) : "",
      primary: this.buildRateLimitWindowPayload(limit.primary),
      secondary: this.buildRateLimitWindowPayload(limit.secondary),
    }));
  }

  private buildRateLimitWindowPayload(window: any): Record<string, unknown> | null {
    if (!window) return null;
    const usedPercent = Number(window.usedPercent);
    return {
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      window: this.formatWindowDuration(window.windowDurationMins),
      resetsAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
      resetLabel: this.formatResetTime(window.resetsAt),
    };
  }

  private buildUsagePayload(value: any): Record<string, unknown> {
    const summary = value?.summary;
    if (!summary) return {};
    const today = this.localDateKey();
    const todayBucket = Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.find((bucket: any) => bucket?.startDate === today)
      : null;
    return {
      lifetimeTokens: Number(summary.lifetimeTokens),
      todayTokens: todayBucket ? Number(todayBucket.tokens) : null,
      peakDailyTokens: Number(summary.peakDailyTokens),
      currentStreakDays: Number(summary.currentStreakDays),
      longestStreakDays: Number(summary.longestStreakDays),
    };
  }

  private formatRateLimitSummary(value: any): string[] {
    if (!value) return [];
    const byId = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
      ? Object.values(value.rateLimitsByLimitId)
      : [];
    const limits = (byId.length > 0 ? byId : [value.rateLimits]).filter(Boolean) as any[];
    return limits.slice(0, 4).map((limit) => {
      const label = limit.limitName || limit.limitId || "Codex";
      const plan = limit.planType ? `; plan ${limit.planType}` : "";
      const primary = this.formatRateLimitWindow("primary", limit.primary);
      const secondary = this.formatRateLimitWindow("secondary", limit.secondary);
      const credits = limit.credits
        ? `; credits ${limit.credits.unlimited ? "unlimited" : String(limit.credits.balance ?? "0")}`
        : "";
      const reached = limit.rateLimitReachedType ? `; reached ${this.formatScalar(limit.rateLimitReachedType)}` : "";
      return `- ${label}: ${[primary, secondary].filter(Boolean).join("; ")}${plan}${credits}${reached}`;
    });
  }

  private formatRateLimitWindow(label: string, window: any): string {
    if (!window) return "";
    const used = Number.isFinite(Number(window.usedPercent)) ? `${Math.round(Number(window.usedPercent))}%` : "unknown";
    const duration = this.formatWindowDuration(window.windowDurationMins);
    const reset = this.formatResetTime(window.resetsAt);
    return `${label} ${used}${duration ? `/${duration}` : ""}${reset ? `, resets ${reset}` : ""}`;
  }

  private formatUsageSummary(value: any): string[] {
    const summary = value?.summary;
    if (!summary) return [];
    const lines = [
      `- Lifetime tokens: ${this.formatNumber(summary.lifetimeTokens)}`,
      `- Peak daily tokens: ${this.formatNumber(summary.peakDailyTokens)}`,
      `- Current streak: ${this.formatNumber(summary.currentStreakDays)} days`,
      `- Longest streak: ${this.formatNumber(summary.longestStreakDays)} days`,
    ];
    const today = this.localDateKey();
    const todayBucket = Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.find((bucket: any) => bucket?.startDate === today)
      : null;
    if (todayBucket) {
      lines.splice(1, 0, `- Today: ${this.formatNumber(todayBucket.tokens)} tokens`);
    }
    return lines;
  }

  private formatWindowDuration(minutes: unknown): string {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return "";
    if (mins % 1440 === 0) return `${mins / 1440}d`;
    if (mins % 60 === 0) return `${mins / 60}h`;
    return `${mins}m`;
  }

  private formatResetTime(epochSeconds: unknown): string {
    const seconds = Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private formatNumber(value: unknown): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "unknown";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
  }

  private formatScalar(value: unknown): string {
    if (value === null || value === undefined) return "default";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  private formatPermissionMode(mode: unknown): string {
    switch (mode) {
      case "plan":
        return "Read Only";
      case "default":
        return "Ask";
      case "bypassPermissions":
        return "Yolo";
      case "superYolo":
        return "Super Yolo";
      default:
        return this.formatScalar(mode);
    }
  }

  private formatMcpAuthStatus(status: unknown): string {
    switch (status) {
      case "bearerToken":
        return "authenticated";
      case "oauth":
        return "OAuth";
      case "none":
        return "no auth";
      default:
        return this.formatScalar(status);
    }
  }

  private localDateKey(): string {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private emitSlashCommandResult(
    command: string,
    summary: string,
    status: "completed" | "failed" | "stopped" = "completed",
    payload: Record<string, unknown> = {},
  ): void {
    const sid = this.threadId || this.sessionId || this._resumeSessionId || "";
    const taskId = `codex_slash_${command}_${crypto.randomUUID()}`;
    const content = `/${command}\n${summary}`;
    if (sid) {
      appendHistory(sid, {
        role: "notification",
        content,
        status,
        originToolUseId: `codex_slash_${command}`,
        commandName: command,
        commandPayload: payload,
        timestamp: now(),
      });
    }
    this.send({
      type: "codex_command_result",
      taskId,
      command,
      status,
      summary: content,
      payload,
      sessionId: sid,
      parentToolUseId: `codex_slash_${command}`,
    } as any);
  }

  async listCodexCollaborationModes(): Promise<Array<Record<string, unknown>>> {
    await this.ensureAppServer();
    const result = await this.appServer!.listCollaborationModes();
    void this.refreshSupportedModels();
    const rawModes = Array.isArray((result as any)?.modes)
      ? (result as any).modes
      : Array.isArray((result as any)?.data)
        ? (result as any).data
      : Array.isArray(result)
        ? result
        : [];
    const modes: Array<Record<string, unknown>> = rawModes
      .filter((mode: any) => mode && typeof mode === "object")
      .map((mode: any) => ({
        id: String(mode.id || mode.mode || mode.name || "default"),
        name: String(mode.name || mode.title || mode.id || "Default"),
        ...(mode.description ? { description: String(mode.description) } : {}),
      }))
      .filter((mode: Record<string, unknown>) => typeof mode.id === "string" && mode.id.length > 0);
    if (!modes.some((mode) => mode.id === "default")) {
      modes.unshift({ id: "default", name: "Default" });
    }
    return modes;
  }

  async refreshSupportedModels(): Promise<void> {
    const cachedCatalog = getCachedModelCatalog("codex");
    if (cachedCatalog) {
      this.publishSupportedModels(cachedCatalog.models, {
        cached: true,
        updatedAt: cachedCatalog.updatedAt,
      });
      if (modelCatalogIsFresh(cachedCatalog)) return;
    }
    try {
      await this.ensureAppServer();
      const result = await this.appServer!.listModels();
      const rawModels = Array.isArray((result as any)?.data)
        ? (result as any).data
        : Array.isArray((result as any)?.models)
          ? (result as any).models
          : Array.isArray(result)
            ? result
            : [];
      const visible = rawModels
        .filter((model: any) => model && model.hidden !== true)
        .slice(0, 50);
      const configuredModel = this.configuredCodexModel();
      const defaultModel = visible
        .map((model: any) => ({ model, id: this.codexModelId(model) }))
        .find((entry: { model: any; id: string }) => entry.id && entry.model.isDefault === true)?.id;
      const currentModel = this._model || configuredModel || defaultModel || this.codexModel();
      if (!this._model && currentModel) {
        this._model = currentModel;
        this.persistAgentSettings({ model: currentModel });
      }
      const models = visible
        .map((model: any) => {
          const id = this.codexModelId(model);
          if (!id) return null;
          const tiers = Array.isArray(model.serviceTiers)
            ? model.serviceTiers.map((tier: any) => tier?.name || tier?.id).filter(Boolean)
            : [];
          const descriptionParts = [
            model.description ? String(model.description) : "",
            tiers.length > 0 ? `Tiers: ${tiers.join(", ")}` : "",
          ].filter(Boolean);
          const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .map((entry: any) => {
                  const reasoningEffort = String(entry?.reasoningEffort || entry?.effort || entry || "").trim();
                  if (!reasoningEffort) return null;
                  return {
                    reasoningEffort,
                    ...(entry?.description ? { description: String(entry.description) } : {}),
                  };
                })
                .filter(Boolean)
            : [];
          return {
            id,
            value: id,
            displayName: String(model.displayName || model.name || model.title || id),
            description: descriptionParts.join(" · "),
            current: id === currentModel,
            ...(tiers.length > 0 ? { tiers } : {}),
            ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
            ...(model.defaultReasoningEffort ? { defaultReasoningEffort: String(model.defaultReasoningEffort) } : {}),
          };
        })
        .filter(Boolean) as Array<Record<string, unknown>>;
      this.normalizeEffortForModel(currentModel);
      const saved = saveCachedModelCatalog("codex", models);
      this.publishSupportedModels(saved.models, { updatedAt: saved.updatedAt });
    } catch (e: any) {
      console.warn(`[CodexModels] Failed to list models: ${e?.message || e}`);
    }
  }

  private publishSupportedModels(
    models: Array<Record<string, unknown>>,
    options: { cached?: boolean; updatedAt?: string } = {},
  ): void {
    if (models.length === 0) return;
    if (!this._model) {
      const configuredModel = this.configuredCodexModel();
      const catalogDefault = models.find((model) => model.current === true)
        || models.find((model) => model.isDefault === true)
        || models[0];
      const catalogDefaultId = String(catalogDefault?.value || catalogDefault?.id || "").trim();
      this._model = configuredModel || catalogDefaultId || null;
      if (this._model) {
        this.normalizeEffortForModel(this._model);
        this.persistAgentSettings({ model: this._model, effort: this._effort });
      }
    }
    const currentModel = this._model || "";
    const selectedModels = models.map((model) => {
      const id = String(model.value || model.id || "");
      return { ...model, current: id === currentModel };
    });
    const message = {
      type: "supported_models",
      models: selectedModels,
      ...(currentModel ? { currentModel } : {}),
      sessionId: this.sessionId || this._resumeSessionId || "",
      backend: "codex",
      ...options,
    } as ServerMessage;
    this._lastSupportedModels = message;
    this.send(message);
  }

  private codexModelId(model: any): string {
    return String(model?.id || model?.model || model?.value || "").trim();
  }

  private normalizeEffortForModel(modelId?: string | null): void {
    const cached = this._lastSupportedModels as any;
    if (!modelId || !cached || !Array.isArray(cached.models)) return;
    const model = cached.models.find((entry: any) => String(entry?.value || entry?.id || "") === modelId);
    if (!model || !Array.isArray(model.supportedReasoningEfforts)) return;
    const supported = model.supportedReasoningEfforts
      .map((entry: any) => String(entry?.reasoningEffort || entry?.effort || entry || "").trim())
      .filter(Boolean);
    if (supported.length === 0 || supported.includes(this._effort)) return;
    const defaultEffort = String(model.defaultReasoningEffort || "").trim();
    this._effort = (supported.includes(defaultEffort) ? defaultEffort : supported[0]) as typeof this._effort;
  }

  private updateCachedSupportedModelSelection(): void {
    const cached = this._lastSupportedModels as any;
    if (!cached || !Array.isArray(cached.models)) return;
    const currentModel = this._model || this.configuredCodexModel() || cached.currentModel || this.codexModel() || "";
    cached.currentModel = currentModel;
    cached.models = cached.models.map((model: any) => {
      const id = String(model?.value || model?.id || "");
      return { ...model, current: id === currentModel };
    });
  }

  /**
   * Mid-turn messages use app-server `turn/steer` when a turn is active.
   * Otherwise they queue as follow-up turns and resolve when run.
   */
  async injectMessage(text: string, priority: 'now' | 'next' | 'later' = 'now', messageId?: string, options: CodexRunOptions = {}): Promise<void> {
    if (!this._isRunning) {
      // Race: turn finished between the client deciding to queue and us
      // receiving the message. Just run it directly.
      return this.runQueryWithOptions(text, undefined, {
        ...options,
        messageId,
      });
    }

    try {
      await this.ensureAppServer();
      return new Promise<void>((resolve, reject) => {
        const pending: PendingAppServerSteer = {
          text,
          priority,
          messageId,
          fastMode: options.fastMode,
          resolve,
          reject,
          uuid: crypto.randomUUID(),
        };
        this._pendingAppServerSteers.push(pending);
        this.flushPendingAppServerSteers();
      });
    } catch (err: any) {
      console.warn(`[codex app-server] turn/steer failed; queueing follow-up: ${err?.message || String(err)}`);
    }

    console.warn(`[codex app-server] no active turn for injection; queueing follow-up (thread=${this.threadId || ""}, turn=${this.activeAppServerTurnId || ""}, priority=${priority}, messageId=${messageId || ""})`);
    return new Promise<void>((resolve, reject) => {
      this._queuedPrompts.push({ text, priority, messageId, fastMode: options.fastMode, resolve, reject });
    });
  }

  retractQueuedPrompt(messageId: string): string | null {
    if (!messageId) return null;
    const idx = this._queuedPrompts.findIndex((p) => p.messageId === messageId);
    if (idx < 0) return null;
    const [prompt] = this._queuedPrompts.splice(idx, 1);
    prompt.reject(new Error("Queued prompt retracted"));
    return prompt.text;
  }

  getSessionContext(): SessionContext {
    return {
      sessionId: this.sessionId ?? "",
      cwd: this.cwd,
      send: (msg: ServerMessage | Record<string, any>) => {
        this.send(this.withCodexProtectedPrompt(msg) as ServerMessage);
      },
      appendHistory: (entry: HistoryEntry) => {
        if (this.sessionId) appendHistory(this.sessionId, this.withCodexProtectedHistory(entry));
      },
      pendingQuestions: this.pendingQuestions,
      questionCounter: { next: () => createInteractiveRequestId("q") },
    };
  }

  private withCodexProtectedPrompt(msg: ServerMessage | Record<string, any>): ServerMessage | Record<string, any> {
    if ((msg as any).type !== "question" || !Array.isArray((msg as any).questions)) {
      return msg;
    }
    return {
      ...(msg as Record<string, any>),
      questions: (msg as any).questions.map((question: any) => ({
        ...question,
        question: this.codexProtectedPromptText(question?.question),
      })),
    };
  }

  private withCodexProtectedHistory(entry: HistoryEntry): HistoryEntry {
    if (entry.role !== "question" || !Array.isArray((entry as any).questions)) {
      return entry;
    }
    return {
      ...entry,
      questions: (entry as any).questions.map((question: any) => ({
        ...question,
        question: this.codexProtectedPromptText(question?.question),
      })),
    };
  }

  private codexProtectedPromptText(text: unknown): unknown {
    if (typeof text !== "string") return text;
    return text.replace(/^Claude wants to /, "Codex wants to ");
  }

  /** Mirrors ClaudeSession.send — sends a ServerMessage over the WS. */
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

  /**
   * Run a single turn. New thread on first call, resume on subsequent.
   * The second parameter is used when a fresh WebSocket/process resumes an
   * existing SocketAgent/Codex thread.
   */
  async runQueryWithOptions(prompt: string, resumeSessionId?: string, options: CodexRunOptions = {}): Promise<void> {
    if (options.fastMode === undefined && options.messageId === undefined) {
      return this.runQuery(prompt, resumeSessionId);
    }
    const previousFastMode = this._fastMode;
    const previousClientMessageId = this._currentClientMessageId;
    if (options.fastMode !== undefined) this._fastMode = options.fastMode;
    this._currentClientMessageId = options.messageId || null;
    try {
      return await this.runQuery(prompt, resumeSessionId);
    } finally {
      this._fastMode = previousFastMode;
      this._currentClientMessageId = previousClientMessageId;
    }
  }

  async runQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (playReviewModeEnabled()) {
      return this.runPlayReviewQuery(prompt, resumeSessionId);
    }
    return this.runAppServerQuery(prompt, resumeSessionId);
  }

  private async runPlayReviewQuery(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<void> {
    if (this._isRunning) throw new Error("CodexSession already running a turn");
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this._currentPrompt = prompt;
    this.onActivity?.();

    try {
      const existingId = resumeSessionId || this._resumeSessionId || this.sessionId;
      if (existingId) {
        this.sessionId = existingId;
        this.threadId = existingId;
        this._sessionInfoSaved = true;
      } else {
        const sessionId = `play-review-${crypto.randomUUID()}`;
        const title = prompt.trim().slice(0, 50) || "SocketAgent review";
        this.sessionId = sessionId;
        this.threadId = sessionId;
        this._sessionInfoSaved = true;
        saveSession({
          id: sessionId,
          title,
          cwd: this.cwd,
          createdAt: now(),
          lastActive: now(),
          messagePreview: "",
          backend: "codex",
          codexDriver: "app-server",
          permissionMode: this.permissionMode || undefined,
          agentSettings: this.getAgentSettings(),
        });
        this.send({
          type: "session_created",
          sessionId,
          cwd: this.cwd,
          title,
          backend: "codex",
          permissionMode: this.permissionMode,
        } as ServerMessage);
        this.send({
          type: "session_settings",
          sessionId,
          settings: this.getAgentSettings(),
        } as any);
      }

      const sessionId = this.sessionId!;
      const userUuid = this._currentClientMessageId || crypto.randomUUID();
      const userEntry = appendHistory(sessionId, {
        role: "user",
        content: prompt,
        uuid: userUuid,
        timestamp: now(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userUuid,
        sessionId,
        entryId: userEntry.entryId,
        sessionSeq: userEntry.sessionSeq,
        revision: userEntry.revision,
        ...(this._currentClientMessageId
          ? { clientMessageId: this._currentClientMessageId }
          : {}),
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 250));

      if (/\b(tool|command|file)\b/i.test(prompt)) {
        const toolUseId = `play-review-tool-${crypto.randomUUID()}`;
        const input = { path: "README.txt", operation: "inspect" };
        const output = "SocketAgent Play review workspace\nNo publisher files or credentials are available.";
        this.send({
          type: "tool_call",
          tool: "ReviewWorkspace",
          input,
          toolUseId,
          sessionId,
        } as any);
        appendHistory(sessionId, {
          role: "tool_call",
          content: "Inspecting the isolated review workspace",
          toolName: "ReviewWorkspace",
          toolInput: input,
          toolUseId,
          timestamp: now(),
        });
        this.send({
          type: "tool_result",
          toolUseId,
          output,
          sessionId,
        } as any);
        appendHistory(sessionId, {
          role: "tool_result",
          content: output,
          toolUseId,
          toolOutput: output,
          timestamp: now(),
        });
      }

      const response = [
        "You are connected to SocketAgent's isolated Google Play review server.",
        "",
        "This session demonstrates encrypted relay chat, persisted history, and tool-result rendering without exposing publisher files, credentials, or paid AI accounts.",
        "",
        "Your message was received successfully. You can send another message, close and reopen this session to verify history, or use Report response on this reply to test the reporting flow.",
      ].join("\n");
      const streamId = `play-review-response-${crypto.randomUUID()}`;
      this._lastAssistantText = response;
      this.send({
        type: "text",
        content: response,
        sessionId,
        streamId,
        snapshot: true,
        finalSnapshot: true,
      } as any);
      appendHistory(sessionId, {
        role: "assistant",
        content: response,
        streamId,
        timestamp: now(),
      });
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        contextWindow: 0,
      };
      this.send({
        type: "result",
        content: response,
        sessionId,
        usage,
      } as ServerMessage);
      updateSessionActivity(sessionId, response, usage);
    } finally {
      this._isRunning = false;
      this._runStartedAt = null;
      this.onActivity?.();
    }
  }

  private async runAppServerQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this._isRunning) throw new Error("CodexSession already running a turn");
    // Settle legacy/stale calls before starting a new turn. Without this, a
    // pooled session can report a days-old command as the current active tool.
    this.settleActiveAppServerToolCalls("");
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this.onActivity?.();
    this._abortRequested = false;
    this._currentPrompt = prompt;
    this._lastAssistantText = "";
    const transferContext = this._pendingTransferContext;
    const nativePrompt = transferContext
      ? `<socketagent_session_handoff>\n${transferContext}\n</socketagent_session_handoff>\n\nCurrent user message:\n${prompt}`
      : prompt;
    this.appServerAgentText.clear();
    this.appServerReasoningText.clear();
    this.appServerStreamParents.clear();
    this.appServerReasoningParents.clear();
    this.appServerReasoningStartedAt.clear();
    this.appServerAgentPhases.clear();
    this.appServerToolOutput.clear();

    const resumeTarget = resumeSessionId || this._resumeSessionId;
    if (!this.sessionId && resumeTarget) {
      this.sessionId = resumeTarget;
      this.threadId = resumeTarget;
      this._sessionInfoSaved = true;
    }

    const clientUserMessageId = this._currentClientMessageId || crypto.randomUUID();
    this._pendingUserPrompt = {
      text: prompt,
      // Reuse the app's stable submission ID as the transcript UUID. This
      // makes a retried prompt recognizable even after the server restarts.
      uuid: clientUserMessageId,
      ...(this._currentClientMessageId ? { messageId: this._currentClientMessageId } : {}),
    };
    // Existing sessions already have a stable SocketAgent/thread identity.
    // Persist the prompt before app-server startup so model discovery,
    // authentication, or turn/start failures cannot erase a message the
    // server has accepted.
    this.flushPendingUserPrompt();

    try {
      await this.resetInvalidatedAppServerAuthentication();
      await this.ensureAppServer();

      // Current app-server versions require model on turn/start. A new session
      // can reach this path before the app explicitly selects a model, so adopt
      // the account-aware catalog default before creating any thread state.
      if (!this.codexModel()) await this.refreshSupportedModels();
      const turnModel = this.codexModel();
      if (!turnModel) {
        throw new Error("Codex did not provide an available model for this session");
      }

      const threadConfig = this.buildAppServerThreadParams();
      if (this.threadId) {
        let resumed: unknown;
        try {
          resumed = await this.appServer!.resumeThread({
            ...threadConfig,
            threadId: this.threadId,
          });
        } catch (err: any) {
          if (this.isMissingRolloutAppServerError(err)) {
            const orphanedThreadId = this.threadId;
            console.warn(`[codex app-server] Replacing rollout-less thread ${orphanedThreadId}`);
            this.replacesSessionId = orphanedThreadId;
            this.sessionId = null;
            this.threadId = null;
            this._resumeSessionId = undefined;
            this._sessionInfoSaved = false;
            const started = await this.appServer!.startThread(threadConfig);
            this.adoptAppServerThread(this.extractThreadId(started));
            resumed = started;
          } else {
            if (!this.isArchivedAppServerError(err)) throw err;
            await this.appServer!.unarchiveThread(this.threadId);
            resumed = await this.appServer!.resumeThread({
              ...threadConfig,
              threadId: this.threadId,
            });
          }
        }
        if (this.threadId) {
          this.adoptAppServerThread(this.extractThreadId(resumed) || this.threadId);
        }
      } else {
        const started = await this.appServer!.startThread(threadConfig);
        this.adoptAppServerThread(this.extractThreadId(started));
      }

      if (!this.threadId) throw new Error("codex app-server did not return a thread id");
      void this.refreshSupportedModels();

      // Install the turn settler only after thread startup/resume succeeds.
      // A failed resume may require killing the app-server process; there is
      // no active turn for that process exit to reject at this point.
      const completion = new Promise<void>((resolve, reject) => {
        this.appServerTurnSettler = { resolve, reject };
      });

      const collaborationMode = this.codexCollaborationMode();
      const turn = await this.appServer!.startTurn({
        threadId: this.threadId,
        clientUserMessageId,
        cwd: this.cwd,
        input: this.buildAppServerTurnInput(nativePrompt),
        model: turnModel,
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      this._pendingTransferContext = null;
      if (transferContext) {
        const transferSessionId = this.sessionId || this.replacesSessionId;
        if (transferSessionId) clearSessionPendingHandoffContext(transferSessionId);
      }
      this.activeAppServerTurnId = this.extractTurnId(turn) || this.activeAppServerTurnId;
      this.flushPendingUserPrompt();
      this.flushPendingAppServerSteers();

      await completion;

      const nextPrompt = this._abortRequested ? null : this.dequeueNextPrompt();
      if (nextPrompt) {
        this._isRunning = false;
        this._runStartedAt = null;
        this.activeAppServerTurnId = null;
        this.appServerTurnSettler = null;
        try {
          await this.runQueryWithOptions(nextPrompt.text, this.sessionId ?? undefined, {
            fastMode: nextPrompt.fastMode,
            messageId: nextPrompt.messageId,
          });
          nextPrompt.resolve();
        } catch (err: any) {
          nextPrompt.reject(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      }
    } catch (err: any) {
      if (this._preparedRolloverSessionId && !this.sessionId) {
        const previousSessionId = this._preparedRolloverSessionId;
        this.sessionId = previousSessionId;
        this.threadId = previousSessionId;
        this._resumeSessionId = previousSessionId;
        this._sessionInfoSaved = true;
        this.replacesSessionId = undefined;
        this._preparedRolloverSessionId = null;
      }
      this._pendingUserPrompt = null;
      this.clearPendingAppServerSteers(`codex app-server error: ${err?.message || String(err)}`);
      if (isTimedOutCodexThreadResume(err) || isCodexActiveWriterError(err)) {
        const reason = isTimedOutCodexThreadResume(err)
          ? `timed-out thread resume after ${err.timeoutMs}ms`
          : "thread resume rejected because another writer owns the thread";
        console.warn(`[codex app-server] Discarding ${reason}`);
        try {
          await this.stopAppServerClient(true);
        } catch (stopError: any) {
          console.error(
            `[codex app-server] Failed to terminate rejected resume: ${stopError?.message || stopError}`
          );
        }
      }
      if (!isCodexAuthError(err)) {
        // The caller emits the canonical prompt_failed event with the stable
        // user-message ID. Mark this handled so it does not also emit a
        // second generic error card for the same failure.
        if (err && typeof err === "object") err.socketAgentSurfaced = true;
      }
      throw err;
    } finally {
      this._isRunning = false;
      this._runStartedAt = null;
      this.activeAppServerTurnId = null;
      this.appServerTurnSettler = null;
      this.onActivity?.();
      if (this.appServerAuthenticationInvalidated) {
        await this.resetInvalidatedAppServerAuthentication();
      } else if (CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS <= 0) {
        await this.stopAppServerClient();
      } else {
        this.scheduleAppServerIdleStop(CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS);
      }
    }
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServerStopPromise) await this.appServerStopPromise;
    if (this._abortRequested) {
      throw new Error("Codex turn interrupted");
    }
    if (this.appServerIdleStopTimer) {
      clearTimeout(this.appServerIdleStopTimer);
      this.appServerIdleStopTimer = null;
    }
    if (!this.appServer) {
      const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
      const socketAgentSessionId = this.sessionId || this.threadId || this._resumeSessionId || "";
      const codexEnv: NodeJS.ProcessEnv = { ...codex.env };
      codexEnv.SOCKETAGENT_PORT = process.env.PORT || "8085";
      if (socketAgentSessionId) {
        codexEnv.SOCKETAGENT_SESSION_ID = socketAgentSessionId;
        codexEnv.SOCKETAGENT_BACKEND = "codex";
      }
      this.appServer = new CodexAppServerClient({
        cwd: this.cwd,
        command: codex.command,
        args: codex.args,
        env: codexEnv,
        shell: codex.shell,
        requestTimeoutMs: 60_000,
        startupTimeoutMs: 30_000,
      });
      this.appServer.on("notification", (notification: CodexAppServerNotification) => {
        this.handleAppServerNotification(notification.method, notification.params);
        this.onActivity?.();
      });
      this.appServer.on("response", () => {
        this.scheduleAppServerIdleStop();
      });
      this.appServer.on("stderr", (chunk: string) => {
        this._stderrBuffer.push(chunk);
      });
      this.appServer.on("serverRequest", (
        request: { id?: string | number; method?: string; params?: unknown },
        respond: CodexAppServerRequestResponder,
      ) => {
        void this.handleAppServerRequest(request, respond);
      });
      this.appServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (this._isRunning && !this._abortRequested) {
          this.appServerTurnSettler?.reject(new Error(`codex app-server exited code=${code} signal=${signal}`));
        }
      });
      // Codex "error" notifications (e.g. usageLimitExceeded / systemError)
      // arrive here on a non-reserved channel so they cannot crash the process.
      // Surface the real message to the client instead of failing silently.
      this.appServer.on("errorNotification", (params: any) => {
        this.handleAppServerErrorNotification(params);
      });
      // Guard genuine client errors (e.g. spawn failure) so an emitted
      // "error" event never becomes an uncaught ERR_UNHANDLED_ERROR.
      this.appServer.on("error", (err: Error) => {
        this._stderrBuffer.push(`[codex app-server error] ${err?.message || String(err)}\n`);
        if (this._isRunning && !this._abortRequested) {
          this.appServerTurnSettler?.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }

    if (this.appServerInitialized) return;
    if (this.appServerInitializePromise) {
      await this.appServerInitializePromise;
      return;
    }
    this.appServerInitializePromise = (async () => {
      await this.appServer!.initialize({
        clientInfo: {
          name: "socketagent",
          title: "SocketAgent",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.appServerInitialized = true;
    })();
    try {
      await this.appServerInitializePromise;
    } finally {
      this.appServerInitializePromise = null;
    }
  }

  private handleAppServerErrorNotification(params: any): void {
    if (isRecoverableCodexAppServerError(params)) {
      const sid = this.sessionId;
      if (sid) {
        this.send({
          type: "session_state_changed",
          state: "running",
          sessionId: sid,
          ...(this.activeStartedAt ? { activeStartedAt: this.activeStartedAt } : {}),
        } as any);
      }
      return;
    }
    const message = codexAppServerErrorMessage(params, "Codex reported an error");
    const sid = this.sessionId;
    if (sid) {
      this.send({ type: "session_state_changed", state: "idle", sessionId: sid } as any);
      if (isCodexAuthError(params) || isCodexAuthError(message)) {
        void this.handleAppServerAuthFailure(message, {
          hintedMcp: isMcpAuthSignal(params) || isMcpAuthSignal(message),
          terminal: true,
        });
        return;
      } else {
        this.send({ type: "error", message: `Codex: ${message}`, sessionId: sid } as any);
      }
    }
    this.appServerTurnSettler?.reject(new Error(message));
  }

  private async classifyAppServerAuthFailure(hintedMcp: boolean): Promise<CodexAuthScope> {
    if (this.appServerAuthCheck) return this.appServerAuthCheck;
    const client = this.appServer;
    if (!client) return hintedMcp ? "mcp" : "unknown";

    const check = (async (): Promise<CodexAuthScope> => {
      try {
        const raw = await client.readAccount(true);
        return codexAuthScopeFromAccountRead(raw, hintedMcp);
      } catch (error) {
        // A forced managed-token refresh failing with an auth error is the
        // authoritative primary-account signal. Other failures leave the MCP
        // hint in charge rather than turning every downstream 401 into logout.
        if (isCodexAuthError(error)) return "openai";
        return hintedMcp ? "mcp" : "unknown";
      }
    })();
    this.appServerAuthCheck = check;
    try {
      return await check;
    } finally {
      if (this.appServerAuthCheck === check) this.appServerAuthCheck = null;
    }
  }

  private emitPrimaryAuthRequired(detail: string): void {
    const nowMs = Date.now();
    if (nowMs - this.lastPrimaryAuthRequiredAt < 30_000) return;
    this.lastPrimaryAuthRequiredAt = nowMs;
    this.send({
      type: "backend_auth_required",
      backend: "codex",
      authScope: "openai",
      sessionId: this.sessionId || undefined,
      message: "Your OpenAI sign-in has expired. Re-authenticate to continue using Codex.",
      detail,
    } as any);
  }

  private emitMcpAuthRequired(detail: string, name = "Connected app"): void {
    const key = name.trim().toLowerCase() || "connected app";
    if (this.surfacedMcpAuth.has(key)) return;
    this.surfacedMcpAuth.add(key);
    this.send({
      type: "backend_auth_required",
      backend: "codex",
      authScope: "mcp",
      mcpServerName: name,
      sessionId: this.sessionId || undefined,
      message: `${name} needs to be reconnected.`,
      detail,
    } as any);
  }

  private async handleAppServerAuthFailure(
    detail: string,
    options: { hintedMcp: boolean; terminal: boolean; mcpServerName?: string },
  ): Promise<void> {
    const scope = await this.classifyAppServerAuthFailure(options.hintedMcp);
    if (scope === "openai") {
      this.emitPrimaryAuthRequired(detail);
    } else if (scope === "mcp") {
      this.emitMcpAuthRequired(detail, options.mcpServerName);
    }

    if (!options.terminal) return;
    const error = new Error(detail);
    if (scope === "openai") {
      (error as any).codexPrimaryAuthSurfaced = true;
    } else if (scope === "mcp") {
      (error as any).codexMcpAuth = true;
      (error as any).socketAgentSurfaced = true;
    }
    this.appServerTurnSettler?.reject(error);
  }

  private scheduleAppServerIdleStop(delayMs = CODEX_APP_SERVER_WARM_IDLE_TIMEOUT_MS): void {
    if (!this.appServer || this.isBusy) return;
    if (delayMs <= 0) {
      void this.stopAppServerClient();
      return;
    }
    if (this.appServerIdleStopTimer) clearTimeout(this.appServerIdleStopTimer);
    this.appServerIdleStopTimer = setTimeout(() => {
      this.appServerIdleStopTimer = null;
      if (!this.appServer || this.isBusy) return;
      void this.stopAppServerClient();
    }, delayMs);
  }

  private async stopAppServerClient(requireConfirmedExit = false): Promise<void> {
    if (this.appServerStopPromise) {
      await this.appServerStopPromise;
      return;
    }
    if (this.appServerIdleStopTimer) {
      clearTimeout(this.appServerIdleStopTimer);
      this.appServerIdleStopTimer = null;
    }
    const client = this.appServer;
    this.appServer = null;
    this.appServerInitialized = false;
    this.appServerInitializePromise = null;
    if (this.appServerMcpRegistration) {
      this.appServerMcpRegistration.unregister();
      this.appServerMcpRegistration = null;
    }
    if (!client) return;
    let stopped = false;
    const stopPromise = (async () => {
      try {
        await client.stop(
          requireConfirmedExit ? "SIGKILL" : "SIGTERM",
          requireConfirmedExit ? 250 : 3000,
          requireConfirmedExit,
        );
        stopped = true;
      } catch (err: any) {
        if (requireConfirmedExit) {
          // Keep the process handle reachable so a retransmitted hard stop can
          // attempt termination again instead of falsely treating it as absent.
          this.appServer = client;
          throw err;
        }
        console.warn(`[codex app-server] cleanup failed: ${err?.message || err}`);
      } finally {
        if (stopped || !requireConfirmedExit) {
          client.removeAllListeners();
          this.onClose?.();
        }
      }
    })();
    this.appServerStopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.appServerStopPromise === stopPromise) {
        this.appServerStopPromise = null;
      }
    }
  }

  async dispose(): Promise<void> {
    this.streamSnapshots.dispose(true);
    this.cancelPendingAppServerTurnCompletion();
    await this.stopAppServerClient(true);
  }

  async closeWarmIdle(): Promise<void> {
    if (!this.isWarmIdle) return;
    await this.stopAppServerClient();
  }

  async invalidateAppServerAuthentication(): Promise<void> {
    this.appServerAuthenticationInvalidated = true;
    if (!this.isBusy) await this.resetInvalidatedAppServerAuthentication();
  }

  private async resetInvalidatedAppServerAuthentication(): Promise<void> {
    if (!this.appServerAuthenticationInvalidated) return;
    await this.stopAppServerClient(true);
    this.appServerAuthenticationInvalidated = false;
  }

  private buildAppServerThreadParams(): {
    cwd: string;
    sandbox: SandboxMode;
    approvalPolicy: CodexAppServerApprovalPolicy;
    approvalsReviewer: CodexAppServerApprovalsReviewer;
    model?: string;
    config: Record<string, unknown>;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
  } {
    const model = this.codexModel();
    return {
      cwd: this.cwd,
      sandbox: this._sandbox,
      approvalPolicy: this._approvalPolicy,
      approvalsReviewer: this._approvalsReviewer,
      ...(model ? { model } : {}),
      config: this.appServerConfig(),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
  }

  private appServerConfig(): Record<string, unknown> {
    if (!this.appServerMcpRegistration) {
      this.appServerMcpRegistration = registerCodexAppMcp(this.createAppToolContext());
    }
    const mcpUrl = this.buildCodexMcpUrl(this.appServerMcpRegistration.token);
    const config: Record<string, unknown> = {
      model_reasoning_effort: this.codexReasoningEffort(),
      mcp_servers: {
        socketagent_app: {
          url: mcpUrl,
        },
      },
    };
    if (this._fastMode) {
      config.service_tier = "fast";
      config.features = { fast_mode: true };
    }
    return config;
  }

  private buildCodexTurnText(prompt: string): string {
    return prompt;
  }

  private buildAppServerTurnInput(prompt: string): CodexAppServerUserInput[] {
    const slashSkill = this.resolveCodexSlashSkill(prompt);
    if (!slashSkill) {
      return [{ type: "text", text: this.buildCodexTurnText(prompt), text_elements: [] }];
    }

    const text = slashSkill.args || `Use the /${slashSkill.skill.name} skill.`;
    return [
      {
        type: "skill",
        name: slashSkill.skill.name,
        path: slashSkill.skill.filePath,
      },
      {
        type: "text",
        text: this.buildCodexTurnText(text),
        text_elements: [],
      },
    ];
  }

  private resolveCodexSlashSkill(prompt: string): { skill: SkillEntry; args: string } | null {
    const match = prompt.match(/^\/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const requestedName = (match[1] || match[2] || match[3]).toLowerCase();
    const skills = listSkills(this.cwd).filter((skill) =>
      skill.agent === "codex" &&
      skill.format === "skill" &&
      skill.name.toLowerCase() === requestedName
    );
    if (skills.length === 0) return null;

    const scopeRank: Record<string, number> = { project: 0, user: 1, plugin: 2 };
    skills.sort((a, b) => {
      const scopeCmp = (scopeRank[a.scope] ?? 99) - (scopeRank[b.scope] ?? 99);
      if (scopeCmp !== 0) return scopeCmp;
      return a.filePath.localeCompare(b.filePath);
    });

    return {
      skill: skills[0],
      args: (match[4] || "").trim(),
    };
  }

  private extractThreadId(value: unknown): string | null {
    const v = value as any;
    return v?.thread?.id || v?.threadId || null;
  }

  private extractTurnId(value: unknown): string | null {
    const v = value as any;
    return v?.turn?.id || v?.turnId || null;
  }

  private adoptAppServerThread(threadId: string | null): void {
    if (!threadId) return;
    const previousSessionId = this.sessionId
      || this.threadId
      || this.replacesSessionId
      || this._resumeSessionId
      || null;
    this.threadId = threadId;
    const isFirstTime = !this.sessionId;
    const replacesSessionId = this.replacesSessionId;
    this.sessionId = threadId;
    if (previousSessionId && previousSessionId !== threadId) {
      this.onSessionIdChanged?.(previousSessionId, threadId);
    }

    if (!this._sessionInfoSaved) {
      const title =
        this._currentPrompt.slice(0, 50) +
        (this._currentPrompt.length > 50 ? "..." : "");
      const info: SessionInfo = {
        id: this.sessionId,
        title,
        cwd: this.cwd,
        createdAt: now(),
        lastActive: now(),
        messagePreview: "",
        backend: "codex",
        codexDriver: "app-server",
        permissionMode: this.permissionMode || undefined,
        agentSettings: this.getAgentSettings(),
      };
      let visibleTitle = title;
      if (replacesSessionId) {
        remapSession(replacesSessionId, this.sessionId);
        remapSessionMemory(replacesSessionId, this.sessionId);
        void this.appServer?.archiveThread(replacesSessionId).catch((error: unknown) => {
          console.warn(`[SessionMemory] Could not archive prior Codex thread ${replacesSessionId}: ${String(error)}`);
        });
        const remapped = getSession(this.sessionId);
        const replacementInfo: SessionInfo = {
          ...info,
          ...remapped,
          id: this.sessionId,
          backend: "codex",
          codexDriver: "app-server",
          messagePreview: "",
          permissionMode: this.permissionMode || undefined,
          agentSettings: this.getAgentSettings(),
        };
        saveSession(replacementInfo);
        visibleTitle = replacementInfo.title;
        void this.appServer?.setThreadName(this.sessionId, visibleTitle).catch((error: unknown) => {
          console.warn(`[SessionMemory] Could not copy title to new Codex thread ${this.sessionId}: ${String(error)}`);
        });
        this.replacesSessionId = undefined;
        this._preparedRolloverSessionId = null;
      } else {
        saveSession(info);
      }
      this._sessionInfoSaved = true;

      if (isFirstTime) {
        this.appendPermissionModeHistory();
        this.send({
          type: "session_created",
          sessionId: this.sessionId,
          ...(replacesSessionId ? { replacesSessionId } : {}),
          cwd: this.cwd,
          title: visibleTitle,
          backend: "codex",
          permissionMode: this.permissionMode,
        } as ServerMessage);
        this.send({
          type: "permission_mode_changed",
          permissionMode: this.permissionMode,
        } as any);
        this.send({
          type: "session_settings",
          sessionId: this.sessionId,
          settings: this.getAgentSettings(),
        } as any);
      }
    }

  }

  private flushPendingUserPrompt(): void {
    if (!this.sessionId || !this._pendingUserPrompt) return;
    const historyEntry = appendHistory(this.sessionId, {
      role: "user",
      content: this._pendingUserPrompt.text,
      uuid: this._pendingUserPrompt.uuid,
      timestamp: now(),
    });
    this.send({
      type: "user_message_uuid",
      uuid: this._pendingUserPrompt.uuid,
      sessionId: this.sessionId,
      entryId: historyEntry.entryId,
      sessionSeq: historyEntry.sessionSeq,
      revision: historyEntry.revision,
      ...(this._pendingUserPrompt.messageId ? { clientMessageId: this._pendingUserPrompt.messageId } : {}),
    } as any);
    this._pendingUserPrompt = null;
  }

  private createAppToolContext(): AppToolContext {
    return {
      getSessionId: () => this.sessionId || "",
      getDelegationSupervisorSessionId: () =>
        String(
          (this as any)._delegationSupervisorSessionId ||
            getSession(this.sessionId || "")?.delegationSupervisorSessionId ||
            this.sessionId ||
            "",
        ),
      getCwd: () => this.cwd,
      getBackend: () => "codex",
      getCodexDriver: () => "app-server",
      send: (msg) => this.send(msg as ServerMessage),
      appendHistory: (entry) => {
        if (this.sessionId) return appendHistory(this.sessionId, entry as HistoryEntry);
      },
      getTtsEngine: () => this._ttsEngine,
      getKokoroVoice: () => this._kokoroVoice,
      getKokoroSpeed: () => this._kokoroSpeed,
      isRunning: () => this.isRunning,
      injectMessage: (text, priority) => this.injectMessage(text, priority),
      onMonitorOutput: (text) => this.onMonitorOutput?.(text),
      manageAgentSession: (args) => {
        if (!this.onAgentSessionRequest) {
          throw new Error("AgentSession runtime is not attached");
        }
        return this.onAgentSessionRequest(args);
      },
      reportSubagentAssignment: (agentPath, prompt) =>
        this.reportCodexSubagentAssignment(agentPath, prompt),
      requestPluginAuthorization: async (pluginName) => {
        const plugin = this._plugins.find((candidate) => candidate.name === pluginName);
        if (!plugin?.requestAuthorization) {
          throw new Error(`Private integration is not available: ${pluginName}`);
        }
        return await plugin.requestAuthorization(this.getSessionContext());
      },
    };
  }

  /** Mirrors the abort path. Interrupt the active app-server turn if possible. */
  async abort(): Promise<void> {
    this.streamSnapshots.flushAll();
    this._abortRequested = true;
    this.cancelPendingAppServerTurnCompletion();
    this.clearQueuedPrompts("Codex turn interrupted");
    this.clearPendingAppServerSteers("Codex turn interrupted");
    this.settleActiveAppServerToolCalls("(interrupted)");
    const client = this.appServer;
    if (client && this.threadId && this.activeAppServerTurnId) {
      void client.interruptTurn({
        threadId: this.threadId,
        turnId: this.activeAppServerTurnId,
      }).catch((err) => {
        console.warn(`[codex app-server] turn interrupt failed: ${err.message}`);
      });
    }
    this.appServerTurnSettler?.resolve();
    this.appServerTurnSettler = null;
    this._isRunning = false;
    this._isCompacting = false;
    this._runStartedAt = null;
    this._compactStartedAt = null;
    this.onActivity?.();
    if (this.sessionId) {
      this.send({
        type: "result",
        content: "(interrupted)",
        sessionId: this.sessionId,
      } as ServerMessage);
    }
    const sid = this.sessionId || this._resumeSessionId || "";
    await Promise.all([
      this.stopAppServerClient(true),
      sid ? stopAppMonitorsForSession(sid) : Promise.resolve(0),
    ]);
  }

  private dequeueNextPrompt(): QueuedPrompt | null {
    if (this._queuedPrompts.length === 0) return null;
    const nowIdx = this._queuedPrompts.findIndex((p) => p.priority === "now");
    if (nowIdx >= 0) return this._queuedPrompts.splice(nowIdx, 1)[0];
    return this._queuedPrompts.shift() ?? null;
  }

  private clearQueuedPrompts(reason: string): void {
    const queued = this._queuedPrompts.splice(0);
    for (const prompt of queued) {
      prompt.reject(new Error(reason));
    }
  }

  private clearPendingAppServerSteers(reason: string): void {
    const pending = this._pendingAppServerSteers.splice(0);
    for (const steer of pending) {
      steer.reject(new Error(reason));
    }
  }

  private requeuePendingAppServerSteers(reason: string): void {
    const pending = [...this._pendingAppServerSteers];
    for (const steer of pending) {
      this.requeuePendingAppServerSteer(steer, reason);
    }
  }

  private requeuePendingAppServerSteer(steer: PendingAppServerSteer, reason: string): void {
    const idx = this._pendingAppServerSteers.indexOf(steer);
    if (idx < 0) {
      console.warn(`[codex app-server] ${reason} after userMessage dispatch`);
      return;
    }
    this._pendingAppServerSteers.splice(idx, 1);
    console.warn(`[codex app-server] ${reason}; queueing follow-up`);
    this._queuedPrompts.push({
      text: steer.text,
      priority: steer.priority,
      messageId: steer.messageId,
      fastMode: steer.fastMode,
      resolve: steer.resolve,
      reject: steer.reject,
    });
    this.runQueuedPromptIfIdle();
  }

  private runQueuedPromptIfIdle(): void {
    if (this._isRunning || this._abortRequested) return;
    const nextPrompt = this.dequeueNextPrompt();
    if (!nextPrompt) return;
    void this.runQueryWithOptions(nextPrompt.text, undefined, {
      fastMode: nextPrompt.fastMode,
      messageId: nextPrompt.messageId,
    })
      .then(() => nextPrompt.resolve())
      .catch((err) => nextPrompt.reject(err instanceof Error ? err : new Error(String(err))));
  }

  private flushPendingAppServerSteers(): void {
    if (!this.appServer || !this.threadId || !this.activeAppServerTurnId) return;
    this.flushPendingUserPrompt();
    for (const pending of [...this._pendingAppServerSteers]) {
      this.sendPendingAppServerSteer(pending);
    }
  }

  private sendPendingAppServerSteer(pending: PendingAppServerSteer): void {
    if (pending.steerSent) return;
    if (!this.appServer || !this.threadId || !this.activeAppServerTurnId) return;
    pending.steerSent = true;
    pending.steerAttempts = (pending.steerAttempts || 0) + 1;
    const turnId = this.activeAppServerTurnId;
    console.log(`[codex app-server] steering message mid-turn (thread=${this.threadId}, turn=${turnId}, priority=${pending.priority}, messageId=${pending.messageId || ""})`);
    this.appServer.steerTurn({
      threadId: this.threadId,
      clientUserMessageId: pending.uuid,
      expectedTurnId: turnId,
      input: this.buildAppServerTurnInput(pending.text),
    })
      .then(() => {
        console.log(`[codex app-server] turn/steer accepted (turn=${turnId}, messageId=${pending.messageId || ""})`);
        this.acknowledgeAcceptedAppServerSteer(pending);
      })
      .catch((err: any) => {
        const authoritativeTurnId = authoritativeTurnIdFromSteerError(err);
        if (
          authoritativeTurnId
          && authoritativeTurnId !== turnId
          && (pending.steerAttempts || 0) < 3
          && this._pendingAppServerSteers.includes(pending)
        ) {
          console.warn(`[codex app-server] adopting authoritative active turn ${authoritativeTurnId} after stale steer target ${turnId}`);
          this.activeAppServerTurnId = authoritativeTurnId;
          pending.steerSent = false;
          this.sendPendingAppServerSteer(pending);
          return;
        }
        this.requeuePendingAppServerSteer(pending, `turn/steer failed: ${err?.message || String(err)}`);
      });
  }

  private acknowledgeAcceptedAppServerSteer(pending: PendingAppServerSteer): void {
    const idx = this._pendingAppServerSteers.indexOf(pending);
    if (idx < 0) return;
    this._pendingAppServerSteers.splice(idx, 1);
    this.persistAcceptedInjectedPrompt(pending);
    pending.resolve();
  }

  private persistAcceptedInjectedPrompt(prompt: { text: string; uuid: string; messageId?: string }): void {
    const sid = this.sessionId;
    if (!sid) return;
    const historyEntry = appendHistory(sid, {
      role: "user",
      content: prompt.text,
      uuid: prompt.uuid,
      timestamp: now(),
    });
    this.send({
      type: "user_message_uuid",
      uuid: prompt.uuid,
      sessionId: sid,
      entryId: historyEntry.entryId,
      sessionSeq: historyEntry.sessionSeq,
      revision: historyEntry.revision,
      ...(prompt.messageId ? { clientMessageId: prompt.messageId } : {}),
    } as any);
  }

  private async handleAppServerRequest(
    request: { id?: string | number; method?: string; params?: unknown },
    respond: CodexAppServerRequestResponder,
  ): Promise<void> {
    const method = request.method || "unknown";
    const params = (request.params || {}) as any;
    try {
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const command = String(params.command || "");
          const allowed = await this.canApproveAppServerTool("Bash", {
            command,
          });
          respond({ result: { decision: allowed ? "accept" : "decline" } });
          return;
        }

        case "execCommandApproval": {
          const command = Array.isArray(params.command)
            ? params.command.join(" ")
            : String(params.command || "");
          const allowed = await this.canApproveAppServerTool("Bash", {
            command,
          });
          respond({ result: { decision: allowed ? "approved" : "denied" } });
          return;
        }

        case "item/fileChange/requestApproval": {
          const allowed = await this.canApproveAppServerFileChange(params.itemId);
          respond({ result: { decision: allowed ? "accept" : "decline" } });
          return;
        }

        case "item/tool/requestUserInput": {
          await this.handleAppServerUserInput(params, respond, request.id);
          return;
        }

        case "applyPatchApproval": {
          const allowed = await this.canApproveLegacyApplyPatch(params.fileChanges);
          respond({ result: { decision: allowed ? "approved" : "denied" } });
          return;
        }

        case "item/permissions/requestApproval": {
          const permissionsAllowed = await this.canApprovePermissionRequest(params.permissions);
          respond({
            result: {
              permissions: permissionsAllowed
                ? (params.permissions || {})
                : { network: null, fileSystem: null },
              scope: "turn",
              strictAutoReview: true,
            },
          });
          return;
        }

        case "mcpServer/elicitation/request": {
          await this.handleMcpServerElicitation(params, respond, request.id);
          return;
        }

        default:
          console.warn(`[codex app-server] unsupported server request: ${method}`);
          respond({
            error: {
              code: "unsupported_server_request",
              message: `SocketAgent does not handle Codex app-server request '${method}' yet`,
            },
          });
      }
    } catch (err: any) {
      console.error(`[codex app-server] approval request failed: ${err?.message || String(err)}`);
      respond({
        error: {
          code: "socketagent_approval_error",
          message: err?.message || String(err),
        },
      });
    }
  }

  private async handleMcpServerElicitation(
    params: Record<string, any>,
    respond: CodexAppServerRequestResponder,
    requestId?: string | number,
  ): Promise<void> {
    const prepared = prepareCodexMcpElicitation(params);
    const serverName = prepared.serverName;
    const normalizedServerName = serverName.toLowerCase().replace(/-/g, "_");
    const isSocketAgentAppServer = normalizedServerName === "socketagent_app"
      || normalizedServerName === "socketagent"
      || serverName === "SocketAgent";

    if (isSocketAgentAppServer) {
      console.log(
        `[codex app-server] accepted internal MCP elicitation server=${serverName || "unknown"} mode=${prepared.mode} message=${prepared.message.slice(0, 160)}`,
      );
      respond({ result: { action: "accept", content: {}, _meta: null } });
      return;
    }

    const fallbackQuestion = prepared.fallbackApproval ? prepared.questions[0] : undefined;
    const confirmation = fallbackQuestion
      ? connectedAppConfirmation(fallbackQuestion.question, fallbackQuestion.options)
      : null;
    if (confirmation && this.shouldAutoApproveConnectedApp(confirmation.appKey)) {
      console.log(
        `[codex app-server] auto-approved connected app=${confirmation.appKey} mode=${this._permissionMode}`,
      );
      respond({ result: { action: "accept", content: {}, _meta: null } });
      return;
    }
    if (confirmation && fallbackQuestion) {
      fallbackQuestion.options.push({
        label: confirmation.sessionLabel,
        description: `Automatically approve ${confirmation.appLabel} confirmations for this SocketAgent session.`,
      });
    }

    const sessionId = this.sessionId || this._resumeSessionId || String(params.threadId || "");
    const questionId = createInteractiveRequestId("codex_elicit");
    if (requestId !== undefined) {
      this.appServerQuestionByRequestId.set(String(requestId), questionId);
    }

    if (prepared.mode === "url" && prepared.url) {
      const message: ServerMessage = {
        type: "elicitation_url",
        questionId,
        mcpServerName: serverName,
        message: prepared.message,
        url: prepared.url,
        elicitationId: prepared.elicitationId,
        sessionId,
      } as ServerMessage;
      this.send(message);
      if (sessionId) {
        appendHistory(sessionId, {
          role: "elicitation_url",
          content: prepared.message,
          questionId,
          mcpServerName: serverName,
          url: prepared.url,
          timestamp: now(),
        });
      }
      const answers = await new Promise<Record<string, string>>((resolve) => {
        this.pendingQuestions.set(questionId, { questionId, resolve, questionData: message });
      });
      this.clearAppServerQuestionMapping(questionId);
      const answer = String(Object.values(answers)[0] || "");
      const accepted = !/\b(?:cancel|decline|reject)\b/i.test(answer);
      respond({
        result: {
          action: accepted ? "accept" : "decline",
          content: null,
          _meta: null,
        },
      });
      return;
    }

    const questionMessage: ServerMessage = {
      type: "question",
      questionId,
      questions: prepared.questions,
      sessionId,
      mcpServerName: serverName,
    } as ServerMessage;
    this.send(questionMessage);
    if (sessionId) {
      appendHistory(sessionId, {
        role: "question",
        content: prepared.message,
        questionId,
        questions: prepared.questions,
        timestamp: now(),
      });
    }
    console.log(
      `[codex app-server] awaiting MCP elicitation server=${serverName || "unknown"} mode=${prepared.mode} questionId=${questionId} message=${prepared.message.slice(0, 160)}`,
    );
    const answers = await new Promise<Record<string, string>>((resolve) => {
      this.pendingQuestions.set(questionId, { questionId, resolve, questionData: questionMessage });
    });
    this.clearAppServerQuestionMapping(questionId);
    if (confirmation && fallbackQuestion) {
      const answer = String(answers[fallbackQuestion.question] || "");
      if (answer.includes(confirmation.sessionLabel)) {
        this.rememberConnectedAppApproval(confirmation.appKey);
        answers[fallbackQuestion.question] = confirmation.approveLabel;
      }
    }
    const result = resolveCodexMcpElicitation(prepared, answers);
    console.log(
      `[codex app-server] answered MCP elicitation server=${serverName || "unknown"} action=${result.action} questionId=${questionId}`,
    );
    respond({ result });
  }

  private async handleAppServerUserInput(
    params: Record<string, any>,
    respond: CodexAppServerRequestResponder,
    requestId?: string | number,
  ): Promise<void> {
    const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
    const secretQuestion = rawQuestions.find((question: any) => question?.isSecret === true);
    if (secretQuestion) {
      throw new Error(
        "Codex requested secret text through request_user_input. Use SocketAgent RequestSecureInput so the value is not stored in chat history.",
      );
    }
    if (rawQuestions.length === 0) {
      respond({ result: { answers: {} } });
      return;
    }

    const sessionId = this.sessionId || this._resumeSessionId || String(params.threadId || "");
    const questionId = createInteractiveRequestId("codex_input");
    if (requestId !== undefined) {
      this.appServerQuestionByRequestId.set(String(requestId), questionId);
    }
    const questionIds = new Map<string, string>();
    const confirmations = new Map<string, ConnectedAppConfirmation>();
    const automaticAnswers: Record<string, { answers: string[] }> = {};
    const usedText = new Set<string>();
    const questions = rawQuestions.flatMap((rawQuestion: any, index: number) => {
      const baseText = String(rawQuestion?.question || `Question ${index + 1}`).trim();
      let question = baseText || `Question ${index + 1}`;
      let suffix = 2;
      while (usedText.has(question)) question = `${baseText} (${suffix++})`;
      usedText.add(question);
      const id = String(rawQuestion?.id || `question_${index + 1}`);
      const options = Array.isArray(rawQuestion?.options)
        ? rawQuestion.options.map((option: any) => ({
            label: String(option?.label || ""),
            ...(option?.description ? { description: String(option.description) } : {}),
          })).filter((option: any) => option.label)
        : [];
      const confirmation = connectedAppConfirmation(question, options);
      if (confirmation && this.shouldAutoApproveConnectedApp(confirmation.appKey)) {
        automaticAnswers[id] = { answers: [confirmation.approveLabel] };
        return [];
      }
      questionIds.set(question, id);
      if (confirmation) {
        confirmations.set(question, confirmation);
        options.push({
          label: confirmation.sessionLabel,
          description: `Automatically approve ${confirmation.appLabel} confirmations for this SocketAgent session.`,
        });
      }
      return [{
        question,
        header: String(rawQuestion?.header || "Input"),
        options,
        multiSelect: false,
      }];
    });
    if (questions.length === 0) {
      this.clearAppServerQuestionMapping(questionId);
      respond({ result: { answers: automaticAnswers } });
      return;
    }
    const questionMessage: ServerMessage = {
      type: "question",
      questionId,
      questions,
      sessionId,
    } as ServerMessage;
    this.send(questionMessage);
    if (sessionId) {
      appendHistory(sessionId, {
        role: "question",
        content: "",
        questionId,
        questions,
        timestamp: now(),
      });
    }

    const autoResolutionMs = Number(params.autoResolutionMs);
    const answers = await new Promise<Record<string, string>>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: Record<string, string>) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      this.pendingQuestions.set(questionId, {
        questionId,
        resolve: finish,
        questionData: questionMessage,
      });
      if (Number.isFinite(autoResolutionMs) && autoResolutionMs > 0) {
        timer = setTimeout(() => {
          if (!this.pendingQuestions.delete(questionId)) return;
          this.clearAppServerQuestionMapping(questionId);
          if (sessionId) markQuestionAnswered(sessionId, questionId, {});
          this.send({ type: "question_answered", questionId, sessionId, answers: {} } as any);
          resolve({});
        }, autoResolutionMs);
        timer.unref?.();
      }
    });
    this.clearAppServerQuestionMapping(questionId);

    const responseAnswers: Record<string, { answers: string[] }> = {
      ...automaticAnswers,
    };
    for (const [question, answer] of Object.entries(answers)) {
      const id = questionIds.get(question);
      if (!id || !answer.trim()) continue;
      const confirmation = confirmations.get(question);
      let resolvedAnswer = answer;
      if (confirmation && answer.includes(confirmation.sessionLabel)) {
        this.rememberConnectedAppApproval(confirmation.appKey);
        resolvedAnswer = confirmation.approveLabel;
      }
      responseAnswers[id] = {
        answers: resolvedAnswer
          .split(/\s*\u2014\s*/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
    }
    respond({ result: { answers: responseAnswers } });
  }

  private async canApproveAppServerTool(
    toolName: string,
    input: Record<string, any>,
  ): Promise<boolean> {
    const sessionCtx = this.getSessionContext();
    for (const plugin of this._plugins) {
      if (!plugin.canUseToolInterceptor) continue;
      const result = await plugin.canUseToolInterceptor(toolName, input, sessionCtx);
      if (!result) continue;
      return result.behavior !== "deny";
    }
    return true;
  }

  private async canApproveAppServerFileChange(itemId: unknown): Promise<boolean> {
    if (!itemId) return true;
    const paths = this.appServerFileChangePaths.get(String(itemId)) || [];
    if (paths.length === 0) return true;
    for (const filePath of paths) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: filePath,
      });
      if (!allowed) return false;
    }
    return true;
  }

  private async canApprovePermissionRequest(permissions: any): Promise<boolean> {
    const fileSystem = permissions?.fileSystem || null;
    const writePaths = [
      ...(Array.isArray(fileSystem?.write) ? fileSystem.write : []),
      ...(Array.isArray(fileSystem?.entries)
        ? fileSystem.entries
            .filter((entry: any) => entry?.access === "write" || entry?.writable === true)
            .map((entry: any) => entry?.path || entry?.root || entry?.glob)
        : []),
    ].filter(Boolean);
    for (const filePath of writePaths) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: String(filePath),
      });
      if (!allowed) return false;
    }
    return true;
  }

  private async canApproveLegacyApplyPatch(fileChanges: unknown): Promise<boolean> {
    if (!fileChanges || typeof fileChanges !== "object") return true;
    for (const filePath of Object.keys(fileChanges as Record<string, unknown>)) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: filePath,
      });
      if (!allowed) return false;
    }
    return true;
  }

  private handleAppServerNotification(method: string, params: unknown): void {
    const p = params as any;
    this.emitAppServerRawEvent(method, p);
    switch (method) {
      case "thread/started":
        {
          const startedThreadId = String(p?.thread?.id || p?.threadId || "");
          if (!startedThreadId) return;
          if (!this.threadId || startedThreadId === this.threadId) {
            this.adoptAppServerThread(startedThreadId);
          } else {
            const agent = this.registerCodexSubagent(startedThreadId, {
              agentPath: String(p?.agentPath || p?.thread?.agentPath || ""),
            });
            if (agent) this.updateCodexSubagentStatus(agent.agentId, "running");
          }
        }
        return;

      case "turn/started":
        if (p?.threadId && p.threadId !== this.threadId) {
          const agent = this.registerCodexSubagent(String(p.threadId));
          if (agent) this.updateCodexSubagentStatus(agent.agentId, "active");
          return;
        }
        // A new root turn inside the completion grace window is Codex goal
        // auto-continuation, not a new SocketAgent run. Keep the original run
        // alive and cancel the intermediate completion before the app can
        // hide its Stop control.
        this.cancelPendingAppServerTurnCompletion();
        this._isRunning = true;
        this._runStartedAt ||= new Date().toISOString();
        this.activeAppServerTurnId = p?.turn?.id || p?.turnId || this.activeAppServerTurnId;
        this.flushPendingAppServerSteers();
        if (this.sessionId) {
          this.send({
            type: "session_state_changed",
            state: "running",
            sessionId: this.sessionId,
            ...(this.activeStartedAt ? { activeStartedAt: this.activeStartedAt } : {}),
          } as any);
        }
        this.onActivity?.();
        return;

      case "thread/status/changed": {
        const sid = this.sessionId;
        if (!sid) return;
        const statusType = p?.status?.type;
        const statusThreadId = String(p?.threadId || "");
        if (statusThreadId && statusThreadId !== this.threadId) {
          if (statusType === "active" || statusType === "running" || statusType === "pendingInit") {
            this.registerCodexSubagent(statusThreadId);
          }
          this.updateCodexSubagentStatus(
            statusThreadId,
            String(statusType || ""),
            p?.status?.message || p?.status?.error?.message,
          );
          return;
        }
        if (statusType === "active") {
          this.send({
            type: "session_state_changed",
            state: "running",
            sessionId: sid,
            ...(this.activeStartedAt ? { activeStartedAt: this.activeStartedAt } : {}),
          } as any);
        } else if (statusType === "idle" && !this._isRunning && !this.pendingAppServerTurnCompletion) {
          this.send({ type: "session_state_changed", state: "idle", sessionId: sid } as any);
        } else if (statusType === "systemError") {
          const message = codexAppServerErrorMessage(p, "Codex app-server entered systemError state");
          this.send({ type: "session_state_changed", state: "idle", sessionId: sid } as any);
          if (isCodexAuthError(p) || isCodexAuthError(message)) {
            void this.handleAppServerAuthFailure(message, {
              hintedMcp: isMcpAuthSignal(p) || isMcpAuthSignal(message),
              terminal: true,
            });
          } else {
            this.send({ type: "error", message, sessionId: sid } as any);
            this.appServerTurnSettler?.reject(new Error(message));
          }
        }
        return;
      }

      case "thread/goal/updated": {
        const threadId = String(p?.threadId || p?.goal?.threadId || "");
        if (!threadId || (this.threadId && threadId !== this.threadId)) return;
        const goal = normalizeCodexGoal(p?.goal);
        if (!goal) return;
        const sessionId = this.sessionId || this._resumeSessionId || threadId;
        this.send({
          type: "codex_goal_state",
          sessionId,
          goal,
          ok: true,
        } as any);
        return;
      }

      case "thread/goal/cleared": {
        const threadId = String(p?.threadId || "");
        if (!threadId || (this.threadId && threadId !== this.threadId)) return;
        const sessionId = this.sessionId || this._resumeSessionId || threadId;
        this.send({
          type: "codex_goal_state",
          sessionId,
          goal: null,
          ok: true,
        } as any);
        return;
      }

      case "thread/compacted": {
        const sid = this.sessionId || p?.threadId;
        if (!sid) return;
        this._isCompacting = false;
        this._compactStartedAt = null;
        this.send({ type: "compacting", active: false, sessionId: sid } as any);
        this.emitCompactBoundary(sid, this._compactBoundaryTrigger);
        this.scheduleAppServerIdleStop();
        return;
      }

      case "thread/name/updated": {
        const sid = String(p?.threadId || this.sessionId || "");
        const title = String(p?.threadName || "").trim();
        if (!sid || !title) return;
        const session = getSession(sid);
        if (session) {
          session.title = title;
          session.lastActive = now();
          saveSession(session);
        }
        return;
      }

      case "thread/settings/updated": {
        const sid = String(p?.threadId || "");
        if (!sid || (this.threadId && sid !== this.threadId)) return;
        const settings = p?.threadSettings || {};
        const model = String(settings.model || "").trim();
        if (model) this._model = model;
        const effort = String(settings.effort || "");
        if (effort === "minimal" || effort === "low" || effort === "medium"
          || effort === "high" || effort === "max" || effort === "xhigh"
          || effort === "ultra") {
          this._effort = effort;
        }
        const collaborationMode = String(settings?.collaborationMode?.mode || "").trim();
        if (collaborationMode) this._collaborationMode = collaborationMode;
        const cwd = String(settings.cwd || "").trim();
        if (cwd) this.cwd = cwd;
        this.persistAgentSettings(this.getAgentSettings());
        this.send({
          type: "session_settings",
          sessionId: sid,
          settings: this.getAgentSettings(),
        } as any);
        return;
      }

      case "serverRequest/resolved":
        this.resolveAppServerRequest(p?.requestId);
        return;

      case "item/agentMessage/delta": {
        const sid = this.sessionId;
        if (!sid) return;
        const itemId = String(p?.itemId || p?.item?.id || "agent");
        const delta = String(p?.delta ?? "");
        const accumulated = (this.appServerAgentText.get(itemId) || "") + delta;
        this.appServerAgentText.set(itemId, accumulated);
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        const messagePhase = this.appServerAgentPhases.get(itemId);
        if (parentToolUseId) this.appServerStreamParents.set(itemId, parentToolUseId);
        if (delta) {
          this.send({
            type: "text",
            content: accumulated,
            sessionId: sid,
            streamId: itemId,
            snapshot: true,
            ...(messagePhase ? { messagePhase } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          } as ServerMessage);
        }
        return;
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const sid = this.sessionId;
        const itemId = p?.itemId || p?.item?.id || "reasoning";
        const delta = String(p?.delta ?? "");
        if (!this.appServerReasoningStartedAt.has(String(itemId))) {
          this.appServerReasoningStartedAt.set(String(itemId), Date.now());
        }
        const accumulated = (this.appServerReasoningText.get(itemId) || "") + delta;
        if (delta) this.appServerReasoningText.set(itemId, accumulated);
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        if (parentToolUseId) this.appServerReasoningParents.set(String(itemId), parentToolUseId);
        if (sid && delta) this.send({
          type: "thinking",
          content: accumulated,
          sessionId: sid,
          streamId: String(itemId),
          snapshot: true,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as ServerMessage);
        return;
      }

      case "item/reasoning/summaryPartAdded": {
        const itemId = String(p?.itemId || "");
        if (!itemId || Number(p?.summaryIndex || 0) <= 0) return;
        const accumulated = this.appServerReasoningText.get(itemId) || "";
        if (accumulated && !accumulated.endsWith("\n\n")) {
          this.appServerReasoningText.set(itemId, `${accumulated}\n\n`);
        }
        return;
      }

      case "item/plan/delta": {
        const sid = this.sessionId;
        const itemId = String(p?.itemId || p?.item?.id || p?.turnId || "plan");
        const turnId = String(p?.turnId || itemId);
        const delta = String(p?.delta ?? "");
        if (!sid || !delta) return;
        const accumulated = (this.appServerPlanText.get(itemId) || "") + delta;
        this.appServerPlanText.set(itemId, accumulated);
        this.send({
          type: "codex_plan",
          turnId,
          explanation: accumulated,
          plan: [],
          sessionId: sid,
        } as any);
        return;
      }

      case "hook/started": {
        const sid = this.sessionId;
        const run = p?.run || {};
        if (!sid) return;
        this.send({
          type: "hook_started",
          hookId: String(run.id || ""),
          hookName: this.formatAppServerHookName(run),
          hookEvent: String(run.eventName || ""),
          sessionId: sid,
        } as any);
        return;
      }

      case "hook/completed": {
        const sid = this.sessionId;
        const run = p?.run || {};
        if (!sid) return;
        const entries = Array.isArray(run.entries) ? run.entries : [];
        const stdout = entries.map((e: any) => e?.stdout || e?.output || "").filter(Boolean).join("\n");
        const stderr = entries.map((e: any) => e?.stderr || e?.error || "").filter(Boolean).join("\n");
        this.send({
          type: "hook_response",
          hookId: String(run.id || ""),
          hookName: this.formatAppServerHookName(run),
          hookEvent: String(run.eventName || ""),
          stdout,
          stderr,
          outcome: String(run.status || "completed"),
          sessionId: sid,
        } as any);
        return;
      }

      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta": {
        const sid = this.sessionId;
        if (!sid) return;
        const itemId = p?.itemId || p?.item?.id || p?.processId || p?.id;
        const delta = String(p?.delta ?? p?.chunk ?? "");
        if (!itemId || !delta) return;
        const key = String(itemId);
        this.appServerToolOutput.set(key, (this.appServerToolOutput.get(key) || "") + delta);
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        this.send({
          type: "tool_result_chunk",
          toolUseId: key,
          content: delta,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as any);
        return;
      }

      case "item/commandExecution/terminalInteraction": {
        const sid = this.sessionId;
        const itemId = p?.itemId;
        const stdin = String(p?.stdin ?? "");
        if (!sid || !itemId || !stdin) return;
        const content = `[stdin] ${stdin}\n`;
        const key = String(itemId);
        this.appServerToolOutput.set(key, (this.appServerToolOutput.get(key) || "") + content);
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        this.send({
          type: "tool_result_chunk",
          toolUseId: key,
          content,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as any);
        return;
      }

      case "thread/tokenUsage/updated": {
        if (p?.threadId && p.threadId !== this.threadId) return;
        const usage = this.usageFromAppServerTokenUsage(p?.tokenUsage);
        if (!usage || !this.sessionId) return;
        this._lastUsage = usage;
        this.send({
          type: "usage_update",
          sessionId: this.sessionId,
          ...usage,
        } as any);
        const contextUsage = this.contextUsageFromAppServerUsage(usage);
        if (contextUsage) {
          this.send({
            type: "context_usage",
            sessionId: this.sessionId,
            ...contextUsage,
          } as any);
          updateSessionContextUsage(this.sessionId, contextUsage);
          recordSessionMemoryContextUsage(
            this.sessionId,
            Number(contextUsage.totalTokens || 0),
            Number(contextUsage.maxTokens || 0),
          );
        }
        updateSessionActivity(this.sessionId, this._lastAssistantText, usage);
        return;
      }

      case "turn/plan/updated": {
        if (p?.threadId && p.threadId !== this.threadId) return;
        const sid = this.sessionId || p?.threadId;
        if (!sid) return;
        const turnId = String(p?.turnId || "");
        const explanation = typeof p?.explanation === "string" ? p.explanation : "";
        const plan = Array.isArray(p?.plan) ? p.plan : [];
        this.send({
          type: "codex_plan",
          turnId,
          explanation,
          plan,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "codex_plan",
          content: explanation,
          toolUseId: turnId,
          toolInput: { explanation, steps: plan },
          timestamp: now(),
        } as HistoryEntry);
        return;
      }

      case "account/rateLimits/updated": {
        const sid = this.sessionId;
        if (!sid) return;
        for (const event of buildCodexRateLimitEvents(p?.rateLimits, sid)) {
          recordRateLimitEvent(event);
          this.send(event as any);
        }
        return;
      }

      case "model/rerouted": {
        const sid = this.sessionId;
        if (!sid || (p?.threadId && p.threadId !== this.threadId)) return;
        const fromModel = String(p?.fromModel || "unknown");
        const toModel = String(p?.toModel || "unknown");
        const reason = String(p?.reason || "");
        const toolUseId = `codex-reroute:${String(p?.turnId || Date.now())}`;
        const input = {
          fromModel,
          toModel,
          reason,
          _codexItemType: "modelRerouted",
        };
        this.send({
          type: "tool_call",
          tool: "ModelRerouted",
          input,
          toolUseId,
          sessionId: sid,
        } as any);
        const output = reason
          ? `Codex switched from ${fromModel} to ${toModel}: ${reason}`
          : `Codex switched from ${fromModel} to ${toModel}`;
        this.send({
          type: "tool_result",
          toolUseId,
          output,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "tool_call",
          content: "Codex model changed",
          toolName: "ModelRerouted",
          toolInput: input,
          toolUseId,
          timestamp: now(),
        });
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId,
          toolOutput: output,
          timestamp: now(),
        });
        return;
      }

      case "model/safetyBuffering/updated": {
        const sid = this.sessionId;
        if (!sid || (p?.threadId && p.threadId !== this.threadId)) return;
        const toolUseId = `codex-safety:${String(p?.turnId || "turn")}`;
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        if (p?.showBufferingUi === true) {
          const input = {
            model: p?.model || "",
            useCases: Array.isArray(p?.useCases) ? p.useCases : [],
            reasons: Array.isArray(p?.reasons) ? p.reasons : [],
            fasterModel: p?.fasterModel || null,
            _codexItemType: "safetyBuffering",
          };
          this.send({
            type: "tool_call",
            tool: "SafetyBuffering",
            input,
            toolUseId,
            sessionId: sid,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          } as any);
          appendHistory(sid, {
            role: "tool_call",
            content: "Response safety check",
            toolName: "SafetyBuffering",
            toolInput: input,
            toolUseId,
            ...(parentToolUseId ? { parentToolUseId } : {}),
            timestamp: now(),
          });
        } else {
          this.send({
            type: "tool_result",
            toolUseId,
            output: "Safety check completed",
            sessionId: sid,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          } as any);
          appendHistory(sid, {
            role: "tool_result",
            content: "Safety check completed",
            toolUseId,
            toolOutput: "Safety check completed",
            ...(parentToolUseId ? { parentToolUseId } : {}),
            timestamp: now(),
          });
        }
        return;
      }

      case "model/verification": {
        const sid = this.sessionId;
        if (!sid || (p?.threadId && p.threadId !== this.threadId)) return;
        const toolUseId = `codex-verification:${String(p?.turnId || Date.now())}`;
        const input = {
          verifications: Array.isArray(p?.verifications) ? p.verifications : [],
          _codexItemType: "modelVerification",
        };
        this.send({
          type: "tool_call",
          tool: "ModelVerification",
          input,
          toolUseId,
          sessionId: sid,
        } as any);
        const output = input.verifications.length > 0
          ? JSON.stringify(input.verifications, null, 2)
          : "Additional account verification is required";
        this.send({
          type: "tool_result",
          toolUseId,
          output,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "tool_call",
          content: "Account verification required",
          toolName: "ModelVerification",
          toolInput: input,
          toolUseId,
          timestamp: now(),
        });
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId,
          toolOutput: output,
          timestamp: now(),
        });
        return;
      }

      case "item/autoApprovalReview/started": {
        const sid = this.sessionId;
        if (!sid) return;
        const toolUseId = `codex-auto-review:${String(p?.reviewId || Date.now())}`;
        const input = {
          action: p?.action || null,
          review: p?.review || null,
          targetItemId: p?.targetItemId || null,
          _codexItemType: "autoApprovalReview",
        };
        this.send({
          type: "tool_call",
          tool: "ApprovalReview",
          input,
          toolUseId,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "tool_call",
          content: "Reviewing tool approval",
          toolName: "ApprovalReview",
          toolInput: input,
          toolUseId,
          timestamp: now(),
        });
        return;
      }

      case "item/autoApprovalReview/completed": {
        const sid = this.sessionId;
        if (!sid) return;
        const toolUseId = `codex-auto-review:${String(p?.reviewId || "")}`;
        const output = JSON.stringify({
          review: p?.review || null,
          decisionSource: p?.decisionSource || null,
        }, null, 2);
        this.send({
          type: "tool_result",
          toolUseId,
          output,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId,
          toolOutput: output,
          timestamp: now(),
        });
        return;
      }

      case "guardianWarning":
      case "windows/worldWritableWarning": {
        const message = String(p?.message || p?.warning || method);
        this.send({ type: "error", message } as ServerMessage);
        return;
      }

      case "deprecationNotice": {
        const summary = String(p?.summary || "Codex deprecation notice");
        const details = String(p?.details || "").trim();
        this.send({
          type: "error",
          message: details ? `${summary}\n${details}` : summary,
          sessionId: this.sessionId || undefined,
        } as any);
        return;
      }

      case "mcpServer/startupStatus/updated": {
        const name = String(p?.name || "MCP server");
        const error = p?.error ? String(p.error) : "";
        const needsReauth = p?.failureReason === "reauthenticationRequired"
          || (error && isCodexAuthError(error));
        if (needsReauth) {
          void this.handleAppServerAuthFailure(error || `${name} authentication expired`, {
            hintedMcp: true,
            terminal: false,
            mcpServerName: name,
          });
        } else if (error) {
          this.send({ type: "error", message: `${name}: ${error}` } as ServerMessage);
        }
        return;
      }

      case "item/fileChange/patchUpdated": {
        const itemId = p?.itemId;
        if (!itemId) return;
        this.appServerFileChangeDiff.set(String(itemId), this.formatAppServerFileChanges(p?.changes));
        return;
      }

      case "item/fileChange/outputDelta": {
        const itemId = p?.itemId;
        const delta = String(p?.delta ?? "");
        if (!itemId || !delta) return;
        const key = String(itemId);
        this.appServerFileChangeDiff.set(key, (this.appServerFileChangeDiff.get(key) || "") + delta);
        return;
      }

      case "turn/diff/updated":
        // Useful as a turn-level aggregate, but individual fileChange cards are
        // a better fit for the current chat UI. Keep this as a known no-op.
        return;

      case "item/mcpToolCall/progress": {
        const sid = this.sessionId;
        const itemId = p?.itemId;
        const message = String(p?.message ?? "");
        if (!sid || !itemId || !message) return;
        const parentToolUseId = this.parentToolUseIdForThread(p?.threadId);
        this.send({
          type: "tool_result_chunk",
          toolUseId: String(itemId),
          content: `${message}\n`,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        } as any);
        return;
      }

      case "item/started":
      case "item/completed":
        if (p?.item?.type === "subAgentActivity") {
          const item = p.item;
          if (item.kind === "started") {
            const agent = this.registerCodexSubagent(String(item.agentThreadId || ""), {
              agentPath: String(item.agentPath || ""),
              startedAt: p?.completedAtMs
                ? new Date(Number(p.completedAtMs)).toISOString()
                : now(),
            });
            if (agent) this.updateCodexSubagentStatus(agent.agentId, "running");
          } else if (item.kind === "interacted") {
            const agent = this.registerCodexSubagent(String(item.agentThreadId || ""), {
              agentPath: String(item.agentPath || ""),
            });
            if (agent) this.updateCodexSubagentStatus(agent.agentId, "running");
          } else if (item.kind === "interrupted") {
            this.updateCodexSubagentStatus(String(item.agentThreadId || ""), "interrupted");
          }
          return;
        }
        this.handleAppServerItem(method, p?.item, p);
        return;

      case "turn/completed": {
        if (p?.threadId && p.threadId !== this.threadId) {
          this.updateCodexSubagentStatus(String(p.threadId), "completed");
          return;
        }
        this.requeuePendingAppServerSteers("turn completed before steered userMessage was emitted");
        this.activeAppServerTurnId = null;
        this.scheduleAppServerTurnCompletion();
        return;
      }

      case "error":
        // The app-server client routes this notification through the dedicated
        // errorNotification channel immediately after this callback. That path
        // classifies retry progress versus terminal failure and surfaces a
        // terminal error exactly once.
        return;

      case "warning":
        if (p?.message || p?.summary) {
          const summary = String(p?.message || p?.summary);
          const details = String(p?.details || "").trim();
          const message = details ? `${summary}\n${details}` : summary;
          if (isCodexAuthError(p) || isCodexAuthError(message)) {
            void this.handleAppServerAuthFailure(message, {
              hintedMcp: isMcpAuthSignal(p) || isMcpAuthSignal(message),
              terminal: false,
              mcpServerName: /codex_apps/i.test(message) ? "Connected apps" : undefined,
            });
          } else {
            this.send({
              type: "error",
              message,
              sessionId: this.sessionId || undefined,
            } as any);
          }
        }
        return;

      case "configWarning": {
        const summary = String(p?.summary || "Codex configuration warning");
        const details = String(p?.details || "").trim();
        const path = String(p?.path || "").trim();
        this.send({
          type: "error",
          message: `${summary}${details ? `\n${details}` : ""}${path ? `\nConfig: ${path}` : ""}`,
          sessionId: this.sessionId || undefined,
        } as any);
        return;
      }
    }
  }

  private handleAppServerItem(method: "item/started" | "item/completed", item: any, event?: any): void {
    const sid = this.sessionId;
    if (!sid || !item?.id || !item?.type) return;
    const parentToolUseId = this.parentToolUseIdForThread(event?.threadId);
    const sendItem = (message: Record<string, unknown>): void => {
      const routedMessage = {
        ...message,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      } as Record<string, any>;
      const toolUseId = String(routedMessage.toolUseId || "");
      if (routedMessage.type === "tool_call" && toolUseId) {
        this.appServerActiveToolCalls.set(toolUseId, {
          tool: String(routedMessage.tool || "Tool"),
          input: routedMessage.input && typeof routedMessage.input === "object"
            ? routedMessage.input as Record<string, unknown>
            : {},
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
      } else if (routedMessage.type === "tool_result" && toolUseId) {
        this.appServerActiveToolCalls.delete(toolUseId);
      }
      this.send(routedMessage as any);
    };
    const appendItem = (entry: HistoryEntry): void => {
      appendHistory(sid, {
        ...entry,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
    };

    if (item.type === "reasoning" && method === "item/started") {
      this.appServerReasoningStartedAt.set(String(item.id), Date.now());
      return;
    }

    if (item.type === "userMessage") {
      if (!this.appServerSeenUserMessageItems.has(item.id)) {
        this.appServerSeenUserMessageItems.add(item.id);
      }
      return;
    }

    if (item.type === "agentMessage") {
      const messagePhase = codexAgentMessagePhase(item.phase)
        || this.appServerAgentPhases.get(String(item.id));
      if (messagePhase) this.appServerAgentPhases.set(String(item.id), messagePhase);
      if (method === "item/completed") {
        const text = item.text || this.appServerAgentText.get(item.id) || "";
        if (text) {
          this.send({
            type: "text",
            content: text,
            sessionId: sid,
            streamId: String(item.id),
            snapshot: true,
            finalSnapshot: true,
            ...(messagePhase ? { messagePhase } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          } as any);
          if (!parentToolUseId) this._lastAssistantText = text;
          appendItem({
            role: "assistant",
            content: text,
            streamId: String(item.id),
            ...(messagePhase ? { messagePhase } : {}),
            timestamp: now(),
          });
        }
        this.appServerAgentText.delete(item.id);
        this.appServerStreamParents.delete(item.id);
        this.appServerAgentPhases.delete(String(item.id));
      }
      return;
    }

    if (item.type === "reasoning" && method === "item/completed") {
      const text = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].join("\n");
      const streamed = this.appServerReasoningText.get(item.id) || "";
      const content = text || streamed;
      const startedAtMs = this.appServerReasoningStartedAt.get(String(item.id))
        || Date.now();
      const thinkingDurationMs = Math.max(1, Date.now() - startedAtMs);
      const timestamp = new Date(startedAtMs).toISOString();
      sendItem({
        type: "thinking",
        content,
        sessionId: sid,
        streamId: String(item.id),
        snapshot: true,
        finalSnapshot: true,
        thinkingDurationMs,
        timestamp,
      });
      appendItem({
        role: "assistant",
        content,
        thinking: true,
        streamId: String(item.id),
        thinkingDurationMs,
        timestamp,
      });
      if (item.id) this.appServerReasoningText.delete(item.id);
      if (item.id) this.appServerReasoningParents.delete(item.id);
      if (item.id) this.appServerReasoningStartedAt.delete(String(item.id));
      return;
    }

    if (item.type === "plan") {
      if (method === "item/completed") {
        const turnId = String(event?.turnId || item.id);
        const explanation = String(item.text || this.appServerPlanText.get(String(item.id)) || "");
        this.send({
          type: "codex_plan",
          turnId,
          explanation,
          plan: [],
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "codex_plan",
          content: explanation,
          toolUseId: turnId,
          toolInput: { explanation, steps: [] },
          timestamp: now(),
        } as HistoryEntry);
        this.appServerPlanText.delete(String(item.id));
      }
      return;
    }

    if (item.type === "contextCompaction") {
      if (parentToolUseId) return;
      if (method === "item/started") {
        this._isCompacting = true;
        this._compactStartedAt ||= new Date().toISOString();
        this._compactBoundaryEmitted = false;
        if (this._compactBoundaryTrigger !== "manual") {
          this._compactBoundaryTrigger = "auto";
        }
        this.send({ type: "compacting", active: true, sessionId: sid } as any);
      } else {
        this._isCompacting = false;
        this._compactStartedAt = null;
        this.send({ type: "compacting", active: false, sessionId: sid } as any);
        this.emitCompactBoundary(sid, this._compactBoundaryTrigger);
        this.scheduleAppServerIdleStop();
      }
      return;
    }

    if (item.type === "commandExecution") {
      if (method === "item/started") {
        const input = {
          command: item.command || "",
          description: summarizeCodexCommandActions(item.commandActions, item.command),
          cwd: item.cwd || "",
          commandActions: Array.isArray(item.commandActions) ? item.commandActions : [],
          source: item.source || "",
          _codexItemType: "commandExecution",
        };
        sendItem({
          type: "tool_call",
          tool: "Bash",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: input.description,
          toolName: "Bash",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const buffered = this.appServerToolOutput.get(item.id) || "";
        const baseOutput = item.aggregatedOutput ?? buffered;
        const suffix = item.exitCode ? `\n[exit ${item.exitCode}]` : "";
        const output = `${baseOutput || ""}${suffix}`;
        sendItem({
          type: "tool_result_chunk",
          toolUseId: item.id,
          content: "",
          sessionId: sid,
          done: true,
          chunkIndex: 1,
        });
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
        this.appServerToolOutput.delete(item.id);
      }
      return;
    }

    if (item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c: any) => c?.path || c?.filePath).filter(Boolean);
      if (method === "item/started") {
        this.appServerFileChangePaths.set(item.id, files);
        sendItem({
          type: "tool_call",
          tool: "ApplyPatch",
          input: {
            changes,
            files,
          },
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: this.summarizeAppServerFileChanges(changes),
          toolName: "ApplyPatch",
          toolInput: {
            changes,
            files,
          },
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = this.formatAppServerFileChanges(changes)
          || this.appServerFileChangeDiff.get(item.id)
          || "File changes applied";
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
        this.appServerFileChangeDiff.delete(item.id);
        this.appServerFileChangePaths.delete(item.id);
      }
      return;
    }

    if (item.type === "mcpToolCall") {
      const isSocketAgentApp = item.server === "socketagent_app" || item.server === "socketagent-app";
      if (isSocketAgentApp
        && (item.tool === "ReportSubagentAssignment" || item.tool === "NotifyUser")) return;
      const toolName = isSocketAgentApp ? item.tool : `mcp:${item.server}/${item.tool}`;
      if (method === "item/started") {
        const args = (item.arguments && typeof item.arguments === "object")
          ? item.arguments
          : {};
        const input = isSocketAgentApp
          ? { ...args }
          : {
            ...args,
            _codexItemType: "mcpToolCall",
            _codexServer: item.server || "",
            _codexTool: item.tool || "",
            _codexAppContext: item.appContext || null,
            _codexPluginId: item.pluginId || null,
          };
        sendItem({
          type: "tool_call",
          tool: toolName,
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: toolName,
          toolName,
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = item.error
          ? `Error: ${JSON.stringify(item.error)}`
          : JSON.stringify(item.result ?? null, null, 2);
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "collabAgentToolCall") {
      if (method !== "item/completed") return;
      const receiverThreadIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.map(String)
        : [];
      if (item.tool === "spawnAgent") {
        for (const agentId of receiverThreadIds) {
          this.registerCodexSubagent(agentId, {
            prompt: typeof item.prompt === "string" ? item.prompt : undefined,
            model: typeof item.model === "string" ? item.model : undefined,
            reasoningEffort: typeof item.reasoningEffort === "string"
              ? item.reasoningEffort
              : undefined,
            parentToolUseId,
          });
        }
      }
      const agentStates = item.agentsStates && typeof item.agentsStates === "object"
        ? item.agentsStates
        : {};
      for (const [agentId, state] of Object.entries(agentStates) as [string, any][]) {
        const rawStatus = String(state?.status || "");
        const isActive = rawStatus === "active"
          || rawStatus === "running"
          || rawStatus === "pendingInit";
        if (!this.codexSubagents.has(agentId) && !isActive) continue;
        this.registerCodexSubagent(agentId);
        this.updateCodexSubagentStatus(
          agentId,
          rawStatus,
          typeof state?.message === "string" ? state.message : undefined,
        );
      }
      return;
    }

    if (item.type === "dynamicToolCall") {
      const toolName = dynamicToolDisplayName(item);
      if (method === "item/started") {
        const args = (item.arguments && typeof item.arguments === "object")
          ? item.arguments
          : {};
        const input = {
          ...args,
          _codexItemType: "dynamicToolCall",
          _codexNamespace: item.namespace || "",
          _codexTool: item.tool || "",
        };
        sendItem({
          type: "tool_call",
          tool: toolName,
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: toolName,
          toolName,
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = formatDynamicToolOutput(item);
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "webSearch") {
      if (method === "item/started") {
        const input = {
          query: item.query,
          action: item.action ?? null,
          _codexItemType: "webSearch",
        };
        sendItem({
          type: "tool_call",
          tool: "WebSearch",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: String(item.query || ""),
          toolName: "WebSearch",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = Array.isArray(item.results) && item.results.length > 0
          ? JSON.stringify(item.results, null, 2)
          : item.action
            ? JSON.stringify(item.action, null, 2)
            : "Search completed";
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "imageView") {
      if (method === "item/started") {
        const input = {
          path: item.path,
          _codexItemType: "imageView",
        };
        sendItem({
          type: "tool_call",
          tool: "ViewImage",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: String(item.path || ""),
          toolName: "ViewImage",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        this.sendToolImageForPath(sid, item.id, item.path, parentToolUseId);
        const output = item.path || "Image viewed";
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "imageGeneration") {
      if (method === "item/started") {
        const input = {
          status: item.status,
          revisedPrompt: item.revisedPrompt ?? null,
          _codexItemType: "imageGeneration",
        };
        sendItem({
          type: "tool_call",
          tool: "ImageGeneration",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: "ImageGeneration",
          toolName: "ImageGeneration",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const generatedPath = this.appServerGeneratedImagePath(event?.threadId, item.id);
        const savedPath = item.savedPath || generatedPath || "";
        let sentImage = false;
        if (savedPath && fs.existsSync(savedPath)) {
          sentImage = this.sendToolImageForPath(sid, item.id, savedPath, parentToolUseId);
        }
        if (!sentImage) {
          sentImage = this.sendToolImageFromBase64(
            sid,
            item.id,
            item.result,
            savedPath,
            parentToolUseId,
          );
        }
        const output = sentImage && savedPath ? savedPath : item.status || "Image generation completed";
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "hookPrompt") {
      if (method !== "item/completed") return;
      const fragments = Array.isArray(item.fragments) ? item.fragments : [];
      const input = {
        fragments,
        _codexItemType: "hookPrompt",
      };
      const output = fragments
        .map((fragment: any) => String(fragment?.text || "").trim())
        .filter(Boolean)
        .join("\n\n");
      sendItem({
        type: "tool_call",
        tool: "HookPrompt",
        input,
        toolUseId: item.id,
        sessionId: sid,
      });
      sendItem({
        type: "tool_result",
        toolUseId: item.id,
        output,
        sessionId: sid,
      });
      appendItem({
        role: "tool_call",
        content: "Hook supplied additional context",
        toolName: "HookPrompt",
        toolInput: input,
        toolUseId: item.id,
        timestamp: now(),
      });
      appendItem({
        role: "tool_result",
        content: output,
        toolUseId: item.id,
        toolOutput: output,
        timestamp: now(),
      });
      return;
    }

    if (item.type === "sleep") {
      if (method === "item/started") {
        const input = {
          durationMs: Number(item.durationMs) || 0,
          _codexItemType: "sleep",
        };
        sendItem({
          type: "tool_call",
          tool: "Sleep",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: `Wait ${Math.max(0, Number(item.durationMs) || 0)} ms`,
          toolName: "Sleep",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output: "Wait completed",
          sessionId: sid,
        });
        appendItem({
          role: "tool_result",
          content: "Wait completed",
          toolUseId: item.id,
          toolOutput: "Wait completed",
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      if (method === "item/completed") {
        const input = {
          review: item.review || "",
          phase: item.type === "enteredReviewMode" ? "entered" : "exited",
          _codexItemType: "reviewMode",
        };
        sendItem({
          type: "tool_call",
          tool: "ReviewMode",
          input,
          toolUseId: item.id,
          sessionId: sid,
        });
        sendItem({
          type: "tool_result",
          toolUseId: item.id,
          output: item.review || (item.type === "enteredReviewMode"
            ? "Entered review mode"
            : "Review completed"),
          sessionId: sid,
        });
        appendItem({
          role: "tool_call",
          content: item.type === "enteredReviewMode"
            ? "Entered review mode"
            : "Exited review mode",
          toolName: "ReviewMode",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
        appendItem({
          role: "tool_result",
          content: item.review || "",
          toolUseId: item.id,
          toolOutput: item.review || "",
          timestamp: now(),
        });
      }
      return;
    }

    // Never silently drop a newly-added app-server item type. Known items above
    // receive tailored translations; this diagnostic card makes schema drift
    // visible without dumping an unlabelled raw "Tool" card into chat.
    const input = {
      itemType: String(item.type),
      payload: redactSecretsDeep(item),
      _codexItemType: "unrecognized",
    };
    sendItem({
      type: "tool_call",
      tool: "CodexItem",
      input,
      toolUseId: item.id,
      sessionId: sid,
    });
    appendItem({
      role: "tool_call",
      content: `Unsupported Codex item: ${String(item.type)}`,
      toolName: "CodexItem",
      toolInput: input,
      toolUseId: item.id,
      timestamp: now(),
    });
    if (method === "item/completed") {
      const output = `Codex item '${String(item.type)}' completed`;
      sendItem({
        type: "tool_result",
        toolUseId: item.id,
        output,
        sessionId: sid,
      });
      appendItem({
        role: "tool_result",
        content: output,
        toolUseId: item.id,
        toolOutput: output,
        timestamp: now(),
      });
    }
  }

  private formatAppServerHookName(run: any): string {
    const event = String(run?.eventName || "Hook");
    const sourcePath = String(run?.sourcePath || "");
    const sourceName = sourcePath ? path.basename(sourcePath) : "";
    return [event, sourceName].filter(Boolean).join(" ");
  }

  private appServerGeneratedImagePath(threadId: unknown, itemId: unknown): string | null {
    const thread = String(threadId || this.threadId || "").trim();
    const item = String(itemId || "").trim();
    if (!thread || !item) return null;
    return path.join(os.homedir(), ".codex", "generated_images", thread, `${item}.png`);
  }

  private sendToolImageFromBase64(
    sessionId: string,
    toolUseId: string,
    raw: unknown,
    filePath: string,
    parentToolUseId?: string,
  ): boolean {
    let imageData = typeof raw === "string" ? raw.trim() : "";
    if (!imageData) return false;
    const dataUrl = imageData.match(/^data:([^;,]+);base64,(.+)$/);
    const mimeType = dataUrl?.[1] || "image/png";
    if (dataUrl) imageData = dataUrl[2];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(imageData)) return false;
    imageData = imageData.replace(/\s+/g, "");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(imageData, "base64");
    } catch {
      return false;
    }
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return false;
    if (filePath && !fs.existsSync(filePath)) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, bytes);
      } catch {
        filePath = "";
      }
    }
    try {
      filePath = cacheToolImage(sessionId, toolUseId, bytes, mimeType, filePath);
    } catch (err: any) {
      console.warn(`[codex app-server] failed to cache tool image: ${err?.message || String(err)}`);
    }
    this.send({
      type: "tool_image",
      toolUseId,
      imageData,
      mimeType,
      filePath,
      sessionId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    } as any);
    appendHistory(sessionId, {
      role: "tool_image",
      content: "",
      toolUseId,
      filePath,
      mimeType,
      timestamp: now(),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    });
    return true;
  }

  private sendToolImageForPath(
    sessionId: string,
    toolUseId: string,
    filePath: string,
    parentToolUseId?: string,
  ): boolean {
    if (!filePath) return false;
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return false;
    const mimeType = this.imageMimeType(resolved);
    if (!mimeType) return false;
    try {
      const bytes = fs.readFileSync(resolved);
      const imageData = bytes.toString("base64");
      let persistedPath = resolved;
      try {
        persistedPath = cacheToolImage(sessionId, toolUseId, bytes, mimeType, resolved);
      } catch (err: any) {
        console.warn(`[codex app-server] failed to cache tool image ${resolved}: ${err?.message || String(err)}`);
      }
      this.send({
        type: "tool_image",
        toolUseId,
        imageData,
        mimeType,
        filePath: persistedPath,
        sessionId,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      } as any);
      appendHistory(sessionId, {
        role: "tool_image",
        content: "",
        toolUseId,
        filePath: persistedPath,
        mimeType,
        timestamp: now(),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
      return true;
    } catch (err: any) {
      console.warn(`[codex app-server] failed to send tool image ${resolved}: ${err?.message || String(err)}`);
      return false;
    }
  }

  private imageMimeType(filePath: string): string | null {
    switch (path.extname(filePath).toLowerCase()) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".svg": return "image/svg+xml";
      default: return null;
    }
  }

  private summarizeAppServerFileChanges(changes: any[]): string {
    return changes
      .map((change) => {
        const path = change?.path || change?.filePath || "";
        const kind = this.appServerFileChangeKind(change?.kind || change?.type);
        return [kind, path].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("\n");
  }

  private formatAppServerFileChanges(changes: any): string {
    if (!Array.isArray(changes)) return "";
    const parts: string[] = [];
    for (const change of changes) {
      const path = change?.path || change?.filePath || "";
      const diff = typeof change?.diff === "string" ? change.diff.trimEnd() : "";
      if (!diff) continue;
      if (path && !diff.startsWith("--- ") && !diff.startsWith("diff --git ")) {
        parts.push(`--- ${path}\n+++ ${path}\n${diff}`);
      } else {
        parts.push(diff);
      }
    }
    return parts.join("\n");
  }

  private appServerFileChangeKind(kind: any): string {
    if (typeof kind === "string") return kind;
    if (kind && typeof kind === "object") {
      return String(kind.type || kind.kind || "change");
    }
    return "change";
  }

  private usageFromAppServerTokenUsage(tokenUsage: any): NonNullable<CodexSession["_lastUsage"]> | null {
    const last = tokenUsage?.last || tokenUsage?.total;
    if (!last) return null;
    const cached = Number(last.cachedInputTokens ?? 0);
    return {
      inputTokens: Math.max(0, Number(last.inputTokens ?? 0) - cached),
      outputTokens: Number(last.outputTokens ?? 0),
      cacheReadTokens: cached,
      cacheCreateTokens: 0,
      contextWindow: Number(tokenUsage?.modelContextWindow ?? 0),
    };
  }

  private isArchivedAppServerError(err: any): boolean {
    const message = String(err?.message || err || "");
    return message.includes(" is archived") || message.includes("unarchive it first");
  }

  private isMissingRolloutAppServerError(err: any): boolean {
    const message = String(err?.message || err || "");
    return message.includes("no rollout found for thread id");
  }

  private contextUsageFromAppServerUsage(usage: NonNullable<CodexSession["_lastUsage"]>): Record<string, unknown> | null {
    if (!usage.contextWindow) return null;
    const totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
    return {
      totalTokens,
      maxTokens: usage.contextWindow,
      remainingTokens: Math.max(0, usage.contextWindow - totalTokens),
      percentUsed: usage.contextWindow > 0 ? totalTokens / usage.contextWindow : 0,
      categories: [
        ...(usage.cacheReadTokens > 0 ? [{ name: "Cached", tokens: usage.cacheReadTokens, color: "#89B4FA" }] : []),
        ...(usage.cacheCreateTokens > 0 ? [{ name: "New cache", tokens: usage.cacheCreateTokens, color: "#A6E3A1" }] : []),
        ...(usage.inputTokens > 0 ? [{ name: "Uncached", tokens: usage.inputTokens, color: "#F9E2AF" }] : []),
      ],
    };
  }

  private currentContextTokenTotal(): number {
    const usage = this._lastUsage;
    if (!usage) return 0;
    return Math.max(0, usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens);
  }

  private emitCompactBoundary(sid: string, trigger: string): void {
    if (this._compactBoundaryEmitted) return;
    this._compactBoundaryEmitted = true;
    const boundaryTrigger = trigger === "manual" ? "manual" : "auto";
    this._compactBoundaryTrigger = "auto";
    const preTokens = this.currentContextTokenTotal();
    this.send({
      type: "compact_boundary",
      trigger: boundaryTrigger,
      preTokens,
      sessionId: sid,
    } as any);
    appendHistory(sid, {
      role: "assistant",
      content: `[compact_boundary:${preTokens}:${boundaryTrigger}]`,
      timestamp: now(),
    });
    recordSessionMemoryCompaction(sid, preTokens);
  }

  private emitAppServerRawEvent(method: string, params: any): void {
    const sid = String(this.sessionId || params?.threadId || params?.thread?.id || "");
    const event = {
      type: "sdk_event",
      sdkType: "codex_app_server",
      method,
      params,
      sessionId: sid,
      ts: now(),
    };
    // High-frequency deltas remain available to a client actively subscribed
    // to Raw mode. Persist completed/state events only; completed items already
    // contain the useful final payload, while retaining every token, command
    // output chunk, and full diff caused unbounded debug logs and disk churn.
    if (sid && !TRANSIENT_CODEX_RAW_EVENT_METHODS.has(method)) {
      appendSdkEvent(sid, event);
    }
    this.sendSdkEvent(event as any);
  }

  private buildCodexMcpUrl(token: string): string {
    const port = process.env.PORT || "8085";
    return `http://127.0.0.1:${port}/codex-mcp/${encodeURIComponent(token)}`;
  }

  private codexReasoningEffort(): string {
    return this._effort;
  }

  private configuredCodexModel(): string | undefined {
    const envModel = process.env.CODEX_MODEL?.trim();
    if (envModel) return envModel;

    try {
      const configPath = path.join(os.homedir(), ".codex", "config.toml");
      const config = fs.readFileSync(configPath, "utf8");
      const match = config.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
      if (match?.[1]) return match[1];
    } catch {
      // Fall through to Codex's current default when config is absent/unreadable.
    }

    return undefined;
  }

  private codexModel(): string | undefined {
    if (this._model) return this._model;
    const configuredModel = this.configuredCodexModel();
    if (configuredModel) return configuredModel;
    return undefined;
  }

  private codexDeveloperInstructions(): string | null {
    const parts: string[] = [];

    parts.push(buildSocketAgentIntegrationInstructions({
      mcpServerName: "socketagent_app",
      toolNames: SOCKETAGENT_APP_TOOLS.map((tool) => tool.name),
      secureInventory: secureInputInventoryForAgent(this.sessionId || undefined, this.cwd),
      discoverMissingTools: true,
    }));

    const emailToolsPath = path.resolve(__dirname, "..", "tools", "email-tools.js");
    if (fs.existsSync(emailToolsPath)) {
      parts.push(
        `Outlook email/calendar CLI is available at ${emailToolsPath}. Use it when the user asks to work with Outlook mail, attachments, drafts, sends, or calendar data. Examples: \`node ${emailToolsPath} list 10\`, \`node ${emailToolsPath} read <email-id>\`, \`node ${emailToolsPath} search <query> [count]\`, \`node ${emailToolsPath} attachments <email-id>\`, \`node ${emailToolsPath} download-attachment <email-id> <attachment-id-or-name> [output-dir]\`, \`node ${emailToolsPath} agenda\`, and \`node ${emailToolsPath} events [days] [count]\`. Sending commands require user approval.`,
      );
    }

    const ibsToolsPath = path.resolve(__dirname, "..", "tools", "ibs-tools.js");
    if (fs.existsSync(ibsToolsPath)) {
      parts.push(
        `IBS/JCI Installation Information System CLI is available at ${ibsToolsPath}. Use it when the user asks about IBS contracts, job summaries, cost schedules, labor schedules, or current IBS contract lists. Examples: \`node ${ibsToolsPath} summary <job-id>\`, \`node ${ibsToolsPath} costs <job-id>\`, \`node ${ibsToolsPath} labor <job-id>\`, and \`node ${ibsToolsPath} list\`. It requires a valid IBS browser-cookie session; if expired, trigger IBS auth through the SocketAgent app.`,
      );
    }

    const oneDriveToolsPath = path.resolve(__dirname, "..", "tools", "onedrive-tools.js");
    if (fs.existsSync(oneDriveToolsPath)) {
      parts.push(
        `OneDrive/SharePoint CLI is available at ${oneDriveToolsPath}. Use it when the user asks to list, search, download, upload, or inspect OneDrive/SharePoint/project-drive files. Examples: \`node ${oneDriveToolsPath} ls [folder-path]\`, \`node ${oneDriveToolsPath} search <query>\`, \`node ${oneDriveToolsPath} download <remote-path> [output-path]\`, \`node ${oneDriveToolsPath} find-project <project-number>\`, \`node ${oneDriveToolsPath} drive-ls <drive-id> [folder-path]\`, and \`node ${oneDriveToolsPath} drive-upload <local> <drive-id> <path>\`. Upload/write operations should only be done when clearly requested.`,
      );
    }

    for (const plugin of this._plugins) {
      if (!plugin.toolContextFragment) continue;
      const fragment = plugin.toolContextFragment();
      if (fragment) parts.push(fragment);
    }

    if (this._ttsEnabled) {
      parts.push(
        "Text-to-speech is enabled. Before writing your final text response, call the Speak tool once with a concise, natural spoken summary. Keep it brief and conversational; do not read code, URLs, or markdown aloud. If your response is short and simple, speak it nearly verbatim. If it is long or technical, summarize the key points. Always still write your full text response after speaking.",
      );
    }

    const appendSystemPrompt = this._appendSystemPrompt.trim();
    if (appendSystemPrompt.length > 0) parts.push(appendSystemPrompt);

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  private codexCollaborationMode(): Record<string, unknown> | undefined {
    const developerInstructions = this.codexDeveloperInstructions();
    const model = this.codexModel();
    return {
      mode: this._collaborationMode,
      settings: {
        ...(model ? { model } : {}),
        reasoning_effort: this.codexReasoningEffort(),
        developer_instructions: developerInstructions ?? null,
      },
    };
  }

}

// ─── Backend factory ────────────────────────────────────────────────────────

/**
 * Union of the two session implementations. Most callers can treat them
 * interchangeably because CodexSession exposes shims for the ClaudeSession
 * methods it doesn't implement. Reach for `instanceof` only when a code path
 * needs a feature one backend doesn't support (e.g., MCP tools, fork, rewind).
 */
export type Session = ClaudeSession | CodexSession;

/**
 * Picks the right session implementation. The codex import is dynamic so the
 * Claude path doesn't pay the cost of loading codex types if it's never used.
 */
export function createSession(
  backend: Backend | undefined,
  ws: WebSocket,
  cwd: string,
  plugins: SocketAgentPlugin[],
  _codexDriver?: CodexDriver,
): Session {
  if (playReviewModeEnabled()) {
    return new CodexSession(ws, cwd, plugins);
  }
  const requestedBackend = backend || "claude";
  if (requestedBackend === "codex") {
    const availability = getCodexAvailability();
    if (!availability.available) {
      throw new Error(`Codex backend is not available on this server: ${availability.reason || "unknown reason"}`);
    }
    return new CodexSession(ws, cwd, plugins);
  }
  const availability = getClaudeAvailability();
  if (!availability.available) {
    throw new Error(`Claude backend is not available on this server: ${availability.reason || "unknown reason"}`);
  }
  // Lazy require keeps the cycle (CodexSession → ClaudeSession via type-only
  // import) from blowing up at runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClaudeSession: CS } = require("./claude-session") as typeof import("./claude-session");
  return new CS(ws, cwd, plugins);
}

async function withStandaloneAppServerClient<T>(
  cwd: string,
  fn: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const clientCwd = resolveStandaloneAppServerCwd(cwd);
  const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
  const client = new CodexAppServerClient({
    cwd: clientCwd,
    command: codex.command,
    args: codex.args,
    env: codex.env,
    shell: codex.shell,
    requestTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
  });
  client.on("error", () => {
    // The pending JSON-RPC request also rejects; this listener prevents EventEmitter
    // from treating spawn failures as uncaught exceptions.
  });
  try {
    await client.initialize({
      clientInfo: {
        name: "socketagent",
        title: "SocketAgent",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    return await fn(client);
  } finally {
    await client.stop().catch(() => {});
  }
}

function resolveStandaloneAppServerCwd(cwd: string): string {
  const candidates = [cwd, process.cwd(), os.homedir(), "/tmp"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        if (candidate !== cwd) {
          console.warn(`[codex app-server] cwd missing for standalone request (${cwd}); using ${candidate}`);
        }
        return candidate;
      }
    } catch {
      // Try the next fallback.
    }
  }
  return process.cwd();
}

export async function archiveCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.archiveThread(threadId);
  });
}

export async function unarchiveCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.unarchiveThread(threadId);
  });
}

export async function compactCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.compactThread(threadId);
  });
}

export async function rollbackCodexAppServerThread(threadId: string, cwd: string, numTurns: number): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.rollbackThread(threadId, numTurns);
  });
}

export async function getCodexAppServerGoal(threadId: string, cwd: string): Promise<CodexGoal | null> {
  return withStandaloneAppServerClient(cwd, async (client) => {
    const result = await client.getGoal(threadId) as { goal?: unknown };
    return normalizeCodexGoal(result?.goal);
  });
}

export async function setCodexAppServerGoal(
  threadId: string,
  cwd: string,
  update: { objective?: string; status?: CodexGoalStatus; tokenBudget?: number | null },
): Promise<CodexGoal> {
  return withStandaloneAppServerClient(cwd, async (client) => {
    const result = await client.setGoal(threadId, update) as { goal?: unknown };
    const goal = normalizeCodexGoal(result?.goal);
    if (!goal) throw new Error("Codex returned an invalid goal state");
    return goal;
  });
}

export async function clearCodexAppServerGoal(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.clearGoal(threadId);
  });
}

// ─── Backend availability detection ─────────────────────────────────────────

const CODEX_AVAILABILITY_CACHE_MS = 5000;
let _cachedCodexAvailability: { checkedAt: number; value: { available: boolean; reason?: string } } | null = null;

export function invalidateCodexAvailabilityCache(): void {
  _cachedCodexAvailability = null;
}

export function getCodexAvailability(): { available: boolean; reason?: string } {
  const now = Date.now();
  if (_cachedCodexAvailability && now - _cachedCodexAvailability.checkedAt < CODEX_AVAILABILITY_CACHE_MS) {
    return _cachedCodexAvailability.value;
  }

  const cache = (value: { available: boolean; reason?: string }): { available: boolean; reason?: string } => {
    _cachedCodexAvailability = { checkedAt: Date.now(), value };
    return value;
  };

  try {
    const codex = buildCodexSpawn(["--version"]);
    const result = spawnSync(codex.command, codex.args, {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: codex.env,
      shell: codex.shell,
      windowsHide: true,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return cache({
        available: false,
        reason: code === "ENOENT"
          ? "Codex CLI was not found on PATH"
          : `Codex CLI probe failed: ${result.error.message}`,
      });
    }

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      return cache({
        available: false,
        reason: detail
          ? `Codex CLI probe exited ${result.status}: ${detail.slice(0, 300)}`
          : `Codex CLI probe exited ${result.status}`,
      });
    }

    const home = process.env.HOME || os.homedir();
    if (!fs.existsSync(path.join(home, ".codex", "auth.json"))) {
      return cache({
        available: false,
        reason: "Codex CLI is installed but ~/.codex/auth.json is missing",
      });
    }

    const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
    const appServerResult = spawnSync(appServerHelp.command, appServerHelp.args, {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: appServerHelp.env,
      shell: appServerHelp.shell,
      windowsHide: true,
    });
    if (appServerResult.error || appServerResult.status !== 0) {
      const detail = appServerResult.error?.message || (appServerResult.stderr || appServerResult.stdout || "").trim();
      return cache({
        available: false,
        reason: detail
          ? `Codex app-server probe failed: ${detail.slice(0, 300)}`
          : "Codex app-server probe failed",
      });
    }

    return cache({ available: true });
  } catch (e: any) {
    return cache({
      available: false,
      reason: `Codex availability check failed: ${e?.message || String(e)}`,
    });
  }
}

/**
 * Returns the agent backends supported by this server build. Runtime health,
 * installation, and auth state are reported separately through backendHealth.
 */
export function detectAvailableBackends(): Backend[] {
  return ["claude", "codex"];
}
