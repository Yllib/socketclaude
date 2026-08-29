import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Backend, CodexDriver, HistoryEntry, ServerMessage } from "./protocol";
import { generateKokoroAudio } from "./kokoro-tts";
import { getScheduledTaskSessionIds, saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { listSkills, SkillEntry } from "./skills-manager";
import { requestSecureInput, SecureInputRequestArgs, SecureInputRequestStatus } from "./secure-input-store";
import { sendPushNotification } from "./push-notifications";
import { getHtmlPlan, saveHtmlPlan } from "./html-plan-store";
import {
  archiveWorkReview,
  createWorkReview,
  createWorkReviewRound,
  exportWorkReviews,
  getWorkReview,
  listWorkReviews,
} from "./work-review-service";
import {
  attachSendFileDeliveryToHistory,
  getTodos,
  rememberGetHistoryEntry,
  rememberHistoryContext,
  rememberListHistory,
  rememberRecentRuns,
  rememberSearchHistory,
  removeHtmlPlanHistoryEntries,
  saveTodos,
} from "./session-store";
import { fileTransferVersion } from "./file-transfer-wire";
import { snapshotSendFile } from "./send-file-store";
import {
  createDurableMonitorRecord,
  DurableMonitorRecord,
  getDurableMonitorRecord,
  launchDurableMonitor,
  listDurableMonitorRecords,
  readDurableMonitorSlice,
  removeDurableMonitorRecord,
  stopDurableMonitor,
  stopDurableMonitorAndWait,
  updateDurableMonitorRecord,
} from "./durable-monitor-store";
import type {
  AgentSessionToolArgs,
  AgentSessionToolExecutor,
  DelegatedAgentRecord,
} from "./delegated-agent-types";
import {
  deleteSessionMemoryEntry,
  getSessionMemoryState,
  SessionMemoryKind,
  upsertSessionMemoryEntry,
} from "./session-memory-store";
import {
  browserSessionManager,
  normalizeBrowserProfile,
  normalizeBrowserUrl,
  type BrowserSessionSummary,
} from "./browser-session-manager";

export interface AppToolContext {
  getSessionId(): string;
  getDelegationSupervisorSessionId?(): string;
  getCwd?(): string;
  getBackend?(): Backend;
  getCodexDriver?(): CodexDriver;
  send(msg: ServerMessage | Record<string, any>): void;
  appendHistory?(entry: Record<string, any>): Record<string, any> | void;
  getTtsEngine(): "system" | "kokoro_server" | "kokoro_device";
  getKokoroVoice(): string;
  getKokoroSpeed(): number;
  isRunning?(): boolean;
  injectMessage?(text: string, priority?: "now" | "next" | "later"): Promise<void>;
  onMonitorOutput?(text: string): void;
  manageAgentSession?: AgentSessionToolExecutor;
  reportSubagentAssignment?(agentPath: string, prompt: string): boolean;
  requestPluginAuthorization?(pluginName: string): Promise<boolean>;
}

export interface SessionMemoryToolArgs {
  action: "list" | "upsert" | "delete";
  entry_id?: string;
  kind?: SessionMemoryKind;
  text?: string;
  pinned?: boolean;
  status?: "active" | "superseded";
  source_session_seq?: number;
  source_entry_id?: string;
}

export interface McpTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface BrowserSessionToolArgs {
  action: "open" | "list" | "status" | "snapshot" | "navigate" | "click" | "type" | "key" | "scroll" | "close" | "clear";
  profile?: string;
  url?: string;
  label?: string;
  ref?: string;
  text?: string;
  key?: string;
  delta_y?: number;
}

export function publishBrowserSessionCard(
  ctx: Pick<AppToolContext, "getSessionId" | "appendHistory" | "send">,
  session: BrowserSessionSummary,
  fallbackUrl: string,
  runtimeRequired = false,
): Record<string, any> | undefined {
  const url = session.url || fallbackUrl;
  const toolInput = {
    profile: session.profile,
    label: session.label,
    url,
    width: 430,
    height: 860,
    ...(runtimeRequired ? { runtimeRequired: true } : {}),
  };
  const positioned = ctx.appendHistory?.({
    role: "browser_session",
    content: session.label,
    toolName: "BrowserSession",
    toolInput,
    timestamp: new Date().toISOString(),
  }) as Record<string, any> | undefined;
  ctx.send({
    type: "browser_session_open",
    ...toolInput,
    sessionId: ctx.getSessionId(),
    ...(positioned?.entryId ? { entryId: positioned.entryId } : {}),
    ...(positioned?.sessionSeq ? { sessionSeq: positioned.sessionSeq } : {}),
    ...(positioned?.revision ? { revision: positioned.revision } : {}),
    ...(positioned?.timestamp ? { timestamp: positioned.timestamp } : {}),
  });
  return positioned;
}

export async function handleBrowserSessionTool(
  ctx: AppToolContext,
  args: BrowserSessionToolArgs,
): Promise<McpTextResult> {
  try {
    if (args.action === "list") {
      return { content: [{ type: "text", text: JSON.stringify(browserSessionManager.list(), null, 2) }] };
    }

    const profile = String(args.profile || "").trim();
    if (!profile) throw new Error("BrowserSession requires a profile for this action.");

    switch (args.action) {
      case "open": {
        if (!args.url) throw new Error("BrowserSession open requires a URL.");
        const session = await browserSessionManager.open(profile, args.url, args.label);
        publishBrowserSessionCard(ctx, session, args.url);
        return {
          content: [{
            type: "text",
            text: `Browser profile ${session.profile} is open at ${session.url || args.url}. A protected remote browser card was sent to the phone. The user must enter passwords and MFA there. Device-bound passkeys may require the site's alternate sign-in method.`,
          }],
        };
      }
      case "status": {
        const session = await browserSessionManager.status(profile);
        publishBrowserSessionCard(ctx, session, session.url || args.url || "https://localhost/");
        return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }] };
      }
      case "snapshot":
        return { content: [{ type: "text", text: JSON.stringify(await browserSessionManager.snapshot(profile), null, 2) }] };
      case "navigate":
        if (!args.url) throw new Error("BrowserSession navigate requires a URL.");
        await browserSessionManager.navigate(profile, args.url);
        break;
      case "click":
        if (!args.ref) throw new Error("BrowserSession click requires an element ref from snapshot.");
        await browserSessionManager.click(profile, args.ref);
        break;
      case "type":
        if (!args.ref) throw new Error("BrowserSession type requires an element ref from snapshot.");
        if (typeof args.text !== "string") throw new Error("BrowserSession type requires text.");
        await browserSessionManager.type(profile, args.ref, args.text);
        break;
      case "key":
        if (!args.key) throw new Error("BrowserSession key requires a supported key.");
        await browserSessionManager.key(profile, args.key);
        break;
      case "scroll":
        await browserSessionManager.scroll(profile, Number(args.delta_y || 0));
        break;
      case "close":
        await browserSessionManager.close(profile);
        return { content: [{ type: "text", text: `Browser profile ${profile} was closed. Its signed-in state remains saved.` }] };
      case "clear":
        await browserSessionManager.clear(profile);
        return { content: [{ type: "text", text: `Browser profile ${profile} and its saved browsing state were deleted.` }] };
    }

    return { content: [{ type: "text", text: `Browser profile ${profile} accepted ${args.action}.` }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser session operation failed.";
    if (args.action === "open"
      && args.url
      && /No supported Chrome, Chromium, or Edge installation was found/.test(message)) {
      const profile = normalizeBrowserProfile(String(args.profile || ""));
      publishBrowserSessionCard(ctx, {
        profile,
        label: String(args.label || profile).trim().slice(0, 80) || profile,
        running: false,
        url: normalizeBrowserUrl(args.url),
        title: "",
        lastUsedAt: new Date().toISOString(),
      }, args.url, true);
    }
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

export async function handlePrivateIntegrationAuthTool(
  ctx: AppToolContext,
  integration: string,
): Promise<McpTextResult> {
  if (!ctx.requestPluginAuthorization) {
    return {
      content: [{
        type: "text",
        text: "Private integration authorization is unavailable in this session.",
      }],
      isError: true,
    };
  }
  try {
    const success = await ctx.requestPluginAuthorization(integration);
    return {
      content: [{
        type: "text",
        text: success
          ? `${integration} authorization completed.`
          : `${integration} authorization was cancelled, timed out, or could not be validated.`,
      }],
      ...(success ? {} : { isError: true }),
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: error instanceof Error
          ? error.message
          : "Private integration authorization failed.",
      }],
      isError: true,
    };
  }
}

