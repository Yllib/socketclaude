import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as crypto from "crypto";
import { execFile } from "child_process";
import * as pty from "node-pty";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";
import {
  ServerMessage,
  ActiveSubagentsServerMessage,
  QuestionItem,
  SessionInfo,
} from "./protocol";
import { saveSession, updateSessionActivity, appendHistory, saveTodos, getTodos, remapSession, markQuestionAnswered, appendSdkEvent } from "./session-store";
import { saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { SocketClaudePlugin, SessionContext } from "./plugin-api";
import { generateKokoroAudio, isKokoroAvailable } from "./kokoro-tts";

interface PendingQuestion {
  questionId: string;
  resolve: (answers: Record<string, string>) => void;
  questionData?: ServerMessage; // stored so we can re-send on reconnect
}

export class ClaudeSession {
  private sessionId: string | null = null;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private abortController: AbortController | null = null;
  private activeQuery: ReturnType<typeof query> | null = null;
  private questionCounter = 0;
  private _isRunning = false;
  private _ttsEnabled = false;
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice: string = "af_heart";
  private _kokoroSpeed: number = 1.0;
  private _effort: 'low' | 'medium' | 'high' | 'max' = 'high';
  private _thinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  private _disallowedTools: string[] = [];
  private _appendSystemPrompt: string = '';
  private _forkFromSessionId?: string;
  private _backgroundTaskToolUseIds: Set<string> = new Set();  // toolUseIds of background Task calls
  private _suppressedToolResultIds: Set<string> = new Set();  // toolUseIds whose results should be hidden from client
  private _taskIdToToolUseId: Map<string, string> = new Map();  // agentId → toolUseId mapping
  private _activeSubagents: Map<string, { toolUseId: string; description: string; subagentType: string; startedAt: string }> = new Map();
  private _activeBashStream: { interval: NodeJS.Timeout; filePath: string; lastSize: number } | null = null;
  private _activeToolUseId: string | null = null;  // currently-executing tool call
  private _activeToolName: string | null = null;
  private _readToolPaths: Map<string, string> = new Map();  // toolUseId → file_path for Read tool calls
  private _isCompacting = false;  // whether context compaction is in progress
  private _authErrorSent = false;  // suppress duplicate exit-code error after auth failure
  private _authLoginProc: pty.IPty | null = null;  // pending `claude auth login` PTY process
  private _authLocalPort: number | null = null;  // local HTTP port the auth process listens on
  private _authState: string | null = null;  // OAuth state param from the auth URL
  private _lastContextWindow = 0;  // last known context window size from modelUsage
  private _streamingText = "";  // accumulated text for the current streaming response
  private _streamingThinking = "";  // accumulated thinking for the current thinking block
  private _lastPreview: string = "";
  private _lastSessionInit: ServerMessage | null = null;
  private _lastSupportedModels: ServerMessage | null = null;
  public onActivity?: () => void;
  // When set, this fresh session replaces an old cleared session — remap the ID in the store
  public replacesSessionId?: string;
  // Queue for injecting user messages mid-conversation
  private _pendingInjections: Array<{
    text: string;
    resolve: () => void;
  }> = [];

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private plugins: SocketClaudePlugin[] = []
  ) {}

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

  setEffort(effort: 'low' | 'medium' | 'high' | 'max'): void {
    this._effort = effort;
    console.log(`Effort set to ${effort} for session ${this.sessionId || '(pending)'}`);
  }

  get effort(): string {
    return this._effort;
  }

  setThinking(thinking: typeof ClaudeSession.prototype._thinking): void {
    this._thinking = thinking;
    console.log(`Thinking set to ${JSON.stringify(thinking)} for session ${this.sessionId || '(pending)'}`);
  }

  get thinking() {
    return this._thinking;
  }

  setDisallowedTools(tools: string[]): void {
    this._disallowedTools = tools;
    console.log(`Disallowed tools set to [${tools.join(', ')}] for session ${this.sessionId || '(pending)'}`);
  }

  setAppendSystemPrompt(text: string): void {
    this._appendSystemPrompt = text;
    console.log(`Append system prompt set (${text.length} chars) for session ${this.sessionId || '(pending)'}`);
  }

  setForkSource(sessionId: string): void {
    this._forkFromSessionId = sessionId;
    console.log(`Fork source set to ${sessionId}`);
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

  getSessionId(): string | null {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  /** Active background task IDs (agentId → toolUseId) */
  get activeBackgroundTasks(): Map<string, string> {
    return this._taskIdToToolUseId;
  }

  /** Active subagent tasks with metadata */
  getActiveSubagents(): Array<{ agentId: string; toolUseId: string; description: string; subagentType: string; startedAt: string }> {
    return Array.from(this._activeSubagents.entries()).map(([toolUseId, info]) => ({
      agentId: toolUseId,  // toolUseId is the key the app knows
      toolUseId: info.toolUseId,
      description: info.description,
      subagentType: info.subagentType,
      startedAt: info.startedAt,
    }));
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
  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
    // Re-send cached session init and models so app UI populates immediately
    if (this._lastSessionInit) this.send(this._lastSessionInit);
    if (this._lastSupportedModels) this.send(this._lastSupportedModels);
    // Send any thinking accumulated during the current thinking block
    if (this._streamingThinking.length > 0) {
      this.send({
        type: "thinking",
        content: this._streamingThinking,
        sessionId: this.sessionId || "",
      });
    }
    // Send any text accumulated during the current streaming response
    if (this._streamingText.length > 0) {
      this.send({
        type: "text",
        content: this._streamingText,
        sessionId: this.sessionId || "",
      });
    }
    // Re-send any pending (unanswered) questions so the reconnecting client can respond
    for (const [, pending] of this.pendingQuestions) {
      if (pending.questionData) {
        this.send(pending.questionData);
      }
    }
    // Send active subagent tasks so the app can render SubAgentCards
    const activeSubagents = this.getActiveSubagents();
    if (activeSubagents.length > 0) {
      console.log(`[Resume] Sending ${activeSubagents.length} active subagents`);
      this.send({
        type: "active_subagents",
        tasks: activeSubagents,
        sessionId: this.sessionId || "",
      } as ActiveSubagentsServerMessage);
    }
  }

  /** Detach the WebSocket so this session stops sending to the client.
   *  The session continues running in the background (history is still logged). */
  detachWebSocket(): void {
    this.ws = { readyState: WebSocket.CLOSED, send: () => {} } as any;
  }

  public send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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
      questionCounter: { next: () => `q${++this.questionCounter}` },
    };
  }

  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingQuestions.delete(questionId);
      // Mark as answered in persisted history
      if (this.sessionId) {
        markQuestionAnswered(this.sessionId, questionId);
      }
      return true;
    }
    return false;
  }

  abort(): void {
    this.abortController?.abort();
    // close() forcefully terminates the CLI subprocess and all its children
    if (this.activeQuery) {
      try { this.activeQuery.close(); } catch {}
      this.activeQuery = null;
    }
  }

  /** Gracefully stop the current query between turns — session stays alive and can continue */
  interrupt(): void {
    if (this.activeQuery) {
      this.activeQuery.interrupt();
    }
  }

  /** Switch model mid-session. Pass undefined to reset to default. */
  async setModel(model?: string): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.setModel(model);
      console.log(`[Model] Set to ${model || 'default'} for session ${this.sessionId || '(pending)'}`);
    }
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

  /** Inject a user message into the running conversation between turns */
  async injectMessage(text: string): Promise<void> {
    if (!this.activeQuery || !this._isRunning) return;
    console.log(`[Inject] Queuing message: ${text.slice(0, 80)}...`);

    const sessionId = this.sessionId || "";

    // Log injected message to history so it persists across sessions
    if (sessionId) {
      appendHistory(sessionId, {
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      });
    }

    // Create an async iterable that yields the user message
    const userMessage = {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: text,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };

    const singleMessageStream = async function* () {
      yield userMessage;
    };

    try {
      await this.activeQuery.streamInput(singleMessageStream());
      console.log(`[Inject] Message injected successfully`);
    } catch (e) {
      console.error(`[Inject] streamInput error: ${e}`);
    }
  }

  async runQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    this.abortController = new AbortController();
    this._isRunning = true;
    this._authErrorSent = false;
    this._streamingText = "";
    this._streamingThinking = "";
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

      // Merge plugin environment variables
      for (const plugin of this.plugins) {
        if (plugin.envVars) {
          Object.assign(cleanEnv, plugin.envVars());
        }
      }

      // Build the MCP server with app-facing tools (Speak, SendFile, ScheduleReminder)
      const appTools = createSdkMcpServer({
        name: "app",
        tools: [
          tool(
            "Speak",
            "Speak text aloud to the user via text-to-speech. Use this to provide a concise spoken summary of your response. Keep it natural and conversational — no markdown, no code, no formatting. Summarize rather than reading everything verbatim. Only call this once per response. Avoid starting with a very short sentence — lead with a substantial opening sentence so audio playback begins with meaningful content.",
            { text: z.string().describe("The text to speak aloud to the user") },
            async (args) => {
              this.send({
                type: "speak",
                text: args.text,
                sessionId: this.sessionId || "",
              } as any);
              // If server-side Kokoro TTS is active, generate and send audio
              if (this._ttsEngine === "kokoro_server") {
                try {
                  const wavBuffer = generateKokoroAudio(args.text, this._kokoroVoice, this._kokoroSpeed);
                  if (wavBuffer) {
                    this.send({
                      type: "tts_audio",
                      audioData: wavBuffer.toString("base64"),
                      text: args.text,
                      sessionId: this.sessionId || "",
                    } as any);
                  }
                } catch (e) {
                  console.error(`[KokoroTTS] Error generating audio:`, e);
                }
              }
              return { content: [{ type: "text" as const, text: "Speaking to user." }] };
            }
          ),
          tool(
            "SendFile",
            "Send a file to the user's mobile device for download. Registers the file so the user can download it on-demand from the app. Use this when the user asks you to send, share, or transfer a file to their phone.",
            {
              file_path: z.string().describe("Absolute path to the file to send"),
            },
            async (args) => {
              const filePath = args.file_path;
              if (!fs.existsSync(filePath)) {
                return { content: [{ type: "text" as const, text: `File not found: ${filePath}` }] };
              }
              const stat = fs.statSync(filePath);
              const fileName = path.basename(filePath);
              const fileId = crypto.createHash("md5").update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest("hex").slice(0, 12);
              // Send metadata only — file data transferred on-demand when user taps download
              this.send({
                type: "file",
                fileId,
                fileName,
                filePath,
                fileSize: stat.size,
                sessionId: this.sessionId || "",
              } as any);
              const sizeStr = stat.size > 1024 * 1024
                ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
                : `${(stat.size / 1024).toFixed(1)} KB`;
              return { content: [{ type: "text" as const, text: `File ready for download: ${fileName} (${sizeStr})` }] };
            }
          ),
          tool(
            "ScheduleReminder",
            "Schedule a reminder notification on the user's mobile device. The notification will fire at the specified time even if the app is backgrounded. Use this when the user asks to be reminded about something at a specific time.",
            {
              title: z.string().describe("Short title for the reminder notification"),
              body: z.string().describe("Optional longer description for the notification body. Use empty string if not needed."),
              scheduledTime: z.string().describe("When to fire the reminder, in ISO 8601 format (e.g. 2026-02-18T15:30:00)"),
            },
            async (args) => {
              const scheduledDate = new Date(args.scheduledTime);
              if (isNaN(scheduledDate.getTime())) {
                return { content: [{ type: "text" as const, text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
              }
              if (scheduledDate.getTime() <= Date.now()) {
                return { content: [{ type: "text" as const, text: `Scheduled time is in the past. Please provide a future time.` }] };
              }

              const hash = crypto.createHash("md5").update(`${args.title}:${args.scheduledTime}`).digest();
              const notificationId = Math.abs(hash.readInt32BE(0));

              this.send({
                type: "reminder",
                title: args.title,
                body: args.body || "",
                scheduledTime: args.scheduledTime,
                notificationId,
                sessionId: this.sessionId || "",
              } as any);

              const when = scheduledDate.toLocaleString();
              return { content: [{ type: "text" as const, text: `Reminder scheduled: "${args.title}" at ${when}` }] };
            }
          ),
          tool(
            "ScheduleTask",
            "Schedule a Claude prompt to run automatically at a future time. Creates a new session in the specified directory and executes the prompt when the scheduled time arrives. The server runs 24/7 so the task will execute even if the app is closed. Use this when the user wants to defer a task to run later. Supports recurring schedules (daily, weekly, monthly, or custom interval) and optionally reusing the same session across recurrences.",
            {
              prompt: z.string().describe("The prompt/instructions for Claude to execute at the scheduled time"),
              cwd: z.string().describe("Working directory for the scheduled task (absolute path)"),
              scheduledTime: z.string().describe("When to run the task, in ISO 8601 format (e.g. 2026-03-13T09:00:00)"),
              recurrenceType: z.enum(["once", "daily", "weekly", "monthly", "custom"]).optional().describe("How often to repeat. Default: once (no recurrence)"),
              customIntervalMs: z.number().optional().describe("Custom interval in milliseconds (only used when recurrenceType is 'custom')"),
              reuseSession: z.boolean().optional().describe("If true and recurring, reuse the same session for all occurrences instead of creating new ones"),
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

              const task: ScheduledTask = {
                id: crypto.randomUUID(),
                prompt: args.prompt,
                cwd: args.cwd,
                scheduledTime: args.scheduledTime,
                createdAt: new Date().toISOString(),
                status: "pending",
                createdBySessionId: this.sessionId || undefined,
                recurrence,
                reuseSession: args.reuseSession || false,
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
              return { content: [{ type: "text" as const, text: `Task scheduled for ${when}${recurrenceLabel} in ${args.cwd}:\n"${args.prompt.slice(0, 300)}"` }] };
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

      const toolContext = `You are a general-purpose personal assistant. You can schedule reminders for the user using the ScheduleReminder tool — use ISO 8601 datetime for the scheduledTime parameter. You can also schedule deferred tasks using the ScheduleTask tool — these create a new Claude session that runs automatically at the specified time. Supports recurring schedules (daily, weekly, monthly, or custom interval) and optionally reusing the same session across recurrences.${ttsInstruction}${pluginContext}`;

      // Handle fork: use fork source as resume target + set forkSession flag
      const shouldFork = !!this._forkFromSessionId;
      const forkSourceId = this._forkFromSessionId;
      this._forkFromSessionId = undefined;

      const resumeTarget = shouldFork
        ? forkSourceId
        : (resumeSessionId || this.sessionId || undefined);

      console.log(`Starting query: resume=${resumeTarget || 'none'}${shouldFork ? ' (FORK)' : ''}, effort=${this._effort}, thinking=${JSON.stringify(this._thinking)}, prompt=${prompt.slice(0, 80)}..., cwd=${this.cwd}`);

      const q = this.activeQuery = query({
        prompt: prompt,
        options: {
          cwd: this.cwd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          resume: resumeTarget,
          forkSession: shouldFork || undefined,
          abortController: this.abortController,
          effort: this._effort as any,
          thinking: this._thinking as any,
          systemPrompt: { type: "preset", preset: "claude_code", append: this._appendSystemPrompt ? toolContext + '\n\n' + this._appendSystemPrompt : toolContext } as any,
          tools: { type: "preset", preset: "claude_code" },
          ...(this._disallowedTools.length ? { disallowedTools: this._disallowedTools } : {}),
          enableFileCheckpointing: true,
          settingSources: ["user", "project"],
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
                for (const plugin of this.plugins) {
                  if (plugin.canUseToolInterceptor) {
                    const result = await plugin.canUseToolInterceptor(toolName, toolInput, sessionCtx);
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

                // Wrap Bash commands with tee for live streaming output
                if (toolName === "Bash" && toolInput.command) {
                  const outFile = "/tmp/claude-bash-live.log";
                  try { fs.writeFileSync(outFile, ""); } catch {}
                  const wrapped = `set -o pipefail; (${toolInput.command}) 2>&1 | stdbuf -oL tee ${outFile}`;
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                      updatedInput: { command: wrapped },
                    },
                  };
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
            SubagentStart: [{
              hooks: [async (input: any) => {
                const agentId = input.agent_id || "";
                const agentType = input.agent_type || "";
                console.log(`[Hook] SubagentStart: agentId=${agentId} type=${agentType}`);
                return { continue: true };
              }],
            }],
            SubagentStop: [{
              hooks: [async (input: any) => {
                const agentId = input.agent_id || "";
                const agentType = input.agent_type || "";
                console.log(`[Hook] SubagentStop: agentId=${agentId} type=${agentType}`);
                return { continue: true };
              }],
            }],
          },
          stderr: (data: string) => {
            const trimmed = data.trimEnd();
            if (trimmed) {
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

            // Run plugin interceptors first
            const sessionCtx = this.getSessionContext();
            for (const plugin of this.plugins) {
              if (plugin.canUseToolInterceptor) {
                const result = await plugin.canUseToolInterceptor(toolName, input as any, sessionCtx);
                if (result !== null) return result;
              }
            }

            if (toolName === "AskUserQuestion") {
              const qId = `q${++this.questionCounter}`;
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
              // Find the most recent plan file
              const homeDir = process.env.HOME || require("os").homedir();
              const plansDir = path.join(homeDir, ".claude", "plans");
              let planContent = "";
              try {
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
              } catch (e) {
                console.error(`[Plan] Error reading plan file: ${e}`);
              }

              const qId = `q${++this.questionCounter}`;
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
                return { behavior: "allow" as const, updatedInput: input };
              } else {
                return { behavior: "deny" as const, message: "User rejected the plan." };
              }
            }

            return { behavior: "allow" as const, updatedInput: input };
          },
        },
      });

      let currentText = "";
      let lastResultContent = "";
      const now = () => new Date().toISOString();

      // SDK event persistence: coalesce content block deltas
      let sdkBlockText = "";
      let sdkBlockIndex: number | null = null;
      let sdkBlockType: string | null = null;
      let sdkBlockToolName: string | null = null;
      let sdkBlockToolUseId: string | null = null;
      let sdkBlockDeltaCount = 0;

      // Track per-turn usage from stream events to get current context size
      let lastTurnInputTokens = 0;
      let lastTurnOutputTokens = 0;
      let lastTurnCacheReadTokens = 0;
      let lastTurnCacheCreateTokens = 0;

      // Log the user prompt to history (for resumed sessions we already have the ID)
      let promptLogged = false;
      if (this.sessionId || resumeSessionId) {
        const sid = this.sessionId || resumeSessionId || "";
        appendHistory(sid, {
          role: "user",
          content: prompt,
          timestamp: now(),
        });
        promptLogged = true;
      }

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
              if (evtType === "content_block_start") {
                sdkBlockText = "";
                sdkBlockDeltaCount = 0;
                sdkBlockIndex = evt.index ?? null;
                const cb = evt.content_block || {};
                sdkBlockType = cb.type || null;
                sdkBlockToolName = cb.name || null;
                sdkBlockToolUseId = cb.id || null;
              } else if (evtType === "content_block_delta") {
                const delta = evt.delta || {};
                if (delta.type === "text_delta") sdkBlockText += delta.text || "";
                else if (delta.type === "input_json_delta") sdkBlockText += delta.partial_json || "";
                else if (delta.type === "thinking_delta") sdkBlockText += delta.thinking || "";
                sdkBlockDeltaCount++;
              } else if (evtType === "content_block_stop") {
                // Write coalesced content block entry
                appendSdkEvent(sid, {
                  ts: now(),
                  sdkType: "content_block",
                  blockIndex: sdkBlockIndex,
                  blockType: sdkBlockType,
                  toolName: sdkBlockToolName,
                  toolUseId: sdkBlockToolUseId,
                  text: sdkBlockText,
                  deltaCount: sdkBlockDeltaCount,
                });
                // Persist thinking blocks to chat history
                if (sdkBlockType === "thinking" && sdkBlockText.length > 0) {
                  appendHistory(sid, {
                    role: "assistant",
                    content: sdkBlockText,
                    thinking: true,
                    uuid: (message as any).uuid || undefined,
                    timestamp: now(),
                  });
                }
                sdkBlockText = "";
                sdkBlockDeltaCount = 0;
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
          this.send(sdkPayload as any);
        } catch (_) {}

        if (message.type === "system" && (message as any).subtype === "init") {
          this.sessionId = message.session_id;
          this.send({
            type: "session_created",
            sessionId: message.session_id,
            cwd: this.cwd,
          });

          if (this.replacesSessionId) {
            // Context was cleared — remap old session ID to this new one
            remapSession(this.replacesSessionId, message.session_id);
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
            };
            saveSession(sessionInfo);
          }

          // Forward init data to app (available agents, tools, MCP servers, model, etc.)
          const initMsg = message as any;
          this._lastSessionInit = {
            type: "session_init",
            agents: initMsg.agents || undefined,
            tools: initMsg.tools || undefined,
            mcpServers: initMsg.mcp_servers || undefined,
            model: initMsg.model || undefined,
            claudeCodeVersion: initMsg.claude_code_version || undefined,
            permissionMode: initMsg.permissionMode || undefined,
            sessionId: this.sessionId || "",
          } as any;
          this.send(this._lastSessionInit!);

          // Query available models and forward to app for model picker
          if (this.activeQuery) {
            this.activeQuery.supportedModels().then((models: any) => {
              if (models) {
                this._lastSupportedModels = {
                  type: "supported_models",
                  models,
                  sessionId: this.sessionId || "",
                } as any;
                this.send(this._lastSupportedModels!);
              }
            }).catch((e: any) => {
              console.error(`[Init] Failed to get supported models: ${e}`);
            });
          }

          // Log user prompt now that we have the session ID (for new sessions)
          if (!promptLogged) {
            appendHistory(message.session_id, {
              role: "user",
              content: prompt,
              timestamp: now(),
            });
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
          } as any);
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
          console.log(`[SDK] Status change: ${status}`);
          this._isCompacting = status === "compacting";
          this.send({
            type: "compacting",
            active: this._isCompacting,
            sessionId: this.sessionId || "",
          } as any);
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
          const originToolUseId = this._taskIdToToolUseId.get(sdkTaskId) || undefined;
          console.log(`[SDK] Task notification: id=${sdkTaskId} status=${tn.status} originToolUseId=${originToolUseId} summary=${tn.summary?.slice(0, 80)}`);
          if (originToolUseId) this._taskIdToToolUseId.delete(sdkTaskId);
          this.send({
            type: "task_notification",
            taskId: sdkTaskId,
            status: tn.status || "completed",
            outputFile: tn.output_file || undefined,
            summary: tn.summary || "",
            originToolUseId,
            sessionId: this.sessionId || "",
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: `[Task ${tn.status}] ${tn.summary || ''}`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Handle tool use summaries — clean human-readable summaries of tool groups
        if (message.type === "tool_use_summary") {
          const summary = message as any;
          console.log(`[SDK] Tool use summary: ${summary.summary?.slice(0, 100)}`);
          this.send({
            type: "tool_summary",
            summary: summary.summary || "",
            precedingToolUseIds: summary.preceding_tool_use_ids || [],
            sessionId: this.sessionId || "",
            uuid: summary.uuid || undefined,
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: summary.summary || "",
              toolSummary: true,
              precedingToolUseIds: summary.preceding_tool_use_ids || [],
              uuid: summary.uuid || undefined,
              timestamp: now(),
            });
          }
        }

        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            currentText += event.delta.text;
            this._streamingText += event.delta.text;
            this._streamingThinking = "";  // thinking block ended
            this.send({
              type: "text",
              content: event.delta.text,
              sessionId: this.sessionId || "",
              parentToolUseId: (message as any).parent_tool_use_id || null,
              uuid: (message as any).uuid || undefined,
            });
          }

          // Stream thinking deltas to client
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            this._streamingThinking += event.delta.thinking || "";
            this.send({
              type: "thinking",
              content: event.delta.thinking || "",
              sessionId: this.sessionId || "",
              parentToolUseId: (message as any).parent_tool_use_id || null,
              uuid: (message as any).uuid || undefined,
            });
          }

          // Track per-turn usage from message_start (input tokens for this turn)
          if (event?.type === "message_start" && event.message?.usage) {
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
          if (event?.type === "message_delta" && event.usage) {
            lastTurnOutputTokens = event.usage.output_tokens || 0;
            console.log(`[Usage] message_delta: output=${lastTurnOutputTokens}`);
          }
        }

        if (message.type === "assistant") {
          // Surface per-message error types (rate_limit, auth_failed, billing_error, etc.)
          const assistantError = (message as any).error;
          if (assistantError) {
            console.error(`[SDK] Assistant error: ${assistantError}`);
            if (/auth/i.test(assistantError)) {
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

          // Reset streaming text/thinking — this assistant turn is complete
          this._streamingText = "";
          this._streamingThinking = "";
          // Log the full assistant text once the message is complete
          // Skip persisting the raw error text when auth login is being handled
          const apiMessage = (message as any).message;
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            // Extract full text from assistant message
            const textParts = apiMessage.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text);
            if (textParts.length > 0) {
              this._lastPreview = textParts.join("").slice(0, 200);
              this.onActivity?.();
              if (this.sessionId && !this._authErrorSent) {
                appendHistory(this.sessionId, {
                  role: "assistant",
                  content: textParts.join(""),
                  parentToolUseId: (message as any).parent_tool_use_id || null,
                  uuid: (message as any).uuid || undefined,
                  timestamp: now(),
                });
              }
            }

            for (const block of apiMessage.content) {
              if (block.type === "tool_use") {
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
                    const changed = todos.length !== prev.length ||
                      todos.some((t: any, i: number) =>
                        t.content !== prev[i]?.content || t.status !== prev[i]?.status);
                    if (this.sessionId) {
                      saveTodos(this.sessionId, todos);
                    }
                    if (changed) {
                      this.send({
                        type: "todos",
                        todos,
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

                // Start watching for bash streaming output (tee'd by PreToolUse hook)
                if (block.name === "Bash") {
                  this._startBashWatcher("/tmp/claude-bash-live.log");
                }

                // Track all Task (subagent) tool calls
                if (block.name === "Task") {
                  const desc = (block.input as any)?.description || "Task";
                  const subagentType = (block.input as any)?.subagent_type || "";
                  this._activeSubagents.set(block.id, {
                    toolUseId: block.id,
                    description: desc,
                    subagentType,
                    startedAt: now(),
                  });
                  console.log(`[SDK] Subagent started: ${desc} (toolUseId=${block.id}, type=${subagentType})`);

                  // Background task notification
                  if ((block.input as any)?.run_in_background) {
                    console.log(`[SDK] Background task launched: ${desc} (toolUseId=${block.id})`);
                    this._backgroundTaskToolUseIds.add(block.id);
                    this.send({
                      type: "task_notification",
                      taskId: block.id,
                      status: "started",
                      summary: desc,
                      sessionId: this.sessionId || "",
                    } as any);
                  }
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
          const userMsgUuid = (message as any).uuid || undefined;
          if (userMsgUuid) {
            this.send({
              type: "user_message_uuid",
              uuid: userMsgUuid,
              sessionId: this.sessionId || "",
            } as any);
            // Persist UUID linkage so history loader can restore it
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "user_uuid",
                content: userMsgUuid,
                timestamp: now(),
              });
            }
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

                const output =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n")
                      : JSON.stringify(block.content);

                // Extract image blocks from tool results (e.g., Read on image files)
                if (Array.isArray(block.content)) {
                  for (const c of block.content as any[]) {
                    if (c.type === "image" && c.source?.type === "base64") {
                      const filePath = this._readToolPaths.get(toolUseId) || "";
                      console.log(`[SDK] Image block found in tool result: ${filePath || toolUseId}`);
                      this.send({
                        type: "tool_image",
                        toolUseId,
                        imageData: c.source.data,
                        mimeType: c.source.media_type || "image/png",
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
                          mimeType: c.source.media_type || "image/png",
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
                  const bgTaskId = bgMatch[1];
                  const outputFile = bgMatch[2];
                  console.log(`[SDK] Bash moved to background: taskId=${bgTaskId}, outputFile=${outputFile}, toolUseId=${toolUseId}`);

                  // Stop watching the tee file and switch to the SDK's output file
                  this._stopBashWatcher();
                  this._startBashWatcher(outputFile);

                  // Send a background notification so the app tracks it
                  this.send({
                    type: "bash_backgrounded",
                    toolUseId,
                    taskId: bgTaskId,
                    outputFile,
                    sessionId: this.sessionId || "",
                  } as any);

                  // Track for stopTask
                  this._taskIdToToolUseId.set(bgTaskId, toolUseId);

                  // Don't replace card content — just send the tool_result normally
                  // but the app will handle it specially
                } else {
                  // Stop bash output watcher — tool finished normally
                  this._stopBashWatcher();
                }

                // Remove completed subagent from active tracking
                if (this._activeSubagents.has(toolUseId)) {
                  const info = this._activeSubagents.get(toolUseId)!;
                  console.log(`[SDK] Subagent completed: ${info.description} (toolUseId=${toolUseId})`);
                  this._activeSubagents.delete(toolUseId);
                }

                // Track background task agentId → toolUseId mapping
                if (this._backgroundTaskToolUseIds.has(toolUseId)) {
                  this._backgroundTaskToolUseIds.delete(toolUseId);
                  const agentIdMatch = output.match(/agentId:\s*(\S+)/);
                  if (agentIdMatch) {
                    const agentId = agentIdMatch[1];
                    this._taskIdToToolUseId.set(agentId, toolUseId);
                    console.log(`[SDK] Background task mapping: agentId=${agentId} → toolUseId=${toolUseId}`);
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
                    sessionId: this.sessionId || "",
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                  });
                }
                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_result",
                    content: "",
                    toolUseId: block.tool_use_id || "",
                    toolOutput: output,
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                    timestamp: now(),
                  });
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
              sessionId: this.sessionId || "",
            } as any);
            continue;
          }
          lastResultContent =
            result.result || currentText || "Task completed.";

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

          this.send({
            type: "result",
            content: lastResultContent,
            sessionId: this.sessionId || "",
            costUsd: result.total_cost_usd,
            durationMs: result.duration_ms,
            durationApiMs: result.duration_api_ms || undefined,
            usage: usageInfo,
            numTurns: result.num_turns,
            stopReason: result.stop_reason || undefined,
            resultSubtype: result.subtype || undefined,
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
          this.onActivity?.();
          currentText = "";
        }
      }
    } catch (err: any) {
      const errMsg = err.message || "Unknown error during query";
      console.error("Query error:", errMsg);
      if (err.stack) console.error(err.stack);

      // Skip if we already sent a login URL for this auth failure
      if (!this._authErrorSent) {
        this.send({
          type: "error",
          message: errMsg,
        });
      }
    } finally {
      this._isRunning = false;
      this.activeQuery = null;
    }
  }

  /** Spawn `claude auth login` in a PTY, keep it alive, and return the OAuth URL. */
  private _startAuthLogin(): Promise<string | null> {
    // Kill any previous auth process
    if (this._authLoginProc) {
      try { this._authLoginProc.kill(); } catch {}
      this._authLoginProc = null;
    }
    this._authLocalPort = null;
    this._authState = null;
    return new Promise((resolve) => {
      const claudePath = path.join(process.env.HOME || "", ".local", "bin", "claude");
      const proc = pty.spawn(claudePath, ["auth", "login"], {
        name: "xterm",
        cols: 120,
        rows: 30,
        env: { ...process.env, BROWSER: "echo" } as Record<string, string>,
      });
      this._authLoginProc = proc;
      let output = "";
      let resolved = false;
      proc.onData((data: string) => {
        output += data;
        console.log(`[Auth] PTY output: ${data.trim()}`);
        if (!resolved) {
          const match = output.match(/https:\/\/claude\.ai\/oauth\/authorize\S+/);
          if (match) {
            resolved = true;
            // Extract state param from the auth URL
            const stateMatch = match[0].match(/state=([^&\s]+)/);
            this._authState = stateMatch ? stateMatch[1] : null;
            console.log(`[Auth] Extracted state: ${this._authState?.substring(0, 20)}...`);
            // Find the local port the CLI opened, then resolve
            this._findAuthPort(proc.pid).then((port) => {
              this._authLocalPort = port;
              console.log(`[Auth] Found local callback port: ${port}`);
              resolve(match[0]);
            });
          }
        }
      });
      proc.onExit(({ exitCode }) => {
        console.log(`[Auth] claude auth login exited with code ${exitCode}`);
        this._authLoginProc = null;
        this._authLocalPort = null;
        if (!resolved) resolve(null);
        const success = exitCode === 0;
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
      });
      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._authLoginProc === proc) {
          console.log("[Auth] Login process timed out");
          try { proc.kill(); } catch {}
          this._authLoginProc = null;
          this._authLocalPort = null;
          if (!resolved) resolve(null);
        }
      }, 300000);
    });
  }

  /** Find the local HTTP port that the `claude auth login` process listens on. */
  private _findAuthPort(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
      const { execFile: execF } = require("child_process");
      execF("ss", ["-tlnp"], { timeout: 5000 }, (err: any, stdout: string) => {
        if (err) { resolve(null); return; }
        // Find line with our PID
        for (const line of stdout.split("\n")) {
          if (line.includes(`pid=${pid},`)) {
            const portMatch = line.match(/:(\d+)\s/);
            if (portMatch) { resolve(parseInt(portMatch[1], 10)); return; }
          }
        }
        resolve(null);
      });
    });
  }

  /** Submit the OAuth callback code+state to the pending `claude auth login` local server. */
  submitAuthCode(code: string): void {
    if (!this._authLoginProc || !this._authLocalPort) {
      console.error("[Auth] No pending auth login process or port");
      this.send({
        type: "error",
        message: "No pending login session. Try sending a message to trigger auth again.",
      });
      return;
    }
    // If code contains '&' it's already a full query string (code=...&state=...)
    // Otherwise it's just the code, and we use the stored state
    let queryString: string;
    if (code.includes("=")) {
      queryString = code;
    } else {
      queryString = `code=${encodeURIComponent(code)}&state=${encodeURIComponent(this._authState || "")}`;
    }
    console.log(`[Auth] Hitting localhost:${this._authLocalPort}/callback?${queryString.substring(0, 80)}...`);
    const http = require("http");
    const callbackUrl = `http://127.0.0.1:${this._authLocalPort}/callback?${queryString}`;
    http.get(callbackUrl, (res: any) => {
      let body = "";
      res.on("data", (d: string) => { body += d; });
      res.on("end", () => {
        console.log(`[Auth] Callback response (${res.statusCode}): ${body.substring(0, 200)}`);
      });
    }).on("error", (e: any) => {
      console.error(`[Auth] Callback error: ${e.message}`);
      this.send({ type: "error", message: `Auth callback failed: ${e.message}` });
    });
  }
}
