import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";
import {
  ServerMessage,
  QuestionItem,
  SessionInfo,
} from "./protocol";
import { saveSession, updateSessionActivity, appendHistory, saveTodos, remapSession, markQuestionAnswered } from "./session-store";
import { SocketClaudePlugin, SessionContext } from "./plugin-api";

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
  private _effort: 'low' | 'medium' | 'high' | 'max' = 'high';
  private _thinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  private _forkFromSessionId?: string;
  private _backgroundTaskToolUseIds: Set<string> = new Set();  // toolUseIds of background Task calls
  private _taskIdToToolUseId: Map<string, string> = new Map();  // agentId → toolUseId mapping
  private _activeBashStream: { interval: NodeJS.Timeout; filePath: string; lastSize: number } | null = null;
  private _streamingText = "";  // accumulated text for the current streaming response
  private _lastPreview: string = "";
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

  get lastPreview(): string {
    return this._lastPreview;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Swap the WebSocket so a reconnecting client receives future messages */
  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
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
    return {
      sessionId: this.sessionId || "",
      cwd: this.cwd,
      send: (msg) => this.send(msg as ServerMessage),
      pendingQuestions: this.pendingQuestions,
      questionCounter: { next: () => `q${++this.questionCounter}` },
    };
  }

  resolveQuestion(questionId: string, answers: Record<string, string>): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingQuestions.delete(questionId);
      // Mark as answered in persisted history
      if (this.sessionId) {
        markQuestionAnswered(this.sessionId, questionId);
      }
    }
  }

  abort(): void {
    this.abortController?.abort();
    // close() forcefully terminates the CLI subprocess and all its children
    if (this.activeQuery) {
      try { this.activeQuery.close(); } catch {}
      this.activeQuery = null;
    }
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
    this._streamingText = "";
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

      // Merge plugin environment variables
      for (const plugin of this.plugins) {
        if (plugin.envVars) {
          Object.assign(cleanEnv, plugin.envVars());
        }
      }

      // Build the MCP server with Speak and SendFile tools
      const assistantTools = createSdkMcpServer({
        name: "tts-tools",
        tools: [
          tool(
            "Speak",
            "Speak text aloud to the user via text-to-speech. Use this to provide a concise spoken summary of your response. Keep it natural and conversational — no markdown, no code, no formatting. Summarize rather than reading everything verbatim. Only call this once per response.",
            { text: z.string().describe("The text to speak aloud to the user") },
            async (args) => {
              this.send({
                type: "speak",
                text: args.text,
                sessionId: this.sessionId || "",
              } as any);
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
        ],
      });

      const reminderTools = createSdkMcpServer({
        name: "reminder-tools",
        tools: [
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

      const toolContext = `You are a general-purpose personal assistant. You can schedule reminders for the user using the ScheduleReminder tool — use ISO 8601 datetime for the scheduledTime parameter.${ttsInstruction}${pluginContext}

User request: `;

      const enrichedPrompt = (!resumeSessionId && !this.sessionId)
        ? toolContext + prompt
        : prompt;

      // Handle fork: use fork source as resume target + set forkSession flag
      const shouldFork = !!this._forkFromSessionId;
      const forkSourceId = this._forkFromSessionId;
      this._forkFromSessionId = undefined;

      const resumeTarget = shouldFork
        ? forkSourceId
        : (resumeSessionId || this.sessionId || undefined);

      console.log(`Starting query: resume=${resumeTarget || 'none'}${shouldFork ? ' (FORK)' : ''}, effort=${this._effort}, thinking=${JSON.stringify(this._thinking)}, prompt=${enrichedPrompt.slice(0, 80)}..., cwd=${this.cwd}`);

      const q = this.activeQuery = query({
        prompt: enrichedPrompt,
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
          systemPrompt: { type: "preset", preset: "claude_code" },
          tools: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project"],
          mcpServers: (() => {
            const servers: Record<string, any> = { "tts-tools": assistantTools, "reminder-tools": reminderTools };
            for (const plugin of this.plugins) {
              if (plugin.mcpServers) Object.assign(servers, plugin.mcpServers());
            }
            return servers;
          })(),
          allowedTools: (() => {
            const tools = ["mcp__tts-tools__*", "mcp__reminder-tools__*"];
            for (const plugin of this.plugins) {
              if (plugin.allowedTools) tools.push(...plugin.allowedTools());
            }
            return tools;
          })(),
          env: cleanEnv,
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
          canUseTool: async (toolName, input) => {
            console.log(`canUseTool called: ${toolName}`);

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
              };
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
          } as any);
        }

        // Detect context compaction status changes
        if (message.type === "system" && (message as any).subtype === "status") {
          const status = (message as any).status as string | null;
          console.log(`[SDK] Status change: ${status}`);
          this.send({
            type: "compacting",
            active: status === "compacting",
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

        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            currentText += event.delta.text;
            this._streamingText += event.delta.text;
            this.send({
              type: "text",
              content: event.delta.text,
              sessionId: this.sessionId || "",
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
          }

          // Track output tokens from message_delta (end of turn)
          if (event?.type === "message_delta" && event.usage) {
            lastTurnOutputTokens = event.usage.output_tokens || 0;
            console.log(`[Usage] message_delta: output=${lastTurnOutputTokens}`);
          }
        }

        if (message.type === "assistant") {
          // Reset streaming text — this assistant turn is complete
          this._streamingText = "";
          // Log the full assistant text once the message is complete
          const apiMessage = (message as any).message;
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            // Extract full text from assistant message
            const textParts = apiMessage.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text);
            if (textParts.length > 0) {
              this._lastPreview = textParts.join("").slice(0, 200);
              this.onActivity?.();
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "assistant",
                  content: textParts.join(""),
                  timestamp: now(),
                });
              }
            }

            for (const block of apiMessage.content) {
              if (block.type === "tool_use") {
                // Don't send AskUserQuestion as a tool_call — it's handled
                // via canUseTool and rendered as a proper question card
                if (block.name === "AskUserQuestion") continue;

                // Intercept TodoWrite — track todos server-side and push to client
                if (block.name === "TodoWrite") {
                  const todos = (block.input as any)?.todos;
                  if (Array.isArray(todos)) {
                    if (this.sessionId) {
                      saveTodos(this.sessionId, todos);
                    }
                    this.send({
                      type: "todos",
                      todos,
                      sessionId: this.sessionId || "",
                    } as any);
                  }
                  continue;
                }

                // Send MCP tool calls (Speak, SendFile, ScheduleReminder) for UI display
                const mcpName = block.name.replace("mcp__tts-tools__", "").replace("mcp__reminder-tools__", "");
                if (mcpName === "Speak" || mcpName === "SendFile" || mcpName === "ScheduleReminder") {
                  this.send({
                    type: "tool_call",
                    tool: mcpName,
                    input: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    sessionId: this.sessionId || "",
                  });
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "tool_call",
                      content: "",
                      toolName: mcpName,
                      toolInput: block.input as Record<string, unknown>,
                      toolUseId: block.id,
                      timestamp: now(),
                    });
                  }
                  continue;
                }

                this.send({
                  type: "tool_call",
                  tool: block.name,
                  input: block.input as Record<string, unknown>,
                  toolUseId: block.id,
                  sessionId: this.sessionId || "",
                });

                // Start watching for bash streaming output (tee'd by PreToolUse hook)
                if (block.name === "Bash") {
                  this._startBashWatcher("/tmp/claude-bash-live.log");
                }

                // Detect background task launches and send a start notification
                if (block.name === "Task" && (block.input as any)?.run_in_background) {
                  const desc = (block.input as any)?.description || "Background task";
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

                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_call",
                    content: "",
                    toolName: block.name,
                    toolInput: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    timestamp: now(),
                  });
                }
              }
            }
          }
        }

        if (message.type === "user") {
          const apiMessage = (message as any).message;
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              if (block.type === "tool_result") {
                const output =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n")
                      : JSON.stringify(block.content);

                const toolUseId = block.tool_use_id || "";

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

                // Stream large tool output in chunks for progressive rendering
                const CHUNK_THRESHOLD = 500; // Only chunk if output > 500 chars
                const CHUNK_SIZE = 200; // ~200 chars per chunk (roughly 3-4 lines)
                if (output.length > CHUNK_THRESHOLD) {
                  let chunkIdx = 0;
                  for (let i = 0; i < output.length; i += CHUNK_SIZE) {
                    this.send({
                      type: "tool_result_chunk",
                      toolUseId,
                      chunkIndex: chunkIdx++,
                      content: output.slice(i, i + CHUNK_SIZE),
                      done: i + CHUNK_SIZE >= output.length,
                      sessionId: this.sessionId || "",
                    } as any);
                  }
                } else {
                  this.send({
                    type: "tool_result",
                    toolUseId,
                    output,
                    sessionId: this.sessionId || "",
                  });
                }
                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_result",
                    content: "",
                    toolUseId: block.tool_use_id || "",
                    toolOutput: output,
                    timestamp: now(),
                  });
                }
              }
            }
          }
        }

        if (message.type === "result") {
          const result = message as any;
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
            usage: usageInfo,
            numTurns: result.num_turns,
            stopReason: result.stop_reason || undefined,
            resultSubtype: result.subtype || undefined,
            errors: result.errors?.length ? result.errors : undefined,
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
      this.send({
        type: "error",
        message: errMsg,
      });
    } finally {
      this._isRunning = false;
      this.activeQuery = null;
    }
  }
}