export interface ReminderArgs {
  title: string;
  body?: string;
  scheduledTime: string;
}

export interface NotifyUserArgs {
  title: string;
  body?: string;
}

export interface ScheduleTaskArgs {
  name?: string;
  prompt: string;
  cwd: string;
  backend?: Backend;
  codexDriver?: CodexDriver;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";
  permissionMode?: string;
  scheduledTime: string;
  recurrenceType?: "once" | "daily" | "weekly" | "monthly" | "custom";
  customIntervalMs?: number;
  /** Carry summaries from the two most recent runs into a fresh session. */
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface MonitorArgs {
  command?: string;
  description?: string;
  timeoutSeconds?: number;
  taskId?: string;
  enabled?: boolean;
}

export interface TaskBatchItem {
  task_id?: string;
  subject?: string;
  description?: string;
  active_form?: string;
  status?: "pending" | "in_progress" | "completed";
  owner?: string;
  blocked_by?: string[];
  blocks?: string[];
}

export interface TaskBatchArgs {
  mode: "replace" | "upsert" | "delete" | "clear_completed" | "list";
  tasks?: TaskBatchItem[];
  task_ids?: string[];
}

export interface ReportSubagentAssignmentArgs {
  agent_path: string;
  prompt: string;
}

export interface WorkReviewTargetArgs {
  kind: "url" | "file" | "image" | "html" | "html_plan" | "diff" | "session" | "custom";
  uri: string;
  label?: string;
  environment?: string;
  displayMode?: "auto" | "embedded" | "external";
  description?: string;
}

export interface WorkReviewItemArgs {
  item_id?: string;
  title: string;
  description?: string;
  instructions?: string;
  primary_target: WorkReviewTargetArgs;
  supporting_targets?: WorkReviewTargetArgs[];
}

export interface WorkReviewArgs {
  action: "create" | "get" | "list" | "export" | "new_round" | "archive";
  review_id?: string;
  idempotency_key?: string;
  title?: string;
  purpose?: string;
  summary?: string;
  instructions?: string;
  approval_meaning?: string;
  linked_html_plan_id?: string;
  items?: WorkReviewItemArgs[];
  include_archived?: boolean;
}

export interface RememberArgs {
  action: "search" | "list" | "get" | "context" | "runs";
  query?: string;
  session_seq?: number;
  entry_id?: string;
  before?: number;
  after?: number;
  direction?: "before" | "after";
  roles?: Array<
    "user" | "assistant" | "tool_call" | "tool_result" | "thinking"
    | "task_state" | "run_boundary" | "monitor" | "question"
    | "secure_input" | "work_review" | "html_plan"
  >;
  tool_name?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  max_chars?: number;
}

const SOCKETAGENT_TASK_SOURCE = "socketagent_tasks";
const TASK_BATCH_LIMIT = 200;

export async function handleReportSubagentAssignmentTool(
  ctx: AppToolContext,
  args: ReportSubagentAssignmentArgs,
): Promise<McpTextResult> {
  const agentPath = String(args.agent_path || "").trim();
  const prompt = String(args.prompt || "").trim();
  if (!agentPath || !prompt) {
    return {
      content: [{ type: "text", text: "Both agent_path and prompt are required." }],
      isError: true,
    };
  }
  if (!ctx.reportSubagentAssignment) {
    return {
      content: [{ type: "text", text: "Subagent assignment reporting is unavailable in this session." }],
      isError: true,
    };
  }
  if (!ctx.reportSubagentAssignment(agentPath, prompt)) {
    return {
      content: [{ type: "text", text: `No active SocketAgent subagent matches ${agentPath}.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: "Assignment attached to the subagent card." }],
  };
}

function batchTaskId(existingIds: Set<string>): string {
  while (true) {
    const candidate = `sa-${crypto.randomUUID().slice(0, 12)}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

function boundedTaskText(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return text || undefined;
}

function taskBatchView(task: Record<string, any>): Record<string, unknown> {
  return {
    task_id: String(task.id || task.taskId || ""),
    subject: String(task.content || ""),
    description: String(task.description || ""),
    active_form: String(task.activeForm || task.content || ""),
    status: String(task.status || "pending"),
    ...(task.owner ? { owner: String(task.owner) } : {}),
    blocked_by: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : [],
  };
}

function taskFromBatchItem(
  item: TaskBatchItem,
  id: string,
  previous?: Record<string, any>,
): Record<string, any> {
  const subject = boundedTaskText(
    item.subject ?? previous?.content,
    "subject",
    500,
    true,
  )!;
  const description = boundedTaskText(
    item.description ?? previous?.description,
    "description",
    10_000,
  );
  const activeForm = boundedTaskText(
    item.active_form ?? previous?.activeForm ?? subject,
    "active_form",
    500,
  ) || subject;
  const status = item.status || previous?.status || "pending";
  const owner = boundedTaskText(item.owner ?? previous?.owner, "owner", 500);
  const blockedBy = (item.blocked_by ?? previous?.blockedBy ?? [])
    .map(String)
    .filter(Boolean)
    .slice(0, TASK_BATCH_LIMIT);
  const blocks = (item.blocks ?? previous?.blocks ?? [])
    .map(String)
    .filter(Boolean)
    .slice(0, TASK_BATCH_LIMIT);
  return {
    ...(previous || {}),
    id,
    taskId: id,
    content: subject,
    activeForm,
    status,
    source: SOCKETAGENT_TASK_SOURCE,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    blockedBy,
    blocks,
  };
}

export async function handleTaskBatchTool(
  ctx: AppToolContext,
  args: TaskBatchArgs,
): Promise<McpTextResult> {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return {
      content: [{ type: "text", text: "TaskBatch requires an active SocketAgent session." }],
      isError: true,
    };
  }
  try {
    const current = getTodos(sessionId);
    const otherTasks = current.filter(
      (task) => task?.source !== SOCKETAGENT_TASK_SOURCE,
    );
    let managed = current
      .filter((task) => task?.source === SOCKETAGENT_TASK_SOURCE)
      .map((task) => ({ ...task }));
    const existingIds = new Set(
      managed.map((task) => String(task.id || task.taskId || "")).filter(Boolean),
    );
    const items = args.tasks || [];
    if (items.length > TASK_BATCH_LIMIT) {
      throw new Error(`TaskBatch accepts at most ${TASK_BATCH_LIMIT} tasks per call`);
    }

    switch (args.mode) {
      case "replace":
      {
        const requestedIds = new Set<string>();
        managed = items.map((item) => {
          const requestedId = boundedTaskText(item.task_id, "task_id", 200);
          if (requestedId && requestedIds.has(requestedId)) {
            throw new Error(`Duplicate SocketAgent task id: ${requestedId}`);
          }
          if (requestedId) requestedIds.add(requestedId);
          const id = requestedId || batchTaskId(existingIds);
          if (existingIds.has(id) && !requestedId) {
            throw new Error("Could not allocate a unique task id");
          }
          existingIds.add(id);
          return taskFromBatchItem(item, id);
        });
        break;
      }
      case "upsert":
      {
        const requestedIds = new Set<string>();
        for (const item of items) {
          const requestedId = boundedTaskText(item.task_id, "task_id", 200);
          if (requestedId && requestedIds.has(requestedId)) {
            throw new Error(`Duplicate SocketAgent task id: ${requestedId}`);
          }
          if (requestedId) requestedIds.add(requestedId);
          const index = requestedId
            ? managed.findIndex(
                (task) => String(task.id || task.taskId || "") === requestedId,
              )
            : -1;
          if (requestedId && index < 0) {
            throw new Error(`Unknown SocketAgent task id: ${requestedId}`);
          }
          const id = requestedId || batchTaskId(existingIds);
          existingIds.add(id);
          const updated = taskFromBatchItem(
            item,
            id,
            index >= 0 ? managed[index] : undefined,
          );
          if (index >= 0) managed[index] = updated;
          else managed.push(updated);
        }
        break;
      }
      case "delete": {
        const ids = new Set((args.task_ids || []).map(String).filter(Boolean));
        if (ids.size > TASK_BATCH_LIMIT) {
          throw new Error(`TaskBatch accepts at most ${TASK_BATCH_LIMIT} task_ids per call`);
        }
        managed = managed.filter(
          (task) => !ids.has(String(task.id || task.taskId || "")),
        );
        break;
      }
      case "clear_completed":
        managed = managed.filter((task) => task.status !== "completed");
        break;
      case "list":
        break;
      default:
        throw new Error(`Unsupported TaskBatch mode: ${String(args.mode)}`);
    }

    const next = [...otherTasks, ...managed];
    if (args.mode !== "list" && JSON.stringify(next) !== JSON.stringify(current)) {
      saveTodos(sessionId, next);
      ctx.appendHistory?.({
        role: "todos_update",
        content: JSON.stringify(next),
        timestamp: new Date().toISOString(),
      });
      ctx.send({
        type: "todos",
        todos: next,
        sessionId,
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: args.mode,
          count: managed.length,
          tasks: managed.map(taskBatchView),
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: `TaskBatch error: ${error?.message || String(error)}`,
      }],
      isError: true,
    };
  }
}

function delegatedAgentSummary(
  record: DelegatedAgentRecord,
  includeResult = true,
): Record<string, unknown> {
  const latestRun = record.runs.at(-1);
  const result = latestRun?.result;
  return {
    delegation_id: record.delegationId,
    session_id: record.childSessionId || null,
    backend: record.backend,
    cwd: record.cwd,
    label: record.label,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    run_count: record.runs.length,
    ...(latestRun ? {
      latest_run: {
        run_id: latestRun.runId,
        run_number: latestRun.runNumber,
        status: latestRun.status,
        started_at: latestRun.startedAt,
        completed_at: latestRun.completedAt || null,
        result: includeResult && result
          ? (result.length <= 12_000 ? result : `${result.slice(0, 12_000)}\n[truncated]`)
          : null,
        error: latestRun.error || null,
        report_status: latestRun.reportStatus || null,
      },
    } : {}),
  };
}

export async function handleAgentSessionTool(
  ctx: AppToolContext,
  args: AgentSessionToolArgs,
): Promise<McpTextResult> {
  if (!ctx.manageAgentSession) {
    return {
      content: [{ type: "text", text: "AgentSession is unavailable because this SocketAgent session is not attached to the delegation runtime." }],
      isError: true,
    };
  }
  try {
    const response = await ctx.manageAgentSession(args);
    if (response.delegations) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            response.delegations.map((record) => delegatedAgentSummary(record, false)),
            null,
            2,
          ),
        }],
      };
    }
    if (response.tail) {
      return {
        content: [{
          type: "text",
          text: `${response.message || "Recent delegated agent activity."}\n${JSON.stringify(response.tail, null, 2)}`,
        }],
      };
    }
    if (!response.delegation) {
      return {
        content: [{ type: "text", text: response.message || "AgentSession request completed." }],
      };
    }
    const record = response.delegation;
    const summary = delegatedAgentSummary(record);
    const guidance = response.action === "start"
      ? `\nUse action="message" with session_id="${record.childSessionId}" for follow-ups or added context, including while it is running; running-child messages are injected at the next safe boundary. SocketAgent will automatically continue this supervising session with the child's result when it finishes, even if this turn has already ended. Do not poll or keep this turn open merely to wait; continue other useful work or finish the turn. Use action="tail" only when you actually need interim progress.`
      : "";
    return {
      content: [{
        type: "text",
        text: `${response.message || "AgentSession request completed."}\n${JSON.stringify(summary, null, 2)}${guidance}`,
      }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `AgentSession error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

/**
 * A `pgrep -f 'literal'` watcher sees the literal in its own parent shell's
 * argv and therefore never finishes. Bracketed patterns such as `[f]oo` are
 * safe because the regex matches the target argv but not its own source text.
 */
export function monitorCommandHasSelfMatchingPgrep(command: string): boolean {
  const pgrepPattern = /\bpgrep\s+((?:(?:-[A-Za-z]+|--full)\s+)*)(["'])(.*?)\2/g;
  for (const match of command.matchAll(pgrepPattern)) {
    const flags = match[1] || "";
    if (!flags.includes("--full") && !/(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(flags)) {
      continue;
    }
    try {
      if (new RegExp(match[3]).test(match[3])) return true;
    } catch {
      // Let the shell report malformed regex syntax rather than guessing.
    }
  }
  return false;
}

export interface SearchSkillsArgs {
  query?: string;
  limit?: number;
}

export interface ReadSkillArgs {
  name?: string;
  filePath?: string;
}

export type RequestSecureInputArgs = SecureInputRequestArgs;

export interface HtmlPlanArgs {
  title: string;
  html: string;
  plan_id?: string;
}

interface AppMonitorState {
  ctx: AppToolContext;
  record: DurableMonitorRecord;
  description: string;
  outputFile: string;
  lastSize: number;
  agentReadOffset: number;
  agentPendingEnd: number;
  readerInterval: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<boolean> | null;
  outputBuffer: string[];
  completing: boolean;
}

const appMonitors: Map<string, AppMonitorState> = new Map();

export async function handleHtmlPlanTool(
  ctx: AppToolContext,
  args: HtmlPlanArgs,
): Promise<McpTextResult> {
  try {
    const sessionId = ctx.getSessionId();
    const saved = saveHtmlPlan({
      sessionId,
      title: args.title,
      html: args.html,
      planId: args.plan_id,
    });
    removeHtmlPlanHistoryEntries(sessionId, saved.planId);
    const positioned = ctx.appendHistory?.({
      role: "html_plan",
      content: saved.title,
      toolName: "HtmlPlan",
      toolInput: saved,
      toolUseId: `html_plan_${saved.planId}`,
      timestamp: saved.updatedAt,
    }) as Record<string, any> | undefined;
    ctx.send({
      type: "html_plan",
      ...saved,
      ...(positioned?.entryId ? { entryId: positioned.entryId } : {}),
      ...(positioned?.sessionSeq ? { sessionSeq: positioned.sessionSeq } : {}),
      ...(positioned?.revision ? { revision: positioned.revision } : {}),
    });
    return {
      content: [{
        type: "text",
        text: `HTML plan presented to the user. Plan ID: ${saved.planId}. Reuse this plan_id to update it instead of creating another plan.`,
      }],
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `HTML plan error: ${e.message || String(e)}` }],
      isError: true,
    };
  }
}

function workReviewItems(items: WorkReviewItemArgs[] | undefined): Record<string, unknown>[] {
  return (items || []).map((item) => ({
    ...(item.item_id ? { itemId: item.item_id } : {}),
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...(item.instructions ? { instructions: item.instructions } : {}),
    primaryTarget: item.primary_target,
    ...(item.supporting_targets ? { supportingTargets: item.supporting_targets } : {}),
  }));
}

/**
 * Upsert the single durable chat card for a review. appendHistory replaces the
 * existing logical entry because both its review key and explicit entryId are
 * stable; it never removes/re-appends the card at a new transcript position.
 */
export function publishWorkReviewCard(
  ctx: Pick<AppToolContext, "appendHistory" | "send">,
  review: Record<string, any>,
): Record<string, any> | undefined {
  const reviewId = String(review.reviewId || "");
  const sessionId = String(review.originSessionId || "");
  if (!reviewId || !sessionId) return undefined;
  const round = Array.isArray(review.rounds)
    ? review.rounds.find((candidate: any) =>
        Number(candidate?.revision) === Number(review.currentRevision))
      || review.rounds[review.rounds.length - 1]
    : undefined;
  const linkedHtmlPlan = round?.linkedHtmlPlanId
    ? getHtmlPlan(sessionId, round.linkedHtmlPlanId)
    : undefined;
  const cardReview = {
    reviewId,
    cardId: review.cardId,
    originSessionId: sessionId,
    ...(review.originBackend ? { originBackend: review.originBackend } : {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...(review.archivedAt ? { archivedAt: review.archivedAt } : {}),
    currentRevision: review.currentRevision,
    roundId: round?.roundId,
    title: round?.title || "Work review",
    ...(round?.linkedHtmlPlanId ? { linkedHtmlPlanId: round.linkedHtmlPlanId } : {}),
    ...(linkedHtmlPlan ? { linkedHtmlPlan } : {}),
    ...(round?.purpose ? { purpose: round.purpose } : {}),
    ...(round?.summary ? { summary: round.summary } : {}),
    ...(round?.instructions ? { instructions: round.instructions } : {}),
    ...(round?.approvalMeaning ? { approvalMeaning: round.approvalMeaning } : {}),
    items: Array.isArray(round?.items) ? round.items : [],
    status: round?.status || "in_review",
    ...(round?.result ? { result: round.result } : {}),
  };
  const positioned = ctx.appendHistory?.({
    role: "work_review",
    content: String(cardReview.title),
    toolName: "WorkReview",
    reviewId,
    workReview: cardReview,
    entryId: String(review.cardId || `work-review:${reviewId}`),
    timestamp: String(review.updatedAt || new Date().toISOString()),
  }) as Record<string, any> | undefined;
  if (!positioned?.entryId || !positioned?.sessionSeq || !positioned?.revision) {
    return positioned;
  }
  ctx.send({
    type: "work_review_card",
    reviewId,
    sessionId,
    review: cardReview,
    entryId: positioned.entryId,
    sessionSeq: positioned.sessionSeq,
    revision: positioned.revision,
  });
  return positioned;
}

export async function handleWorkReviewTool(
  ctx: AppToolContext,
  args: WorkReviewArgs,
): Promise<McpTextResult> {
  const originSessionId = ctx.getSessionId();
  if (!originSessionId) {
    return {
      content: [{ type: "text", text: "WorkReview requires an active SocketAgent session." }],
      isError: true,
    };
  }
  try {
    let result: unknown;
    switch (args.action) {
      case "create": {
        if (!args.idempotency_key?.trim()) throw new Error("idempotency_key is required");
        if (!args.title?.trim()) throw new Error("title is required");
        if (!args.items?.length) throw new Error("items must contain at least one review item");
        if (args.linked_html_plan_id?.trim()
          && !getHtmlPlan(originSessionId, args.linked_html_plan_id.trim())) {
          throw new Error(`HTML plan not found in this session: ${args.linked_html_plan_id.trim()}`);
        }
        const review = await createWorkReview({
          idempotencyKey: args.idempotency_key.trim(),
          originSessionId,
          originBackend: ctx.getBackend?.(),
          title: args.title,
          linkedHtmlPlanId: args.linked_html_plan_id?.trim(),
          purpose: args.purpose,
          summary: args.summary,
          instructions: args.instructions,
          approvalMeaning: args.approval_meaning,
          items: workReviewItems(args.items) as any,
        });
        const card = publishWorkReviewCard(ctx, review as any);
        result = {
          review,
          ...(card ? {
            card: {
              entryId: card.entryId,
              sessionSeq: card.sessionSeq,
              revision: card.revision,
            },
          } : {}),
        };
        break;
      }
      case "get": {
        if (!args.review_id?.trim()) throw new Error("review_id is required");
        const review = getWorkReview(args.review_id.trim());
        if (!review) throw new Error(`Work review not found: ${args.review_id.trim()}`);
        result = review;
        break;
      }
      case "list":
        result = listWorkReviews({
          originSessionId,
          includeArchived: args.include_archived === true,
        });
        break;
      case "export":
        result = exportWorkReviews({
          originSessionId,
          includeArchived: args.include_archived === true,
        });
        break;
      case "new_round": {
        if (!args.review_id?.trim()) throw new Error("review_id is required");
        if (!args.idempotency_key?.trim()) throw new Error("idempotency_key is required");
        if (!args.title?.trim()) throw new Error("title is required");
        if (!args.items?.length) throw new Error("items must contain at least one review item");
        if (args.linked_html_plan_id?.trim()
          && !getHtmlPlan(originSessionId, args.linked_html_plan_id.trim())) {
          throw new Error(`HTML plan not found in this session: ${args.linked_html_plan_id.trim()}`);
        }
        const existing = getWorkReview(args.review_id.trim());
        if (!existing) throw new Error(`Work review not found: ${args.review_id.trim()}`);
        if (String((existing as any).originSessionId || "") !== originSessionId) {
          throw new Error("Only the originating session can create a new review round");
        }
        const review = await createWorkReviewRound(args.review_id.trim(), {
          idempotencyKey: args.idempotency_key.trim(),
          title: args.title,
          linkedHtmlPlanId: args.linked_html_plan_id?.trim(),
          purpose: args.purpose,
          summary: args.summary,
          instructions: args.instructions,
          approvalMeaning: args.approval_meaning,
          items: workReviewItems(args.items) as any,
        });
        const card = publishWorkReviewCard(ctx, review as any);
        result = { review, ...(card ? { card: {
          entryId: card.entryId,
          sessionSeq: card.sessionSeq,
          revision: card.revision,
        } } : {}) };
        break;
      }
      case "archive": {
        if (!args.review_id?.trim()) throw new Error("review_id is required");
        const existing = getWorkReview(args.review_id.trim());
        if (!existing) throw new Error(`Work review not found: ${args.review_id.trim()}`);
        if (String((existing as any).originSessionId || "") !== originSessionId) {
          throw new Error("Only the originating session can archive a work review");
        }
        const review = await archiveWorkReview(args.review_id.trim());
        const card = publishWorkReviewCard(ctx, review as any);
        result = { review, ...(card ? { card: {
          entryId: card.entryId,
          sessionSeq: card.sessionSeq,
          revision: card.revision,
        } } : {}) };
        break;
      }
      default:
        throw new Error(`Unsupported WorkReview action: ${String(args.action)}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: `WorkReview error: ${error?.message || String(error)}`,
      }],
      isError: true,
    };
  }
}

