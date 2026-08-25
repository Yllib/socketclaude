import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AppToolContext,
  handleBrowserSessionTool,
  handleHtmlPlanTool,
  handleAgentSessionTool,
  handleMonitorTool,
  handleNotifyUserTool,
  handlePrivateIntegrationAuthTool,
  handleRememberTool,
  handleSessionMemoryTool,
  handleRequestSecureInputTool,
  handleReadSkillTool,
  handleReportSubagentAssignmentTool,
  handleScheduleReminderTool,
  handleScheduleTaskTool,
  handleSearchSkillsTool,
  handleSendFileTool,
  handleSpeakTool,
  handleTaskBatchTool,
  handleWorkReviewTool,
} from "./app-tool-handlers";
import {
  AGENT_SESSION_TOOL_DESCRIPTION,
  HTML_PLAN_TOOL_DESCRIPTION,
  REMEMBER_TOOL_DESCRIPTION,
  SESSION_MEMORY_TOOL_DESCRIPTION,
  WORK_REVIEW_TOOL_DESCRIPTION,
} from "./socketagent-instructions";

export interface SocketAgentAppToolManifest {
  name: string;
  description: string;
}

export const SOCKETAGENT_APP_TOOLS: SocketAgentAppToolManifest[] = [
  {
    name: "HtmlPlan",
    description: HTML_PLAN_TOOL_DESCRIPTION,
  },
  {
    name: "WorkReview",
    description: WORK_REVIEW_TOOL_DESCRIPTION,
  },
  {
    name: "SendFile",
    description: "Send a file to the user's mobile device for download.",
  },
  {
    name: "RequestSecureInput",
    description: "Ask the user for a credential/API key/token through a secure app card and receive only a local secret file path.",
  },
  {
    name: "PrivateIntegrationAuth",
    description: "Open a protected, plugin-owned sign-in card for an installed private integration.",
  },
  {
    name: "BrowserSession",
    description: "Open and control a persistent remote browser while sensitive input stays on the user's phone.",
  },
  {
    name: "Speak",
    description: "Speak concise text aloud to the user through app text-to-speech.",
  },
  {
    name: "ScheduleReminder",
    description: "Schedule a reminder notification on the user's mobile device.",
  },
  {
    name: "NotifyUser",
    description: "Send an immediate push notification to the user's mobile device.",
  },
  {
    name: "ScheduleTask",
    description: "Schedule a Claude or Codex prompt to run later or recur.",
  },
  {
    name: "TaskBatch",
    description: "Create, update, delete, clear, or list many session working tasks in one call.",
  },
  {
    name: "ReportSubagentAssignment",
    description: "Internal SocketAgent metadata handshake for spawned Codex subagents.",
  },
  {
    name: "Monitor",
    description: "Start or stop a background shell command monitor.",
  },
  {
    name: "AgentSession",
    description: AGENT_SESSION_TOOL_DESCRIPTION,
  },
  {
    name: "Remember",
    description: REMEMBER_TOOL_DESCRIPTION,
  },
  {
    name: "SessionMemory",
    description: SESSION_MEMORY_TOOL_DESCRIPTION,
  },
  {
    name: "SearchSkills",
    description: "Search SocketAgent-managed Codex skills.",
  },
  {
    name: "ReadSkill",
    description: "Read a SocketAgent-managed Codex skill's instructions.",
  },
];

interface CodexMcpRegistration {
  token: string;
  context: AppToolContext;
  transports: Map<string, StreamableHTTPServerTransport>;
}

const registrations = new Map<string, CodexMcpRegistration>();

export function registerCodexAppMcp(context: AppToolContext): { token: string; unregister: () => void } {
  const token = randomBytes(32).toString("base64url");
  const registration: CodexMcpRegistration = {
    token,
    context,
    transports: new Map(),
  };
  registrations.set(token, registration);
  return {
    token,
    unregister: () => unregisterCodexAppMcp(token),
  };
}

function unregisterCodexAppMcp(token: string): void {
  const registration = registrations.get(token);
  if (!registration) return;
  registrations.delete(token);
  for (const transport of registration.transports.values()) {
    void transport.close().catch((err) => {
      console.warn(`[Codex MCP] Failed to close transport: ${err.message}`);
    });
  }
  registration.transports.clear();
}