function appendVisibleToolHistory(
  ctx: AppToolContext,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  extra: Record<string, unknown> = {},
): void {
  if (!ctx.appendHistory) return;
  const toolUseId = `mcp_${toolName}_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  ctx.appendHistory({
    role: "tool_call",
    content: JSON.stringify(toolInput),
    toolName,
    toolInput,
    toolUseId,
    timestamp,
    ...extra,
  });
  ctx.appendHistory({
    role: "tool_result",
    content: toolOutput,
    toolUseId,
    toolOutput,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

export async function handleSpeakTool(
  ctx: AppToolContext,
  args: { text: string },
): Promise<McpTextResult> {
  try {
    console.log(`[MCP:Speak] Called with ${args.text.length} chars`);
    ctx.send({
      type: "speak",
      text: args.text,
      sessionId: ctx.getSessionId(),
    } as any);

    if (ctx.getTtsEngine() === "kokoro_server") {
      try {
        const wavBuffer = generateKokoroAudio(args.text, ctx.getKokoroVoice(), ctx.getKokoroSpeed());
        if (wavBuffer) {
          ctx.send({
            type: "tts_audio",
            audioData: wavBuffer.toString("base64"),
            text: args.text,
            sessionId: ctx.getSessionId(),
          } as any);
        }
      } catch (e) {
        console.error("[KokoroTTS] Error generating audio:", e);
      }
    }

    console.log("[MCP:Speak] Returning result");
    const resultText = "Speaking to user.";
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    console.error(`[MCP:Speak] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `Speak error: ${e.message}` }], isError: true };
  }
}

export async function handleSendFileTool(
  ctx: AppToolContext,
  args: { file_path: string },
): Promise<McpTextResult> {
  try {
    const filePath = args.file_path;
    console.log(`[MCP:SendFile] Called with path=${filePath}`);
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }] };
    }
    const sourceStat = fs.statSync(filePath);
    if (!sourceStat.isFile()) {
      return { content: [{ type: "text", text: `Not a file: ${filePath}` }], isError: true };
    }
    const fileName = path.basename(filePath);
    const sessionId = ctx.getSessionId();
    // This identifies one delivery, not the underlying path/content. Reusing
    // a deterministic path hash made a later card inherit an earlier card's
    // downloaded state whenever the file had not changed.
    const fileId = `send_${crypto.randomUUID()}`;
    const fileDeliveryPath = await snapshotSendFile(filePath, fileId);
    const stat = fs.statSync(fileDeliveryPath);
    const fileVersion = fileTransferVersion(stat);
    const advertisedAtMs = Date.now();

    // Tool calls are normally persisted before their handler runs. Keep a
    // short asynchronous retry window for SDKs that deliver those events in
    // the opposite order, without delaying the tool result.
    const sendAvailability = (entry?: HistoryEntry): void => {
      ctx.send({
        type: "file",
        fileId,
        fileName,
        filePath,
        downloadPath: fileDeliveryPath,
        fileSize: stat.size,
        fileVersion,
        sessionId,
        ...(entry?.toolUseId ? { toolUseId: entry.toolUseId } : {}),
        ...(entry?.entryId ? { entryId: entry.entryId } : {}),
      });
    };
    const persistDelivery = (attempt = 0): HistoryEntry | undefined => {
      let attachedEntry: HistoryEntry | undefined;
      try {
        attachedEntry = attachSendFileDeliveryToHistory(sessionId, {
          filePath,
          fileDeliveryPath,
          fileId,
          fileName,
          fileSize: stat.size,
          fileVersion,
          advertisedAtMs,
        });
      } catch (error: any) {
        console.error(
          `[MCP:SendFile] Could not persist delivery metadata: ${error?.message || String(error)}`,
        );
      }
      if (attachedEntry) {
        // When the first attempt raced the SDK's canonical tool event, send a
        // second, exactly-addressed registration once that identity exists.
        if (attempt > 0) sendAvailability(attachedEntry);
        return attachedEntry;
      }
      if (attempt < 8) {
        const timer = setTimeout(
          () => persistDelivery(attempt + 1),
          50 * (attempt + 1),
        );
        timer.unref?.();
      }
      return undefined;
    };
    const attachedEntry = sessionId ? persistDelivery() : undefined;
    sendAvailability(attachedEntry);

    const sizeStr = sizeLabel(stat.size);
    console.log(`[MCP:SendFile] Returning result for ${fileName} (${sizeStr})`);
    const resultText = `File ready for download: ${fileName} (${sizeStr})`;
    // The Claude SDK and Codex app-server both persist their own canonical
    // tool_call/tool_result pair. Writing another synthetic pair here made
    // the same card occupy two history offsets and move across page loads.
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    console.error(`[MCP:SendFile] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `SendFile error: ${e.message}` }], isError: true };
  }
}

export async function handleRequestSecureInputTool(
  ctx: AppToolContext,
  args: RequestSecureInputArgs,
): Promise<McpTextResult> {
  const label = (args.label || "").trim() || "Secret";
  try {
    const saved = await requestSecureInput(
      (msg) => ctx.send(msg),
      {
        label,
        reason: args.reason,
        envHint: args.envHint,
        scope: args.scope,
        timeoutSeconds: args.timeoutSeconds,
      },
      ctx.getSessionId(),
      ctx.getCwd?.(),
      (request, status: SecureInputRequestStatus) => {
        if (!ctx.appendHistory) return;
        const requestId = String(request.requestId || "");
        const reason = String(request.reason || "");
        ctx.appendHistory({
          role: "secure_input",
          content: reason,
          questionId: requestId,
          answered: status !== "pending",
          status,
          toolInput: {
            label: String(request.label || label),
            reason,
            envHint: String(request.envHint || ""),
            scope: String(request.scope || "session"),
            multiline: request.multiline === true,
            status,
          },
          timestamp: new Date().toISOString(),
        });
      },
    );
    const resultText = [
      "Secure input saved.",
      `Label: ${saved.label}`,
      `Secret ID: ${saved.secretId}`,
      `Scope: ${saved.scope}`,
      `File path: ${saved.filePath}`,
      `Suggested env var: ${saved.envHint}`,
      "",
      "Use the file path or suggested env var name in commands. Do not print the secret value.",
    ].join("\n");
    appendVisibleToolHistory(
      ctx,
      "RequestSecureInput",
      { label, reason: args.reason || "", scope: saved.scope, envHint: saved.envHint },
      resultText,
    );
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Secure input request failed: ${e.message || e}` }], isError: true };
  }
}