function createServer(context: AppToolContext): McpServer {
  const server = new McpServer({
    name: "socketagent-app",
    version: "1.0.0",
  });

  server.registerTool(
    "HtmlPlan",
    {
      title: "HTML Plan",
      description: HTML_PLAN_TOOL_DESCRIPTION,
      inputSchema: {
        title: z.string().describe("Short descriptive plan title"),
        html: z.string().describe("Complete polished HTML document for the detailed implementation/design plan. SocketAgent preserves and displays this value exactly. Inline assets and HTTPS resources are supported; viewer JavaScript is disabled."),
        plan_id: z.string().optional().describe("Existing plan ID to update. Omit to create a new plan."),
      },
    },
    async (args) => handleHtmlPlanTool(context, args as any),
  );

  const workReviewTargetSchema = z.object({
    kind: z.enum(["url", "file", "image", "html", "html_plan", "diff", "session", "custom"]),
    uri: z.string().describe("Address or identifier the reviewer opens or inspects"),
    label: z.string().optional(),
    environment: z.string().optional().describe("For example production, development, sandbox, or local"),
    displayMode: z.enum(["auto", "embedded", "external"]).optional(),
    description: z.string().optional(),
  });
  const workReviewPrimaryTargetSchema = workReviewTargetSchema.extend({
    displayMode: z.enum(["auto", "embedded"]).optional().describe(
      "Primary HTTP(S) targets are embedded beneath the review panel. Use auto or embedded.",
    ),
  });
  const workReviewItemSchema = z.object({
    item_id: z.string().optional().describe("Stable item ID; omit to generate one"),
    title: z.string(),
    description: z.string().optional(),
    instructions: z.string().optional().describe("What the reviewer should inspect or verify"),
    primary_target: workReviewPrimaryTargetSchema,
    supporting_targets: z.array(workReviewTargetSchema).optional(),
  });
  server.registerTool(
    "WorkReview",
    {
      title: "Work Review",
      description: WORK_REVIEW_TOOL_DESCRIPTION,
      inputSchema: {
        action: z.enum(["create", "get", "list", "export", "new_round", "archive"]),
        review_id: z.string().optional().describe("Required for get, new_round, and archive"),
        idempotency_key: z.string().optional().describe("Stable caller-generated key required for create and new_round; reuse it when retrying"),
        title: z.string().optional().describe("Required for create and new_round"),
        purpose: z.string().optional().describe("Optional workflow purpose, such as pre-deployment, QA, design review, audit, or informational"),
        summary: z.string().optional().describe("Concise description of the work completed"),
        instructions: z.string().optional().describe("Instructions applying to the whole review"),
        approval_meaning: z.string().optional().describe("What approval authorizes or confirms, including deployment authorization when applicable"),
        linked_html_plan_id: z.string().optional().describe("Same-session HtmlPlan ID to display once for html_plan item targets"),
        items: z.array(workReviewItemSchema).optional().describe("Required non-empty list for create and new_round"),
        include_archived: z.boolean().optional().describe("Include archived reviews for list/export"),
      },
    },
    async (args) => handleWorkReviewTool(context, args as any),
  );

  server.registerTool(
    "PrivateIntegrationAuth",
    {
      title: "Private Integration Sign-In",
      description: "Open the protected SocketAgent sign-in card for an installed private integration. Use the exact integration name supplied by that integration's instructions. Never request its cookies, tokens, passwords, or MFA values in chat.",
      inputSchema: {
        integration: z.string().min(1).max(100).describe("Installed private integration name, for example outlook-auth or ibs-auth"),
      },
    },
    async ({ integration }) => handlePrivateIntegrationAuthTool(context, integration),
  );

  server.registerTool(
    "BrowserSession",
    {
      title: "Remote Browser Session",
      description: "Open and control a persistent isolated browser profile. Normal HTTP and HTTPS redirects are allowed across domains. Use snapshots and refs for non-sensitive interaction. Never type passwords, recovery codes, tokens, or MFA values with this tool; ask the user to enter them in the protected phone browser. Device-bound passkeys may require the site's alternate sign-in method. Use clear only when the user explicitly asks to delete a saved browser profile.",
      inputSchema: {
        action: z.enum(["open", "list", "status", "snapshot", "navigate", "click", "type", "key", "scroll", "close", "clear"]),
        profile: z.string().optional().describe("Stable isolated profile name, for example google-play-william"),
        url: z.string().optional().describe("HTTP or HTTPS URL for open or navigate"),
        label: z.string().optional().describe("User-facing profile label used when opening"),
        ref: z.string().optional().describe("Element ref returned by snapshot"),
        text: z.string().optional().describe("Non-sensitive text to enter. Never pass a secret here."),
        key: z.string().optional().describe("Enter, Tab, Backspace, Escape, or Ctrl+A"),
        delta_y: z.number().optional().describe("Vertical scroll distance in CSS pixels"),
      },
    },
    async (args) => handleBrowserSessionTool(context, args),
  );

  server.registerTool(
    "SearchSkills",
    {
      title: "Search Skills",
      description: "Search SocketAgent-managed Codex skills by name, description, or body. Use this when a user asks for behavior that may match a reusable skill.",
      inputSchema: {
        query: z.string().optional().describe("Search text. Leave empty to list available Codex skills."),
        limit: z.number().optional().describe("Maximum number of skills to return, 1-25"),
      },
    },
    async (args) => handleSearchSkillsTool(context, args as any),
  );

  server.registerTool(
    "ReadSkill",
    {
      title: "Read Skill",
      description: "Read a SocketAgent-managed Codex skill's SKILL.md instructions after finding it with SearchSkills.",
      inputSchema: {
        name: z.string().optional().describe("Skill name to read"),
        filePath: z.string().optional().describe("Exact skill file path returned by SearchSkills"),
      },
    },
    async (args) => handleReadSkillTool(context, args as any),
  );

  server.registerTool(
    "Speak",
    {
      title: "Speak",
      description: "Speak text aloud to the user via text-to-speech. Use this for concise spoken summaries only.",
      inputSchema: {
        text: z.string().describe("The text to speak aloud to the user"),
      },
    },
    async (args) => handleSpeakTool(context, args as { text: string }),
  );

  server.registerTool(
    "SendFile",
    {
      title: "Send File",
      description: "Send a file to the user's mobile device for download. Use this when the user asks you to send, share, or transfer a file to their phone.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to send"),
      },
    },
    async (args) => handleSendFileTool(context, args as { file_path: string }),
  );

  server.registerTool(
    "RequestSecureInput",
    {
      title: "Request Secure Input",
      description: "Ask the user to enter a credential, API key, token, or other secret through a secure app card. The secret is saved to a local 0600 file on the server, and this tool returns only the file path and metadata. Use this instead of asking the user to paste secrets into chat.",
      inputSchema: {
        label: z.string().describe("Short label for the secret, e.g. OPENAI_API_KEY or GitHub token"),
        reason: z.string().optional().describe("Why you need this secret, shown to the user"),
        envHint: z.string().optional().describe("Suggested environment variable name"),
        scope: z.enum(["session", "project", "global"]).optional().describe("Where to store it. Default: session"),
        timeoutSeconds: z.number().optional().describe("How long to wait for the user, 30-3600 seconds. Default: 600"),
      },
    },
    async (args) => handleRequestSecureInputTool(context, args as any),
  );

  server.registerTool(
    "ScheduleReminder",
    {
      title: "Schedule Reminder",
      description: "Schedule a reminder notification on the user's mobile device.",
      inputSchema: {
        title: z.string().describe("Short title for the reminder notification"),
        body: z.string().optional().describe("Optional longer description for the notification body"),
        scheduledTime: z.string().describe("When to fire the reminder, in ISO 8601 format"),
      },
    },
    async (args) => handleScheduleReminderTool(context, args as { title: string; body?: string; scheduledTime: string }),
  );

  server.registerTool(
    "NotifyUser",
    {
      title: "Notify User",
      description: "Send an immediate notification to the user's mobile device. Use this for important results, especially from quiet scheduled tasks.",
      inputSchema: {
        title: z.string().describe("Short notification title"),
        body: z.string().optional().describe("Optional notification body"),
      },
    },
    async (args) => handleNotifyUserTool(context, args as { title: string; body?: string }),
  );

  server.registerTool(
    "ScheduleTask",
    {
      title: "Schedule Task",
      description: "Schedule a Codex/Claude prompt to run automatically at a future time. Use this when the user wants to defer work until later.",
      inputSchema: {
        name: z.string().optional().describe("Short human-readable label for the task, used in task lists and notifications"),
        prompt: z.string().describe("The prompt/instructions to execute at the scheduled time"),
        cwd: z.string().describe("Working directory for the scheduled task (absolute path)"),
        backend: z.enum(["claude", "codex"]).optional().describe("Agent provider. Defaults to the current provider."),
        model: z.string().optional().describe("Provider model ID. Omit to use the provider default."),
        effort: z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional().describe("Reasoning effort for the scheduled run."),
        permissionMode: z.enum(["plan", "default", "auto", "acceptEdits", "bypassPermissions", "superYolo"]).optional().describe("Sandbox/permission mode for the scheduled run."),
        scheduledTime: z.string().describe("When to run the task, in ISO 8601 format"),
        recurrenceType: z.enum(["once", "daily", "weekly", "monthly", "custom"]).optional().describe("How often to repeat. Default: once"),
        customIntervalMs: z.number().optional().describe("Custom interval in milliseconds when recurrenceType is custom"),
        reuseSession: z.boolean().optional().describe("If true and recurring, start each occurrence in a fresh session with summaries from the two most recent runs"),
        notificationMode: z.enum(["completion", "quiet"]).optional().describe("completion sends the normal completion notification. quiet sends no automatic notifications; the scheduled agent must call NotifyUser if the user should be alerted."),
      },
    },
    async (args) => handleScheduleTaskTool(context, args as any),
  );

  server.registerTool(
    "TaskBatch",
    {
      title: "Task Batch",
      description: "Manage SocketAgent session working tasks in bulk. Use one call for two or more task changes instead of repeatedly calling single-task tools. Native Claude tasks remain untouched.",
      inputSchema: {
        mode: z.enum(["replace", "upsert", "delete", "clear_completed", "list"]).describe("replace the managed set; create/update several tasks; delete several IDs; clear completed tasks; or inspect the managed set"),
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
    },
    async (args) => handleTaskBatchTool(context, args as any),
  );

  server.registerTool(
    "ReportSubagentAssignment",
    {
      title: "Report Subagent Assignment",
      description: "Internal SocketAgent UI metadata tool. Spawned Codex subagents must call this once, before any visible response or other tool, with their canonical agent path and complete assigned prompt. Root agents must not call it.",
      inputSchema: {
        agent_path: z.string().describe("Canonical task path from the NEW_TASK envelope, for example /root/reviewer"),
        prompt: z.string().describe("The complete readable assignment from the NEW_TASK payload"),
      },
    },
    async (args) => handleReportSubagentAssignmentTool(context, args as any),
  );

  server.registerTool(
    "AgentSession",
    {
      title: "Agent Session",
      description: AGENT_SESSION_TOOL_DESCRIPTION,
      inputSchema: {
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
    },
    async (args) => handleAgentSessionTool(context, args as any),
  );

  server.registerTool(
    "Remember",
    {
      title: "Remember",
      description: REMEMBER_TOOL_DESCRIPTION,
      inputSchema: {
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
    },
    async (args) => handleRememberTool(context, args as any),
  );

  server.registerTool(
    "SessionMemory",
    {
      title: "Session Memory",
      description: SESSION_MEMORY_TOOL_DESCRIPTION,
      inputSchema: {
        action: z.enum(["list", "upsert", "delete"]),
        entry_id: z.string().optional().describe("Existing memory entry ID for update or delete"),
        kind: z.enum(["active_work", "decision", "constraint", "preference", "project_fact", "open_question"]).optional().describe("Required for upsert"),
        text: z.string().max(20000).optional().describe("Concise confirmed memory text. Required for upsert"),
        pinned: z.boolean().optional().describe("Keep this item at the top of rollover context"),
        status: z.enum(["active", "superseded"]).optional(),
        source_session_seq: z.number().int().positive().optional().describe("Optional supporting transcript sequence"),
        source_entry_id: z.string().optional().describe("Optional supporting transcript entry ID"),
      },
    },
    async (args) => handleSessionMemoryTool(context, args as any),
  );

  server.registerTool(
    "Monitor",
    {
      title: "Monitor",
      description: "Start a background shell command and monitor its output. Output is batched and delivered back into the session. For Codex, toggling is limited to Monitor-started task IDs.",
      inputSchema: {
        command: z.string().optional().describe("Shell command to run in background with monitoring enabled"),
        description: z.string().optional().describe("Human-readable description of the process"),
        timeoutSeconds: z.number().optional().describe("Auto-stop monitoring after N seconds; the process may continue"),
        taskId: z.string().optional().describe("Monitor-started task ID to stop/toggle"),
        enabled: z.boolean().optional().describe("Set false to stop monitoring a Monitor-started task"),
      },
    },
    async (args) => handleMonitorTool(context, args as any),
  );

  return server;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : undefined;
}

export function isCodexAppMcpRequest(req: IncomingMessage): boolean {
  return !!req.url?.startsWith("/codex-mcp/");
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || normalized === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export async function handleCodexAppMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    writeJson(res, 403, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "SocketAgent MCP is only available from loopback" },
      id: null,
    });
    return;
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");
  const token = decodeURIComponent(url.pathname.slice("/codex-mcp/".length));
  const registration = registrations.get(token);
  if (!registration) {
    writeJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unknown SocketAgent MCP session" },
      id: null,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: `Invalid JSON: ${err.message}` },
      id: null,
    });
    return;
  }

  const mcpSessionId = getHeaderValue(req, "mcp-session-id");
  let transport: StreamableHTTPServerTransport | undefined;

  if (mcpSessionId) {
    transport = registration.transports.get(mcpSessionId);
  } else if (isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      onsessioninitialized: (sessionId) => {
        if (transport) registration.transports.set(sessionId, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport?.sessionId;
      if (sid) registration.transports.delete(sid);
    };
    await createServer(registration.context).connect(transport);
  }

  if (!transport) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid MCP session" },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (err: any) {
    console.error(`[Codex MCP] Request failed: ${err.message}`, err.stack);
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    }
  }
}