export async function handleScheduleReminderTool(
  ctx: AppToolContext,
  args: ReminderArgs,
): Promise<McpTextResult> {
  const scheduledDate = new Date(args.scheduledTime);
  if (isNaN(scheduledDate.getTime())) {
    return { content: [{ type: "text", text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return { content: [{ type: "text", text: "Scheduled time is in the past. Please provide a future time." }] };
  }

  const hash = crypto.createHash("md5").update(`${args.title}:${args.scheduledTime}`).digest();
  const notificationId = Math.abs(hash.readInt32BE(0));

  ctx.send({
    type: "reminder",
    title: args.title,
    body: args.body || "",
    scheduledTime: args.scheduledTime,
    notificationId,
    sessionId: ctx.getSessionId(),
  } as any);

  const when = scheduledDate.toLocaleString();
  return { content: [{ type: "text", text: `Reminder scheduled: "${args.title}" at ${when}` }] };
}

export async function handleNotifyUserTool(
  ctx: AppToolContext,
  args: NotifyUserArgs,
): Promise<McpTextResult> {
  const title = args.title.trim();
  const body = (args.body || "").trim();
  if (!title) {
    return { content: [{ type: "text", text: "NotifyUser error: title is required" }], isError: true };
  }

  const eventId = `tool_notification:${ctx.getSessionId() || "none"}:${crypto.randomUUID()}`;
  const fromScheduledTask = getScheduledTaskSessionIds().has(ctx.getSessionId());

  ctx.send({
    type: "scheduled_task_notification",
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
    kind: "tool_notification",
    eventId,
    ...(fromScheduledTask ? { navigationTarget: "scheduled_tasks" } : {}),
    // The tool handler owns delivery. Headless task forwarding must not send
    // this same event through FCM a second time.
    fcmDispatched: true,
  } as any);
  sendPushNotification({
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
    kind: "tool_notification",
    data: {
      eventId,
      ...(fromScheduledTask ? { navigationTarget: "scheduled_tasks" } : {}),
    },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for NotifyUser session=${ctx.getSessionId() || "none"}`);
    }
  }).catch((err) => {
    console.warn(`[Push] NotifyUser push error: ${err?.message || err}`);
  });
  ctx.appendHistory?.({
    role: "notification",
    entryId: eventId,
    content: body ? `${title}\n${body}` : title,
    status: "manual",
    toolInput: {
      kind: "notify_user",
      title,
      body,
    },
    timestamp: new Date().toISOString(),
  });

  return { content: [{ type: "text", text: `Notification sent: "${title}"` }] };
}

export async function handleScheduleTaskTool(
  ctx: AppToolContext,
  args: ScheduleTaskArgs,
): Promise<McpTextResult> {
  const scheduledDate = new Date(args.scheduledTime);
  if (isNaN(scheduledDate.getTime())) {
    return { content: [{ type: "text", text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return { content: [{ type: "text", text: "Scheduled time is in the past. Please provide a future time." }] };
  }

  const recurrenceType = args.recurrenceType || "once";
  const recurrence: RecurrenceConfig | undefined = recurrenceType !== "once" ? {
    type: recurrenceType,
    intervalMs: recurrenceType === "custom" ? args.customIntervalMs : undefined,
  } : undefined;

  const backend = args.backend || ctx.getBackend?.() || "claude";
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    ...(args.name?.trim() ? { name: args.name.trim() } : {}),
    prompt: args.prompt,
    cwd: args.cwd,
    backend,
    ...(backend === "codex"
      ? { codexDriver: "app-server" as CodexDriver }
      : {}),
    ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    scheduledTime: args.scheduledTime,
    createdAt: new Date().toISOString(),
    status: "pending",
    createdBySessionId:
      ctx.getDelegationSupervisorSessionId?.() ||
      ctx.getSessionId() ||
      undefined,
    recurrence,
    reuseSession: args.reuseSession || false,
    notificationMode: args.notificationMode === "quiet" ? "quiet" : "completion",
    runCount: 0,
    runs: [],
  };
  saveScheduledTask(task);

  ctx.send({
    type: "scheduled_task_update",
    task,
  } as any);

  const when = scheduledDate.toLocaleString();
  const recurrenceLabel = recurrence ? ` (recurring: ${recurrence.type})` : "";
  const notificationLabel = task.notificationMode === "quiet" ? " Quiet mode is on." : "";
  const label = task.name ? `"${task.name}"` : "Task";
  return { content: [{ type: "text", text: `${label} scheduled for ${when}${recurrenceLabel} in ${args.cwd}.${notificationLabel}\n"${args.prompt.slice(0, 300)}"` }] };
}

function codexSkillsForContext(ctx: AppToolContext): SkillEntry[] {
  return listSkills(ctx.getCwd?.()).filter((skill) => skill.agent === "codex" && skill.format === "skill");
}

function skillSummary(skill: SkillEntry): string {
  const description = skill.description ? ` - ${skill.description}` : "";
  return `${skill.name} (${skill.scope})${description}\npath: ${skill.filePath}`;
}

function rememberEntryView(entry: HistoryEntry, fieldLimit: number): Record<string, unknown> {
  const bounded = (value: unknown): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > fieldLimit
      ? `${text.slice(0, fieldLimit)}\n…[truncated ${text.length - fieldLimit} characters]`
      : text;
  };
  const content = bounded(entry.content);
  const toolInput = bounded(entry.toolInput);
  const toolOutput = bounded(entry.toolOutput);
  return {
    session_seq: entry.sessionSeq,
    entry_id: entry.entryId,
    revision: entry.revision,
    timestamp: entry.timestamp,
    role: entry.role,
    ...(entry.toolName ? { tool_name: entry.toolName } : {}),
    ...(content ? { content } : {}),
    ...(toolInput ? { tool_input: toolInput } : {}),
    ...(toolOutput ? { tool_output: toolOutput } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.runId ? { run_id: entry.runId } : {}),
    ...(entry.runDurationMs !== undefined ? { run_duration_ms: entry.runDurationMs } : {}),
  };
}

function rememberResult(payload: unknown, maxChars: number): McpTextResult {
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.length <= maxChars) {
    return { content: [{ type: "text", text: serialized }] };
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        truncated: true,
        returned_characters: maxChars,
        note: "Narrow the search or request fewer surrounding entries.",
        preview: serialized.slice(0, maxChars),
      }, null, 2),
    }],
  };
}

/** Search and retrieve the current session's durable pre-compaction memory. */
export async function handleRememberTool(
  ctx: AppToolContext,
  args: RememberArgs,
): Promise<McpTextResult> {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return { content: [{ type: "text", text: "Remember is unavailable until this session has an ID." }], isError: true };
  }
  const maxChars = Math.max(2_000, Math.min(200_000, Math.floor(args.max_chars ?? 60_000)));
  try {
    switch (args.action) {
      case "search": {
        const query = String(args.query || "").trim();
        if (!query) throw new Error("query is required for Remember search");
        const roles = args.roles?.length ? args.roles : ["user", "assistant"];
        const hits = rememberSearchHistory(sessionId, {
          query,
          roles,
          ...(args.tool_name ? { toolName: args.tool_name } : {}),
          ...(args.since ? { since: args.since } : {}),
          ...(args.until ? { until: args.until } : {}),
          limit: Math.max(1, Math.min(50, Math.floor(args.limit ?? 10))),
          offset: Math.max(0, Math.floor(args.offset ?? 0)),
        });
        return rememberResult({
          action: "search",
          query,
          result_count: hits.length,
          next_offset: (args.offset ?? 0) + hits.length,
          results: hits.map((hit) => ({
            session_seq: hit.sessionSeq,
            entry_id: hit.entryId,
            revision: hit.revision,
            timestamp: hit.timestamp,
            role: hit.role,
            ...(hit.toolName ? { tool_name: hit.toolName } : {}),
            preview: hit.preview,
          })),
        }, maxChars);
      }
      case "get": {
        const sessionSeq = args.session_seq;
        const entryId = String(args.entry_id || "").trim() || undefined;
        if (!entryId && (!Number.isSafeInteger(sessionSeq) || sessionSeq! <= 0)) {
          throw new Error("entry_id or session_seq is required for Remember get");
        }
        const entry = rememberGetHistoryEntry(sessionId, {
          ...(entryId ? { entryId } : {}),
          ...(sessionSeq ? { sessionSeq } : {}),
        });
        if (!entry) {
          return { content: [{ type: "text", text: "No matching durable history entry was found." }], isError: true };
        }
        return rememberResult({ action: "get", entry: rememberEntryView(entry, Math.floor(maxChars / 2)) }, maxChars);
      }
      case "list": {
        const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)));
        const entries = rememberListHistory(sessionId, {
          ...(args.session_seq ? { sessionSeq: args.session_seq } : {}),
          direction: args.direction ?? "before",
          limit,
        });
        const perEntryLimit = Math.max(500, Math.floor(maxChars / Math.max(1, entries.length * 2)));
        return rememberResult({
          action: "list",
          direction: args.direction ?? "before",
          cursor_session_seq: args.session_seq,
          entries: entries.map((entry) => rememberEntryView(entry, perEntryLimit)),
          next_cursor: entries.length > 0
            ? (args.direction === "after" ? entries.at(-1)?.sessionSeq : entries[0].sessionSeq)
            : args.session_seq,
        }, maxChars);
      }
      case "context": {
        if (!Number.isSafeInteger(args.session_seq) || args.session_seq! <= 0) {
          throw new Error("session_seq is required for Remember context");
        }
        const before = Math.max(0, Math.min(20, Math.floor(args.before ?? 3)));
        const after = Math.max(0, Math.min(20, Math.floor(args.after ?? 3)));
        const entries = rememberHistoryContext(sessionId, args.session_seq!, before, after);
        const perEntryLimit = Math.max(500, Math.floor(maxChars / Math.max(1, entries.length * 2)));
        return rememberResult({
          action: "context",
          center_session_seq: args.session_seq,
          before,
          after,
          entries: entries.map((entry) => rememberEntryView(entry, perEntryLimit)),
        }, maxChars);
      }
      case "runs": {
        const runs = rememberRecentRuns(sessionId, Math.max(1, Math.min(50, Math.floor(args.limit ?? 10))));
        return rememberResult({
          action: "runs",
          runs: runs.map(({ prompt, boundary }) => ({
            session_seq: prompt.sessionSeq,
            entry_id: prompt.entryId,
            timestamp: prompt.timestamp,
            prompt: String(prompt.content || "").slice(0, 1_000),
            ...(boundary ? {
              completed_session_seq: boundary.sessionSeq,
              completed_at: boundary.timestamp,
              outcome: boundary.runOutcome,
              duration_ms: boundary.runDurationMs,
            } : { status: "no durable completion boundary" }),
          })),
        }, maxChars);
      }
      default:
        throw new Error(`Unsupported Remember action: ${String(args.action)}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

/** Persist a small set of confirmed facts across native thread rollovers. */
export async function handleSessionMemoryTool(
  ctx: AppToolContext,
  args: SessionMemoryToolArgs,
): Promise<McpTextResult> {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return {
      content: [{ type: "text", text: "Session memory is unavailable until this session has an ID." }],
      isError: true,
    };
  }
  try {
    let state;
    switch (args.action) {
      case "list":
        state = getSessionMemoryState(sessionId);
        break;
      case "upsert":
        if (!args.kind || !args.text?.trim()) {
          throw new Error("kind and text are required for SessionMemory upsert");
        }
        state = upsertSessionMemoryEntry(sessionId, {
          id: args.entry_id,
          kind: args.kind,
          text: args.text,
          pinned: args.pinned,
          status: args.status,
          sourceSessionSeq: args.source_session_seq,
          sourceEntryId: args.source_entry_id,
        });
        break;
      case "delete":
        if (!args.entry_id) throw new Error("entry_id is required for SessionMemory delete");
        state = deleteSessionMemoryEntry(sessionId, args.entry_id);
        break;
      default:
        throw new Error(`Unsupported SessionMemory action: ${String(args.action)}`);
    }
    ctx.send({ type: "session_memory_state", sessionId, state: { ...state } });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: args.action,
          entries: state.entries,
          rollover_pending: state.rolloverPending,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

export async function handleSearchSkillsTool(
  ctx: AppToolContext,
  args: SearchSkillsArgs,
): Promise<McpTextResult> {
  const query = (args.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Math.floor(args.limit || 10), 1), 25);
  let skills = codexSkillsForContext(ctx);
  if (query) {
    skills = skills.filter((skill) => {
      const haystack = [
        skill.name,
        skill.description,
        skill.scope,
        skill.pluginName || "",
        skill.body.slice(0, 1000),
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }
  skills = skills.slice(0, limit);
  if (skills.length === 0) {
    return { content: [{ type: "text", text: "No matching Codex skills found." }] };
  }
  return {
    content: [{
      type: "text",
      text: skills.map(skillSummary).join("\n\n"),
    }],
  };
}

export async function handleReadSkillTool(
  ctx: AppToolContext,
  args: ReadSkillArgs,
): Promise<McpTextResult> {
  const name = (args.name || "").trim().toLowerCase();
  const filePath = (args.filePath || "").trim();
  const skills = codexSkillsForContext(ctx);
  const skill = filePath
    ? skills.find((candidate) => path.resolve(candidate.filePath) === path.resolve(filePath))
    : skills.find((candidate) => candidate.name.toLowerCase() === name);

  if (!skill) {
    return { content: [{ type: "text", text: "Codex skill not found." }], isError: true };
  }

  const frontmatter = Object.entries(skill.frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const header = [
    `name: ${skill.name}`,
    `scope: ${skill.scope}`,
    `path: ${skill.filePath}`,
    frontmatter,
  ].filter(Boolean).join("\n");

  return {
    content: [{
      type: "text",
      text: `---\n${header}\n---\n\n${skill.body}`,
    }],
  };
}

function publishMonitorOutput(taskId: string, content: string): void {
  const state = appMonitors.get(taskId);
  if (!state || !content) return;
  const sessionId = state.record.sessionId;
  const cumulative = readDurableMonitorSlice(state.record, 0).content;
  const positioned = state.ctx.appendHistory?.({
    role: "monitor",
    content: cumulative,
    taskId,
    description: state.description,
    toolInput: { snapshot: true },
    timestamp: new Date().toISOString(),
  });
  state.ctx.send({
    type: "monitor_output",
    taskId,
    content,
    snapshotContent: cumulative,
    description: state.description,
    snapshot: true,
    sessionId,
    ...((positioned && typeof positioned === "object") ? {
      entryId: (positioned as any).entryId,
      sessionSeq: (positioned as any).sessionSeq,
      revision: (positioned as any).revision,
    } : {}),
  } as any);
}

/** Read every byte written since the last poll before reporting/injecting it. */
function readMonitorOutput(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state || !fs.existsSync(state.outputFile)) return;
  try {
    const phoneSlice = readDurableMonitorSlice(state.record, state.lastSize);
    if (phoneSlice.end > state.lastSize) {
      state.lastSize = phoneSlice.end;
      publishMonitorOutput(taskId, phoneSlice.content);
      updateDurableMonitorRecord(taskId, { phoneOffset: phoneSlice.end });
    }

    const agentSlice = readDurableMonitorSlice(state.record, state.agentReadOffset);
    if (agentSlice.end > state.agentReadOffset) {
      const lines = agentSlice.content.split("\n").filter((line) => line.length > 0);
      state.agentReadOffset = agentSlice.end;
      state.agentPendingEnd = agentSlice.end;
      state.outputBuffer.push(...lines);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void flushMonitorBuffer(taskId);
      }, 5000);
    }
  } catch (err: any) {
    console.error(`[AppMonitor] Reader error for ${taskId}: ${err.message}`);
  }
}

function startMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  stopMonitorReader(taskId);
  state.readerInterval = setInterval(() => {
    readMonitorOutput(taskId);
    const latest = getDurableMonitorRecord(taskId);
    if (!latest || state.completing || (latest.status !== "completed" && latest.status !== "failed")) return;
    state.completing = true;
    stopMonitorReader(taskId);
    readMonitorOutput(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    void flushMonitorBuffer(taskId).then((delivered) => {
      if (delivered) {
        const exitCode = latest.exitCode ?? "unknown";
        finishAppMonitor(taskId, latest.status as "completed" | "failed", `Process exited with code ${exitCode}`);
      } else if (appMonitors.get(taskId) === state) {
        state.completing = false;
        startMonitorReader(taskId);
      }
    });
  }, 500);
}

function stopMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  if (state.readerInterval) clearInterval(state.readerInterval);
  state.readerInterval = null;
}

async function deliverMonitorBuffer(taskId: string, state: AppMonitorState): Promise<boolean> {
  if (state.outputBuffer.length === 0) return true;
  const deliveredLines = state.outputBuffer.length;
  const deliveredEnd = state.agentPendingEnd;
  const content = state.outputBuffer.slice(0, deliveredLines).join("\n");
  const text = `[Monitor: "${state.description}" (${taskId})]\n${content}`;

  if (state.ctx.isRunning?.() && state.ctx.injectMessage) {
    try {
      await state.ctx.injectMessage(text, "next");
      state.outputBuffer.splice(0, deliveredLines);
      updateDurableMonitorRecord(taskId, { agentOffset: deliveredEnd });
      return true;
    } catch (err: any) {
      state.agentReadOffset = getDurableMonitorRecord(taskId)?.agentOffset || 0;
      state.outputBuffer = [];
      console.error(`[AppMonitor] Inject error for ${taskId}: ${err.message}`);
      return false;
    }
  }

  state.outputBuffer.splice(0, deliveredLines);
  updateDurableMonitorRecord(taskId, { agentOffset: deliveredEnd });
  state.ctx.onMonitorOutput?.(text);
  return true;
}

async function flushMonitorBuffer(taskId: string): Promise<boolean> {
  const state = appMonitors.get(taskId);
  if (!state) return true;

  // A debounce flush can overlap the terminal flush. Serialize deliveries so
  // the completion path cannot remove the durable record while a newer chunk
  // is still waiting behind an in-flight agent injection.
  if (state.flushPromise) {
    const active = state.flushPromise;
    const delivered = await active;
    if (state.flushPromise === active) state.flushPromise = null;
    if (!delivered) return false;
    return flushMonitorBuffer(taskId);
  }

  if (state.outputBuffer.length === 0) return true;
  const delivery = deliverMonitorBuffer(taskId, state);
  state.flushPromise = delivery;
  const delivered = await delivery;
  if (state.flushPromise === delivery) state.flushPromise = null;
  if (!delivered) return false;
  return state.outputBuffer.length > 0 ? flushMonitorBuffer(taskId) : true;
}

function finishAppMonitor(taskId: string, status: "completed" | "failed", summary: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  stopMonitorReader(taskId);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  appMonitors.delete(taskId);
  removeDurableMonitorRecord(taskId);
  state.ctx.send({
    type: "monitor_started",
    taskId,
    description: state.description,
    monitoring: false,
    sessionId: state.record.sessionId,
  } as any);
  state.ctx.send({
    type: "task_notification",
    taskId,
    status,
    summary,
    sessionId: state.record.sessionId,
  } as any);
}

export function stopAppMonitor(taskId: string, flush = true, killProcess = false): boolean {
  const state = appMonitors.get(taskId);
  if (!state) return false;
  stopMonitorReader(taskId);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  if (flush) {
    readMonitorOutput(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    void flushMonitorBuffer(taskId);
  }
  appMonitors.delete(taskId);
  stopDurableMonitor(taskId, killProcess);
  state.ctx.send({
    type: "monitor_started",
    taskId,
    description: state.description,
    monitoring: false,
    sessionId: state.record.sessionId,
  } as any);
  return true;
}

/** Hard-stop every Monitor process owned by a SocketAgent session. */
export async function stopAppMonitorsForSession(sessionId: string): Promise<number> {
  const owned = [...appMonitors.entries()].filter(([, state]) =>
    state.record.sessionId === sessionId,
  );
  for (const [taskId, state] of owned) {
    stopMonitorReader(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    appMonitors.delete(taskId);
    state.ctx.send({
      type: "monitor_started",
      taskId,
      description: state.description,
      monitoring: false,
      sessionId,
    } as any);
  }
  await Promise.all(owned.map(([taskId]) => stopDurableMonitorAndWait(taskId, true)));
  return owned.length;
}

function scheduleMonitorTimeout(taskId: string, state: AppMonitorState): void {
  if (!state.record.timeoutAt) return;
  const remaining = new Date(state.record.timeoutAt).getTime() - Date.now();
  if (remaining <= 0) {
    stopAppMonitor(taskId, true, false);
    return;
  }
  state.timeoutTimer = setTimeout(() => {
    console.log(`[AppMonitor] Timeout reached for ${taskId}`);
    stopAppMonitor(taskId, true, false);
  }, remaining);
}

export function restoreAppMonitors(
  contextFor: (record: DurableMonitorRecord) => AppToolContext,
): number {
  let restored = 0;
  for (const record of listDurableMonitorRecords()) {
    if (appMonitors.has(record.taskId)) continue;
    const state: AppMonitorState = {
      ctx: contextFor(record),
      record,
      description: record.description,
      outputFile: record.outputFile,
      lastSize: record.phoneOffset || 0,
      agentReadOffset: record.agentOffset || 0,
      agentPendingEnd: record.agentOffset || 0,
      readerInterval: null,
      debounceTimer: null,
      timeoutTimer: null,
      flushPromise: null,
      outputBuffer: [],
      completing: false,
    };
    appMonitors.set(record.taskId, state);
    startMonitorReader(record.taskId);
    scheduleMonitorTimeout(record.taskId, state);
    state.ctx.send({
      type: "task_started",
      taskId: record.taskId,
      toolUseId: `monitor-${record.taskId}`,
      description: record.description,
      taskType: "monitor",
      sessionId: record.sessionId,
    } as any);
    state.ctx.send({
      type: "monitor_started",
      taskId: record.taskId,
      description: record.description,
      monitoring: true,
      command: record.command,
      sessionId: record.sessionId,
    } as any);
    restored++;
  }
  return restored;
}

export function activeAppMonitorRecords(): DurableMonitorRecord[] {
  return listDurableMonitorRecords();
}

/**
 * Detach live monitor delivery from a completed agent turn. Future output uses
 * the durable server router, which can resume the correct session even after
 * the original SDK object or phone connection has gone away.
 */
export function rebindAppMonitorsForSession(
  sessionId: string,
  contextFor: (record: DurableMonitorRecord) => AppToolContext,
): number {
  let rebound = 0;
  for (const state of appMonitors.values()) {
    if (state.record.sessionId !== sessionId) continue;
    state.ctx = contextFor(state.record);
    rebound++;
  }
  return rebound;
}

export async function handleMonitorTool(
  ctx: AppToolContext,
  args: MonitorArgs,
): Promise<McpTextResult> {
  try {
    if (args.taskId && !args.command) {
      const enabled = args.enabled !== false;
      if (!enabled) {
        return stopAppMonitor(args.taskId, true)
          ? { content: [{ type: "text", text: `Monitoring disabled for task ${args.taskId}. Process continues running.` }] }
          : { content: [{ type: "text", text: `Task ${args.taskId} is not being monitored.` }] };
      }
      return { content: [{ type: "text", text: "Codex can only toggle monitors that were started with the Monitor tool in this session." }], isError: true };
    }

    if (!args.command) {
      return { content: [{ type: "text", text: "Monitor requires either 'command' to start a monitored process or 'taskId' with enabled=false to stop monitoring." }], isError: true };
    }

    if (monitorCommandHasSelfMatchingPgrep(args.command)) {
      return {
        content: [{
          type: "text",
          text: "Monitor refused a self-matching `pgrep -f` command: the watcher shell contains the same pattern, so it would run forever. Monitor an exact PID/pidfile, or use a non-self-matching regex such as `pgrep -f '[f]etch_music.py --only'`.",
        }],
        isError: true,
      };
    }

    const sessionId = ctx.getSessionId();
    if (!sessionId) {
      return {
        content: [{
          type: "text",
          text: "Monitor could not start before the native session ID was available. Retry the Monitor call.",
        }],
        isError: true,
      };
    }
    const command = args.command;
    const description = args.description || command.slice(0, 60);
    const taskId = `monitor-${crypto.randomUUID().slice(0, 8)}`;
    const record = launchDurableMonitor(createDurableMonitorRecord({
      taskId,
      sessionId,
      backend: ctx.getBackend?.() || "codex",
      cwd: ctx.getCwd?.() || process.cwd(),
      command,
      description,
      timeoutSeconds: args.timeoutSeconds,
    }));

    const state: AppMonitorState = {
      ctx,
      record,
      description,
      outputFile: record.outputFile,
      lastSize: 0,
      agentReadOffset: 0,
      agentPendingEnd: 0,
      readerInterval: null,
      debounceTimer: null,
      timeoutTimer: null,
      flushPromise: null,
      outputBuffer: [],
      completing: false,
    };
    appMonitors.set(taskId, state);
    startMonitorReader(taskId);

    scheduleMonitorTimeout(taskId, state);

    ctx.send({ type: "task_started", taskId, toolUseId: `monitor-${taskId}`, description, taskType: "monitor", sessionId } as any);
    ctx.send({ type: "monitor_started", taskId, description, monitoring: true, command, sessionId } as any);

    let launched = record;
    for (let i = 0; i < 20 && !launched.processPid && launched.status === "starting"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      launched = getDurableMonitorRecord(taskId) || launched;
    }
    return { content: [{ type: "text", text: `Process started and monitoring enabled. Task ID: ${taskId}. PID: ${launched.processPid || "starting"}.${args.timeoutSeconds ? ` Monitoring timeout: ${args.timeoutSeconds}s.` : ""}` }] };
  } catch (e: any) {
    console.error(`[AppMonitor] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `Monitor error: ${e.message}` }], isError: true };
  }
}
