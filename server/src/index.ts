import * as dotenv from "dotenv";
dotenv.config({ path: require("path").join(__dirname, "..", ".env") });

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { ClaudeSession } from "./claude-session";
import { listSessions, getSession, saveSession, getHistory, getHistoryPage, getHistoryPageToLastPrompt, deleteSession, clearSessionContext, cleanupPendingToolCalls, getTodos, getMissedMessages, appendHistory, getSdkEvents, markQuestionAnswered, getLastHistoryTimestamp, listSdkSessions } from "./session-store";
import { listScheduledTasks, getScheduledTask, saveScheduledTask, deleteScheduledTask, getDueTasks, getNextRunTime, getScheduledTaskSessionIds, ScheduledTask } from "./scheduled-task-store";
import { DesktopCliWatcher } from "./desktop-cli-watcher";
import { ClientMessage, SessionInfo } from "./protocol";
import { SocketClaudePlugin, PluginContext } from "./plugin-api";
import { RelayClient, RelayStatus } from "./relay-client";
import { loadOrCreateKeyPair, toBase64 } from "./relay-crypto";

const PORT = parseInt(process.env.PORT || "8085", 10);
const DEFAULT_CWD = process.env.DEFAULT_CWD || process.cwd();
const RELAY_URL = process.env.RELAY_URL || "";

// Auth token — read from .env or generate and persist one
let AUTH_TOKEN = process.env.AUTH_TOKEN || "";
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(32).toString("hex");
  const envPath = path.join(__dirname, "..", ".env");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";
  fs.writeFileSync(envPath, existing.trimEnd() + `\nAUTH_TOKEN=${AUTH_TOKEN}\n`);
  console.log(`Generated new auth token. Add this to your app settings:`);
  console.log(`  Token: ${AUTH_TOKEN}`);
} else {
  console.log(`Auth token loaded from .env`);
}

// Pairing token for relay — read from .env or generate and persist one
let PAIRING_TOKEN = process.env.PAIRING_TOKEN || "";
if (RELAY_URL && !PAIRING_TOKEN) {
  PAIRING_TOKEN = crypto.randomUUID();
  const envPath = path.join(__dirname, "..", ".env");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";
  fs.writeFileSync(envPath, existing.trimEnd() + `\nPAIRING_TOKEN=${PAIRING_TOKEN}\n`);
  console.log(`Generated new pairing token`);
}

// Load plugins from plugins/ directory
const plugins: SocketClaudePlugin[] = [];
const pluginsDir = path.join(__dirname, "..", "plugins");
if (fs.existsSync(pluginsDir)) {
  const files = fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith(".js"))
    .filter(f => !f.endsWith(".d.js"));
  for (const file of files) {
    try {
      const mod = require(path.join(pluginsDir, file));
      const plugin: SocketClaudePlugin = mod.default || mod;
      if (plugin.name) {
        plugins.push(plugin);
        console.log(`Loaded plugin: ${plugin.name}`);
      }
    } catch (e: any) {
      console.error(`Failed to load plugin ${file}: ${e.message}`);
    }
  }
}

// Global session registry — sessions survive client disconnects
const activeSessions: Map<string, ClaudeSession> = new Map();

// Desktop CLI watchers — detect when desktop CLI is using a session
const desktopWatchers: Map<string, DesktopCliWatcher> = new Map();

// Sessions whose context has been cleared — next query should NOT pass resume
const clearedSessions: Set<string> = new Set();


// Track all connected WebSocket clients for broadcasting
const connectedClients = new Set<WebSocket>();

// Track which WebSocket client is viewing which session, so the /continue
// endpoint can use the real WebSocket instead of a dummy when the app has
// already reconnected before the continue script runs.
interface SessionClient {
  ws: WebSocket;
  setActiveSession: (s: ClaudeSession) => void;
}
const sessionClients = new Map<string, SessionClient>();

/** Enrich stored sessions with live data from active sessions */
function getEnrichedSessions(): SessionInfo[] {
  const sessions = listSessions();
  const taskSessionIds = getScheduledTaskSessionIds();
  return sessions
    .filter(s => !taskSessionIds.has(s.id))
    .map(s => {
      const active = activeSessions.get(s.id);
      if (active && active.isRunning) {
        return {
          ...s,
          running: true,
          messagePreview: active.lastPreview || s.messagePreview,
          lastActive: new Date().toISOString(),
        };
      }
      return { ...s, running: false };
    });
}

/** Broadcast current session list to all connected clients */
function broadcastSessionList(): void {
  const enriched = getEnrichedSessions();
  const msg = JSON.stringify({ type: "session_list", sessions: enriched });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
  // Also send to relay client if paired
  if (relayConnectionHandler) {
    relayConnectionHandler.sendRaw(msg);
  }
}

/** Broadcast scheduled task list to all connected clients */
function broadcastScheduledTaskList(): void {
  const msg = JSON.stringify({ type: "scheduled_task_list", tasks: listScheduledTasks() });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relayConnectionHandler) relayConnectionHandler.sendRaw(msg);
}

/** Broadcast a scheduled task notification to all connected clients */
function broadcastScheduledTaskNotification(title: string, body: string, sessionId: string): void {
  const msg = JSON.stringify({ type: "scheduled_task_notification", title, body, sessionId });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relayConnectionHandler) relayConnectionHandler.sendRaw(msg);
}

/** Debounced broadcast for intermediate updates during queries */
let broadcastPending = false;
function scheduleBroadcast(): void {
  if (broadcastPending) return;
  broadcastPending = true;
  setTimeout(() => {
    broadcastPending = false;
    broadcastSessionList();
  }, 2000);
}

/**
 * Transport interface — abstracts over real WebSocket and relay virtual socket.
 * ClaudeSession needs readyState + send(). Connection handler needs send().
 */
interface ClientTransport {
  readonly readyState: number;
  send(data: string): void;
}

/**
 * Per-connection state and message handler.
 * Used for both direct WebSocket connections and relay connections.
 */
function createConnectionHandler(transport: ClientTransport) {
  let activeSession: ClaudeSession | null = null;
  let activeSessionId: string | null = null;
  let pendingTtsEnabled = false;
  let pendingTtsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  let pendingKokoroVoice = "af_heart";
  let pendingKokoroSpeed = 1.0;
  let pendingEffort: 'low' | 'medium' | 'high' | 'max' = 'high';
  let pendingThinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  let pendingDisallowedTools: string[] = [];
  let pendingSystemPrompt: string = '';

  // Track active file uploads from the app
  const activeUploads = new Map<string, {
    fd: number;
    filePath: string;
    fileName: string;
    receivedChunks: number;
    totalChunks: number;
  }>();

  function sendJson(obj: Record<string, unknown>): void {
    if (transport.readyState === WebSocket.OPEN) {
      transport.send(JSON.stringify(obj));
    }
  }

  // Expose raw send for broadcasting (already JSON-stringified)
  function sendRaw(data: string): void {
    if (transport.readyState === WebSocket.OPEN) {
      transport.send(data);
    }
  }

  async function handleMessage(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "new_session": {
        const cwd = msg.cwd || DEFAULT_CWD;
        // Detach old session so it stops sending to this client
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        activeSession = new ClaudeSession(transport as any, cwd, plugins);
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd,
          title: "Untitled",
        });
        break;
      }

      case "resume_session": {
        // Detach old session so it stops sending to this client
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        let sessionInfo = getSession(msg.sessionId);
        // If not in SocketClaude store but cwd is provided, this is an SDK-only session
        if (!sessionInfo && (msg as any).cwd) {
          sessionInfo = {
            id: msg.sessionId,
            title: "Untitled",
            cwd: (msg as any).cwd,
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            messagePreview: "",
          };
          saveSession(sessionInfo);
          console.log(`[Resume] Created SocketClaude entry for SDK session ${msg.sessionId} in ${(msg as any).cwd}`);
        }
        if (!sessionInfo) {
          sendJson({
            type: "error",
            message: `Session ${msg.sessionId} not found`,
          });
          break;
        }

        // Check if this session is still running in the background
        const existing = activeSessions.get(msg.sessionId);
        if (existing) {
          // Reattach the transport to the running session
          existing.setWebSocket(transport as any);
          activeSession = existing;
          console.log(`Reconnected to running session ${msg.sessionId}`);
        } else {
          activeSession = new ClaudeSession(transport as any, sessionInfo.cwd, plugins);
          (activeSession as any)._resumeSessionId = msg.sessionId;
        }
        activeSessionId = msg.sessionId;
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);

        // Register this client so /continue can find the real WebSocket
        sessionClients.set(msg.sessionId, {
          ws: transport as WebSocket,
          setActiveSession: (s: ClaudeSession) => { activeSession = s; },
        });

        sendJson({
          type: "session_created",
          sessionId: msg.sessionId,
          cwd: sessionInfo.cwd,
          title: sessionInfo.title,
        });

        // Send message history — if session is running, load back to last user prompt
        const isRunning = activeSessions.has(msg.sessionId) && activeSessions.get(msg.sessionId)!.isRunning;
        const page = isRunning
          ? getHistoryPageToLastPrompt(msg.sessionId, 50)
          : getHistoryPage(msg.sessionId, 50);
        const todos = getTodos(msg.sessionId);
        sendJson({
          type: "session_history",
          sessionId: msg.sessionId,
          messages: page.entries,
          total: page.total,
          offset: page.offset,
          ...(todos.length > 0 ? { todos } : {}),
        });

        // Check for missed messages from Claude Code's session file
        const allHistory = getHistory(msg.sessionId);
        const lastTimestamp = allHistory.length > 0
          ? allHistory[allHistory.length - 1].timestamp
          : "";
        {
          // When history is empty, use epoch so we sync ALL messages from the JSONL
          const missed = getMissedMessages(msg.sessionId, sessionInfo.cwd, lastTimestamp || "1970-01-01T00:00:00Z");
          if (missed.length > 0) {
            console.log(`[Resume] Found ${missed.length} missed messages from JSONL`);
            for (const entry of missed) {
              appendHistory(msg.sessionId, entry);
            }
            sendJson({
              type: "session_history",
              sessionId: msg.sessionId,
              messages: missed,
              total: (page.total || 0) + missed.length,
              offset: page.total || 0,
              append: true,
            });
          }
        }

        // Send SDK event history for raw debug mode
        const sdkEvents = getSdkEvents(msg.sessionId);
        if (sdkEvents.length > 0) {
          sendJson({
            type: "sdk_event_history",
            sessionId: msg.sessionId,
            events: sdkEvents,
          });
        }

        // Restore last usage data if available
        if ((sessionInfo as any).lastUsage) {
          sendJson({
            type: "usage_restore",
            usage: (sessionInfo as any).lastUsage,
          });
        }

        // Always send status so the app resets its processing state on resume
        const resumeRunning = !!(existing && existing.isRunning);
        const resumeCompacting = !!(existing && existing.isCompacting);
        const activeToolInfo = existing?.getActiveToolCall?.() || null;
        console.log(`[Resume] sessionId=${msg.sessionId} existing=${!!existing} isRunning=${existing?.isRunning} compacting=${resumeCompacting} → sending running=${resumeRunning} activeToolUseId=${activeToolInfo?.toolUseId || 'none'}`);
        sendJson({
          type: "status",
          sessionId: msg.sessionId,
          running: resumeRunning,
          compacting: resumeCompacting,
          ...(activeToolInfo ? { activeToolUseId: activeToolInfo.toolUseId } : {}),
        });

        // Re-send accumulated bash output so the reconnecting client sees live output
        if (resumeRunning && existing) {
          const bashOutput = existing.getAccumulatedBashOutput();
          if (bashOutput) {
            console.log(`[Resume] Re-sending ${bashOutput.length} chars of accumulated bash output`);
            sendJson({
              type: "tool_stderr",
              content: bashOutput,
              sessionId: msg.sessionId,
            });
          }
        }

        // Start desktop CLI watcher for this session (syncs JSONL changes)
        if (!desktopWatchers.has(msg.sessionId)) {
          const watcherSessionId = msg.sessionId;
          const watcher = new DesktopCliWatcher({
            sessionId: watcherSessionId,
            cwd: sessionInfo.cwd,
            onNewMessages: (messages) => {
              console.log(`[DesktopCLI] Syncing ${messages.length} messages to app for session ${watcherSessionId}`);
              sendJson({
                type: "session_history",
                sessionId: watcherSessionId,
                messages,
                total: -1,
                offset: -1,
                append: true,
              });
              broadcastSessionList();
            },
            isOurQueryRunning: () => {
              const session = activeSessions.get(watcherSessionId);
              return session?.isRunning || false;
            },
          });
          watcher.start();
          desktopWatchers.set(watcherSessionId, watcher);
        }
        break;
      }

      case "prompt": {
        if (!activeSession) {
          let cwd = DEFAULT_CWD;
          const savedResumeId = msg.sessionId;
          if (savedResumeId) {
            const savedSession = getSession(savedResumeId);
            if (savedSession) {
              cwd = savedSession.cwd;
            }
          }
          activeSession = new ClaudeSession(transport as any, cwd, plugins);
          activeSession.setTtsEnabled(pendingTtsEnabled);
          activeSession.setEffort(pendingEffort);
          activeSession.setThinking(pendingThinking);
        }

        // If session is already running, inject the message inline between turns
        if (activeSession.isRunning) {
          const priority = (msg as any).priority || 'now';
          const messageId = (msg as any).messageId || '';
          console.log(`[Inject] Session running, injecting user message inline (priority=${priority}, messageId=${messageId})`);
          activeSession.injectMessage(msg.text, priority).then(() => {
            // Acknowledge injection so the app can promote the pending message
            sendJson({ type: "injection_ack", messageId });
          }).catch((e: any) => {
            console.error(`[Inject] Failed: ${e}`);
          });
          break;
        }

        let resumeId: string | undefined =
          msg.sessionId ||
          (activeSession as any)._resumeSessionId ||
          activeSession.getSessionId() ||
          undefined;

        // If context was cleared, don't resume — start fresh
        if (resumeId && clearedSessions.has(resumeId)) {
          console.log(`[Clear] Session ${resumeId} was cleared, starting fresh (no resume)`);
          clearedSessions.delete(resumeId);
          activeSession.replacesSessionId = resumeId;
          resumeId = undefined;
        }

        (activeSession as any)._resumeSessionId = undefined;

        activeSession.onActivity = () => scheduleBroadcast();

        activeSession.runQuery(msg.text, resumeId).then(() => {
          const sid = activeSession?.getSessionId();
          if (sid && activeSessions.get(sid) === activeSession) {
            // Keep session in pool if auth login is pending
            if ((activeSession as any)._authCodeVerifier) {
              console.log(`Session ${sid} query completed but auth flow pending — keeping in active pool`);
            } else {
              activeSessions.delete(sid);
              console.log(`Session ${sid} completed, removed from active pool`);
            }
          }
          broadcastSessionList();
        }).catch((err) => {
          sendJson({
            type: "error",
            message: err.message || "Query failed",
          });
        });

        // Register the session globally once it has an ID
        const checkAndRegister = () => {
          const sid = activeSession?.getSessionId();
          if (sid && !activeSessions.has(sid)) {
            activeSessions.set(sid, activeSession!);
          }
        };
        const interval = setInterval(() => {
          checkAndRegister();
          const sid = activeSession?.getSessionId();
          if (sid) {
            clearInterval(interval);
            broadcastSessionList();
          }
        }, 500);
        setTimeout(() => clearInterval(interval), 30000);
        break;
      }

      case "answer": {
        const qId = msg.questionId as string;
        let answerHandled = false;
        if (activeSession) {
          const sessionCtx = activeSession.getSessionContext();
          for (const plugin of plugins) {
            if (plugin.answerMiddleware) {
              const result = await plugin.answerMiddleware(qId, msg.answers, sessionCtx);
              if (result.handled) {
                answerHandled = true;
                // Notify app so card marks as answered
                sendJson({ type: "question_answered", questionId: qId });
                // Persist answered state in history
                const sid = activeSession.getSessionId()
                  || (activeSession as any)._resumeSessionId
                  || activeSessionId
                  || undefined;
                if (sid) markQuestionAnswered(sid, qId);
                break;
              }
            }
          }
        }
        if (!answerHandled && activeSession) {
          const resolved = activeSession.resolveQuestion(qId, msg.answers);
          if (!resolved) {
            // Question promise is gone (e.g. after server restart) — inject as prompt
            const answers = msg.answers as Record<string, string>;
            const parts: string[] = [];
            for (const [question, answer] of Object.entries(answers)) {
              parts.push(`Q: ${question}\nA: ${answer}`);
            }
            const injectedText = `[You previously asked me a question. Here is my answer:]\n\n${parts.join("\n\n")}`;
            console.log(`[Answer] No pending promise for ${qId}, injecting as prompt`);
            // Confirm to app that the question was handled (so card marks as answered)
            sendJson({ type: "question_answered", questionId: qId });
            // Resolve the session ID — check all sources (same as prompt handler)
            const sid = activeSession.getSessionId()
              || (activeSession as any)._resumeSessionId
              || activeSessionId
              || undefined;
            // Mark as answered in history even though promise is gone
            if (sid) {
              markQuestionAnswered(sid, qId);
            }
            // If a query is running, inject mid-conversation; otherwise resume with answer
            if (activeSession.isRunning) {
              activeSession.injectMessage(injectedText);
            } else {
              // Resume the existing session with the answer context
              activeSession.onActivity = () => scheduleBroadcast();
              activeSession.runQuery(injectedText, sid).then(() => {
                const s = activeSession?.getSessionId();
                if (s && activeSessions.get(s) === activeSession) {
                  activeSessions.delete(s);
                }
                broadcastSessionList();
              }).catch((err) => {
                sendJson({ type: "error", message: err.message || "Query failed" });
              });
            }
          }
        }
        break;
      }

      case "list_sessions": {
        sendJson({
          type: "session_list",
          sessions: getEnrichedSessions(),
        });
        break;
      }

      case "list_sdk_sessions": {
        const cwd = (msg as any).cwd as string;
        console.log(`[SdkSessions] Request for cwd=${cwd}`);
        if (!cwd) {
          sendJson({ type: "error", message: "No cwd provided for list_sdk_sessions" });
          break;
        }
        const sdkSessions = listSdkSessions(cwd);
        console.log(`[SdkSessions] Found ${sdkSessions.length} sessions for ${cwd}`);
        sendJson({ type: "sdk_session_list", cwd, sessions: sdkSessions });
        break;
      }

      case "sync_desktop": {
        const syncSid = (msg as any).sessionId as string;
        if (syncSid) {
          const watcher = desktopWatchers.get(syncSid);
          if (watcher) {
            watcher.syncNow();
          }
        }
        break;
      }

      case "delete_session": {
        const sid = msg.sessionId;
        const running = activeSessions.get(sid);
        if (running) {
          running.abort();
          activeSessions.delete(sid);
        }
        // Stop desktop CLI watcher
        const delWatcher = desktopWatchers.get(sid);
        if (delWatcher) {
          delWatcher.stop();
          desktopWatchers.delete(sid);
        }
        deleteSession(sid);
        console.log(`Deleted session ${sid}`);
        broadcastSessionList();
        break;
      }

      case "rename_session": {
        const session = getSession(msg.sessionId);
        if (session) {
          session.title = msg.title;
          saveSession(session);
          console.log(`Renamed session ${msg.sessionId} to "${msg.title}"`);
          broadcastSessionList();
        }
        break;
      }

      // ── Scheduled tasks ──

      case "schedule_task": {
        const recurrence = (msg as any).recurrence;
        const task: ScheduledTask = {
          id: crypto.randomUUID(),
          prompt: (msg as any).prompt,
          cwd: (msg as any).cwd,
          scheduledTime: (msg as any).scheduledTime,
          createdAt: new Date().toISOString(),
          status: "pending",
          createdBySessionId: activeSessionId || undefined,
          recurrence: recurrence && recurrence.type !== "once" ? recurrence : undefined,
          reuseSession: (msg as any).reuseSession || false,
          runCount: 0,
          runs: [],
        };
        saveScheduledTask(task);
        console.log(`[Scheduler] Task created: ${task.id} for ${task.scheduledTime}${task.recurrence ? ` (recurring: ${task.recurrence.type})` : ""}`);
        broadcastScheduledTaskList();
        break;
      }

      case "list_scheduled_tasks": {
        sendJson({ type: "scheduled_task_list", tasks: listScheduledTasks() });
        break;
      }

      case "cancel_scheduled_task": {
        const task = getScheduledTask((msg as any).taskId);
        if (task && task.status === "pending") {
          task.status = "cancelled";
          saveScheduledTask(task);
          console.log(`[Scheduler] Task cancelled: ${task.id}`);
          broadcastScheduledTaskList();
        }
        break;
      }

      case "update_scheduled_task": {
        const task = getScheduledTask((msg as any).taskId);
        if (task && (task.status === "pending" || task.status === "cancelled")) {
          if ((msg as any).prompt !== undefined) task.prompt = (msg as any).prompt;
          if ((msg as any).cwd !== undefined) task.cwd = (msg as any).cwd;
          if ((msg as any).scheduledTime !== undefined) task.scheduledTime = (msg as any).scheduledTime;
          if ((msg as any).recurrence !== undefined) {
            const rec = (msg as any).recurrence;
            task.recurrence = rec && rec.type !== "once" ? rec : undefined;
          }
          if ((msg as any).reuseSession !== undefined) task.reuseSession = (msg as any).reuseSession;
          // Allow re-activating a cancelled task
          if (task.status === "cancelled") task.status = "pending";
          saveScheduledTask(task);
          console.log(`[Scheduler] Task updated: ${task.id}`);
          broadcastScheduledTaskList();
        }
        break;
      }

      case "delete_scheduled_task": {
        deleteScheduledTask((msg as any).taskId);
        console.log(`[Scheduler] Task deleted: ${(msg as any).taskId}`);
        broadcastScheduledTaskList();
        break;
      }

      case "version_check": {
        const { execSync } = require("child_process");
        const info: any = { type: "version_info", gitAvailable: !!GIT_ROOT };
        if (GIT_ROOT) {
          try {
            const localHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const localMsg = execSync("git log -1 --format=%s", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const localDate = execSync("git log -1 --format=%ci", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            info.local = { hash: localHash, branch, message: localMsg, date: localDate };

            // Fetch and check remote
            try {
              execSync("git fetch origin", { cwd: GIT_ROOT, stdio: "pipe", timeout: 15000 });
              const remoteHash = execSync(`git rev-parse origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
              const remoteMsg = execSync(`git log origin/${branch} -1 --format=%s`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
              const remoteDate = execSync(`git log origin/${branch} -1 --format=%ci`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
              const commitsBehind = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim(), 10);
              info.remote = { hash: remoteHash, message: remoteMsg, date: remoteDate };
              info.updateAvailable = localHash !== remoteHash;
              info.commitsBehind = commitsBehind;
            } catch (e: any) {
              info.fetchError = e.message;
            }
          } catch (e: any) {
            info.error = e.message;
          }
        }
        sendJson(info);
        break;
      }

      case "force_update": {
        if (!GIT_ROOT) {
          sendJson({ type: "update_result", success: false, error: "No git repo found" });
          break;
        }
        const { execSync } = require("child_process");
        try {
          const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
          const beforeHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

          // Pull
          execSync(`git pull origin ${branch}`, { cwd: GIT_ROOT, stdio: "pipe", timeout: 60000 });
          const afterHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

          if (beforeHash === afterHash) {
            sendJson({ type: "update_result", success: true, message: "Already up to date", hash: afterHash });
            break;
          }

          // Compile
          const tscDir = fs.existsSync(path.join(GIT_ROOT, "server", "tsconfig.json"))
            ? path.join(GIT_ROOT, "server")
            : GIT_ROOT;
          execSync("npx tsc", { cwd: tscDir, stdio: "pipe", timeout: 120000 });

          const afterMsg = execSync("git log -1 --format=%s", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
          sendJson({ type: "update_result", success: true, message: `Updated to ${afterHash.substring(0, 7)}: ${afterMsg}`, hash: afterHash, needsRestart: true });

          // Auto-restart after a short delay so the response gets sent
          setTimeout(() => {
            console.log(`[ForceUpdate] Restarting after update ${beforeHash.substring(0, 7)} → ${afterHash.substring(0, 7)}`);
            process.exit(1);
          }, 1000);
        } catch (e: any) {
          sendJson({ type: "update_result", success: false, error: e.message });
        }
        break;
      }

      case "clear_context": {
        const sid = msg.sessionId;
        const sessionInfo = getSession(sid);
        if (sessionInfo) {
          const running = activeSessions.get(sid);
          if (running) {
            running.abort();
            activeSessions.delete(sid);
          }
          // Stop desktop CLI watcher (JSONL gets archived)
          const clearWatcher = desktopWatchers.get(sid);
          if (clearWatcher) {
            clearWatcher.stop();
            desktopWatchers.delete(sid);
          }
          clearSessionContext(sid, sessionInfo.cwd);
          clearedSessions.add(sid);
          console.log(`Cleared context for session ${sid}`);
          sendJson({ type: "context_cleared", sessionId: sid });
          broadcastSessionList();
        }
        break;
      }

      case "auth_code": {
        const code = (msg as any).code as string;
        const targetSid = (msg as any).sessionId || activeSessionId;
        const session = targetSid ? activeSessions.get(targetSid) : null;
        if (session) {
          session.submitAuthCode(code);
        } else if (activeSession) {
          activeSession.submitAuthCode(code);
        } else {
          sendJson({ type: "error", message: "No active session for auth code" });
        }
        break;
      }

      case "abort": {
        // Always use the explicit session ID from the client
        const targetSid = msg.sessionId || activeSessionId;
        if (!targetSid) {
          console.log(`[Abort] No session ID provided and no active session`);
          break;
        }
        const targetSession = activeSessions.get(targetSid);
        if (targetSession) {
          console.log(`[Abort] Aborting session ${targetSid} (isRunning=${targetSession.isRunning})`);
          targetSession.abort();
          activeSessions.delete(targetSid);
          broadcastStatusSync();
        } else if (activeSession && activeSessionId === targetSid) {
          console.log(`[Abort] Aborting connection-local session ${targetSid}`);
          activeSession.abort();
          broadcastStatusSync();
        } else {
          console.log(`[Abort] Session ${targetSid} not found in activeSessions`);
        }
        break;
      }

      case "interrupt": {
        if (activeSession) {
          console.log(`Interrupting active session (graceful pause)`);
          activeSession.interrupt();
        }
        break;
      }

      case "set_tts": {
        const enabled = (msg as any).enabled === true;
        pendingTtsEnabled = enabled;
        if (activeSession) {
          activeSession.setTtsEnabled(enabled);
        }
        console.log(`TTS preference set to ${enabled} (session ${activeSession ? 'active' : 'pending'})`);
        break;
      }

      case "set_tts_engine": {
        const engine = (msg as any).engine as string;
        if (["system", "kokoro_server", "kokoro_device"].includes(engine)) {
          pendingTtsEngine = engine as any;
          if ((msg as any).voice) pendingKokoroVoice = (msg as any).voice;
          if ((msg as any).speed) pendingKokoroSpeed = (msg as any).speed;
          if (activeSession) {
            activeSession.setTtsEngine(engine as any);
            if ((msg as any).voice) activeSession.setKokoroVoice((msg as any).voice);
            if ((msg as any).speed) activeSession.setKokoroSpeed((msg as any).speed);
          }
          console.log(`TTS engine set to ${engine} voice=${pendingKokoroVoice} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "request_tts_audio": {
        const text = (msg as any).text as string;
        const voice = (msg as any).voice as string || pendingKokoroVoice;
        const speed = (msg as any).speed as number || pendingKokoroSpeed;
        if (text) {
          try {
            const { generateKokoroAudio } = require("./kokoro-tts");
            const wavBuffer = generateKokoroAudio(text, voice, speed);
            if (wavBuffer) {
              sendJson({
                type: "tts_audio",
                audioData: wavBuffer.toString("base64"),
                text,
                sessionId: activeSession?.getSessionId() || "",
              });
            } else {
              sendJson({ type: "error", message: "Kokoro TTS model not available" });
            }
          } catch (e: any) {
            console.error("[KokoroTTS] request_tts_audio error:", e);
            sendJson({ type: "error", message: `TTS generation failed: ${e.message || e}` });
          }
        }
        break;
      }

      case "set_effort": {
        const effort = (msg as any).effort as string;
        if (['low', 'medium', 'high', 'max'].includes(effort)) {
          pendingEffort = effort as any;
          if (activeSession) {
            activeSession.setEffort(effort as any);
          }
          console.log(`Effort set to ${effort} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_thinking": {
        const thinking = (msg as any).thinking;
        if (thinking && ['adaptive', 'enabled', 'disabled'].includes(thinking.type)) {
          pendingThinking = thinking;
          if (activeSession) {
            activeSession.setThinking(thinking);
          }
          console.log(`Thinking set to ${JSON.stringify(thinking)} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_disallowed_tools": {
        const tools = (msg as any).tools as string[];
        if (Array.isArray(tools)) {
          pendingDisallowedTools = tools;
          if (activeSession) {
            activeSession.setDisallowedTools(tools);
          }
          console.log(`Disallowed tools set to [${tools.join(', ')}] (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_system_prompt": {
        const prompt = (msg as any).prompt as string;
        if (typeof prompt === 'string') {
          pendingSystemPrompt = prompt;
          if (activeSession) {
            activeSession.setAppendSystemPrompt(prompt);
          }
          console.log(`System prompt set (${prompt.length} chars) (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "stop_task": {
        const taskId = (msg as any).taskId as string;
        console.log(`[stop_task] received: taskId=${taskId} activeSession=${!!activeSession}`);
        if (activeSession && taskId) {
          activeSession.stopTask(taskId).catch(e => console.error(`[stop_task] error: ${e}`));
        }
        break;
      }

      case "set_model": {
        const model = (msg as any).model as string | undefined;
        if (activeSession) {
          activeSession.setModel(model).catch(e => {
            console.error(`[set_model] error: ${e}`);
            sendJson({ type: "error", message: `Failed to set model: ${e.message || e}` });
          });
        }
        break;
      }

      case "mcp_status": {
        if (activeSession) {
          activeSession.mcpServerStatus().then(status => {
            sendJson({ type: "mcp_status", servers: status || [] });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to get MCP status: ${e.message || e}` });
          });
        }
        break;
      }

      case "mcp_reconnect": {
        const serverName = (msg as any).serverName as string;
        if (activeSession && serverName) {
          activeSession.reconnectMcpServer(serverName).then(result => {
            sendJson({ type: "mcp_reconnect_result", serverName, success: true });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to reconnect ${serverName}: ${e.message || e}` });
          });
        }
        break;
      }

      case "mcp_toggle": {
        const serverName = (msg as any).serverName as string;
        const enabled = (msg as any).enabled as boolean;
        if (activeSession && serverName) {
          activeSession.toggleMcpServer(serverName, enabled).then(() => {
            sendJson({ type: "mcp_toggle_result", serverName, enabled });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to toggle ${serverName}: ${e.message || e}` });
          });
        }
        break;
      }

      case "rewind": {
        const uuid = (msg as any).userMessageUuid as string;
        const dryRun = (msg as any).dryRun === true;
        if (!activeSession) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No active session" });
        } else if (!uuid) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No message UUID" });
        } else if (!activeSession.isRunning) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No active query — rewind requires a running conversation. Send a message first, then rewind." });
        } else {
          activeSession.rewindFiles(uuid, dryRun).then(result => {
            if (!result) {
              sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No file checkpoint found at this message" });
            } else {
              sendJson({ type: "rewind_result", uuid, dryRun, success: true, ...result });
            }
          }).catch(e => {
            sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: e.message || String(e) });
          });
        }
        break;
      }

      case "fork_session": {
        const sourceId = (msg as any).sessionId as string;
        if (!sourceId) {
          sendJson({ type: "error", message: "No session ID to fork" });
          break;
        }
        const sessionInfo = getSession(sourceId);
        if (!sessionInfo) {
          sendJson({ type: "error", message: "Session not found" });
          break;
        }
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        activeSession = new ClaudeSession(transport as any, sessionInfo.cwd, plugins);
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);
        activeSession.setForkSource(sourceId);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd: sessionInfo.cwd,
          title: "Untitled",
        });
        const forkPage = getHistoryPage(sourceId, 50);
        sendJson({
          type: "session_history",
          sessionId: sourceId,
          messages: forkPage.entries,
          total: forkPage.total,
          offset: forkPage.offset,
        });
        console.log(`Forking session ${sourceId} (cwd=${sessionInfo.cwd})`);
        break;
      }

      case "load_more_history": {
        const sessionId = (msg as any).sessionId as string;
        const offset = (msg as any).offset as number;
        const limit = (msg as any).limit as number || 50;
        if (!sessionId) break;
        const page = getHistoryPage(sessionId, limit, offset);
        sendJson({
          type: "session_history",
          sessionId,
          messages: page.entries,
          total: page.total,
          offset: page.offset,
        });
        break;
      }

      case "check_cwd": {
        const checkPath = (msg as any).path as string;
        const exists = checkPath ? fs.existsSync(checkPath) : false;
        sendJson({
          type: "cwd_check",
          path: checkPath,
          exists,
        });
        break;
      }

      case "create_cwd": {
        const createPath = (msg as any).path as string;
        if (!createPath) {
          sendJson({ type: "error", message: "No path provided" });
          break;
        }
        try {
          fs.mkdirSync(createPath, { recursive: true });
          sendJson({
            type: "cwd_check",
            path: createPath,
            exists: true,
          });
        } catch (e: any) {
          sendJson({
            type: "error",
            message: `Failed to create directory: ${e.message}`,
          });
        }
        break;
      }

      case "list_directory" as any: {
        const listPath = (msg as any).path as string || DEFAULT_CWD;
        try {
          const resolvedPath = path.resolve(listPath);
          const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
          const dirs: string[] = [];
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              dirs.push(entry.name);
            }
          }
          dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
          sendJson({
            type: "directory_listing",
            path: resolvedPath,
            directories: dirs,
          });
        } catch (e: any) {
          sendJson({
            type: "directory_listing",
            path: listPath,
            directories: [],
            error: e.message,
          });
        }
        break;
      }

      case "request_file": {
        const filePath = (msg as any).filePath as string;
        const fileId = (msg as any).fileId as string;
        if (!filePath || !fs.existsSync(filePath)) {
          sendJson({
            type: "error",
            message: `File not found: ${filePath}`,
          });
          break;
        }
        const stat = fs.statSync(filePath);
        const fileName = path.basename(filePath);
        const CHUNK_SIZE = 512 * 1024; // 512KB
        const totalChunks = Math.ceil(stat.size / CHUNK_SIZE);
        console.log(`Sending file in ${totalChunks} chunks: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, i * CHUNK_SIZE);
          const chunk = buf.subarray(0, bytesRead).toString("base64");
          sendJson({
            type: "file_chunk",
            fileId,
            fileName,
            fileSize: stat.size,
            chunkIndex: i,
            totalChunks,
            data: chunk,
          });
        }
        fs.closeSync(fd);

        sendJson({
          type: "file_complete",
          fileId,
          fileName,
        });
        console.log(`File transfer complete: ${fileName}`);
        break;
      }

      case "upload_start": {
        const uploadId = msg.uploadId;
        const fileName = path.basename(msg.fileName || "upload"); // sanitize: strip path traversal
        const fileSize = msg.fileSize;
        const totalChunks = msg.totalChunks;

        const cwd = activeSession?.getCwd() || DEFAULT_CWD;
        const uploadDir = path.join(cwd, ".uploads");
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        let filePath = path.join(uploadDir, fileName);
        let counter = 1;
        while (fs.existsSync(filePath)) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          filePath = path.join(uploadDir, `${base} (${counter})${ext}`);
          counter++;
        }

        const fd = fs.openSync(filePath, "w");
        activeUploads.set(uploadId, { fd, filePath, fileName, receivedChunks: 0, totalChunks });
        console.log(`Upload started: ${fileName} (${totalChunks} chunks, ${(fileSize / 1024).toFixed(1)} KB)`);
        break;
      }

      case "upload_chunk": {
        const uploadId = msg.uploadId;
        const chunkIndex = msg.chunkIndex;
        const data = msg.data as string;
        const upload = activeUploads.get(uploadId);
        if (!upload) {
          sendJson({ type: "error", message: `Unknown upload: ${uploadId}` });
          break;
        }

        const CHUNK_SIZE = 512 * 1024;
        const bytes = Buffer.from(data, "base64");
        fs.writeSync(upload.fd, bytes, 0, bytes.length, chunkIndex * CHUNK_SIZE);
        upload.receivedChunks++;

        if (upload.receivedChunks >= upload.totalChunks) {
          fs.closeSync(upload.fd);
          activeUploads.delete(uploadId);
          sendJson({
            type: "upload_complete",
            uploadId,
            serverPath: upload.filePath,
          });
          console.log(`Upload complete: ${upload.fileName} -> ${upload.filePath}`);
        }
        break;
      }
    }
  }

  return {
    handleMessage,
    sendJson,
    sendRaw,
    get activeSessionId() { return activeSessionId; },
  };
}

const httpServer = http.createServer((req, res) => {
  // POST /continue — trigger a prompt on a session without a WebSocket (used by restart script)
  if (req.method === "POST" && req.url?.startsWith("/continue")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { sessionId, prompt } = JSON.parse(body);
        if (!sessionId || !prompt) {
          res.writeHead(400);
          res.end("Missing sessionId or prompt");
          return;
        }
        const sessionInfo = getSession(sessionId);
        if (!sessionInfo) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
        // Use the real WebSocket if a client is already connected for this session
        // (typical after restart: app reconnects before the continue script runs).
        // Otherwise fall back to a dummy so the query still runs headless.
        const existingClient = sessionClients.get(sessionId);
        const ws = existingClient?.ws?.readyState === WebSocket.OPEN
          ? existingClient.ws
          : { readyState: WebSocket.CLOSED, send: () => {} } as any;
        const session = new ClaudeSession(ws, sessionInfo.cwd, plugins);
        (session as any)._resumeSessionId = sessionId;
        session.onActivity = () => scheduleBroadcast();

        // Register immediately so the app can find it when it reconnects
        activeSessions.set(sessionId, session);

        // Update the connection handler's active session so future messages
        // (prompts, answers, abort) from the app go to this running session
        if (existingClient) {
          existingClient.setActiveSession(session);
          console.log(`[Continue] Using existing WebSocket for session ${sessionId}`);
        }
        console.log(`[Continue] Starting query for session ${sessionId}`);

        session.runQuery(prompt, sessionId).then(() => {
          const sid = session.getSessionId() || sessionId;
          if (activeSessions.get(sid) === session) {
            activeSessions.delete(sid);
          }
          broadcastSessionList();
        }).catch((err) => {
          console.error(`[Continue] Query error: ${err.message}`);
          activeSessions.delete(sessionId);
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message || "Server error");
      }
    });
    return;
  }

  // GET /running-sessions — return list of currently running session IDs (used by restart script)
  if (req.method === "GET" && req.url?.startsWith("/running-sessions")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    const running: string[] = [];
    for (const [sid, session] of activeSessions) {
      if (session.isRunning) running.push(sid);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: running }));
    return;
  }

  // GET /tts-model — serve Kokoro model components individually
  // ?model=kokoro-en-v0_19|kokoro-multi-lang-v1_0 — which model dir (default: kokoro-en-v0_19)
  // ?file=model.onnx|voices.bin|tokens.txt|espeak-ng-data — which file to serve
  if (req.method === "GET" && req.url?.startsWith("/tts-model")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    // Whitelist of allowed model directories
    const allowedModels = ["kokoro-en-v0_19", "kokoro-multi-lang-v1_0"];
    const modelName = url.searchParams.get("model") || "kokoro-en-v0_19";
    if (!allowedModels.includes(modelName)) {
      res.writeHead(400);
      res.end(`Invalid model: ${modelName}. Allowed: ${allowedModels.join(", ")}`);
      return;
    }
    const modelDir = path.join(require("os").homedir(), ".claude-assistant", "tts-models", modelName);

    const fileName = url.searchParams.get("file") || "";
    if (!fileName) {
      res.writeHead(400);
      res.end("Missing ?file= parameter.");
      return;
    }

    // Directories served as tar.gz (espeak-ng-data, dict)
    const tarDirs = ["espeak-ng-data", "dict"];
    if (tarDirs.includes(fileName)) {
      const dirPath = path.join(modelDir, fileName);
      if (!fs.existsSync(dirPath)) {
        res.writeHead(404);
        res.end(`${fileName} not found`);
        return;
      }
      console.log(`[TTS Model] Serving ${modelName}/${fileName} as tar.gz...`);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename=${fileName}.tar.gz`,
        "Transfer-Encoding": "chunked",
      });
      const { spawn } = require("child_process");
      const tar = spawn("tar", ["czf", "-", "-C", modelDir, fileName]);
      tar.stdout.pipe(res);
      tar.stderr.on("data", (d: Buffer) => console.error("[TTS Model tar]", d.toString()));
      tar.on("close", (code: number) => {
        if (code !== 0) console.error(`[TTS Model] tar exited with code ${code}`);
        else console.log(`[TTS Model] ${fileName} transfer complete`);
      });
      return;
    }

    // Validate file name (only allow known files to prevent path traversal)
    const allowedFiles = ["model.onnx", "voices.bin", "tokens.txt",
      "lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"];
    if (!allowedFiles.includes(fileName)) {
      res.writeHead(400);
      res.end(`Invalid file: ${fileName}. Allowed: ${allowedFiles.join(", ")}, ${tarDirs.join(", ")}`);
      return;
    }

    const filePath = path.join(modelDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end(`File not found: ${fileName}`);
      return;
    }

    const stat = fs.statSync(filePath);
    console.log(`[TTS Model] Serving ${fileName} (${(stat.size / 1024 / 1024).toFixed(0)} MB)...`);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size.toString(),
      "Content-Disposition": `attachment; filename=${fileName}`,
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error("[TTS Model] Stream error:", err);
      res.end();
    });
    return;
  }

  // GET /download — stream a file for HTTP download (avoids WebSocket main-thread blocking)
  if (req.method === "GET" && req.url?.startsWith("/download")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    const filePath = url.searchParams.get("path");
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("File not found");
      return;
    }
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    console.log(`[HTTP Download] Serving ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": stat.size.toString(),
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    readStream.on("error", (err) => {
      console.error(`[HTTP Download] Error streaming ${fileName}:`, err);
      res.end();
    });
    return;
  }

  for (const plugin of plugins) {
    if (plugin.httpHandler && plugin.httpHandler(req, res)) return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade with auth
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `ws://localhost:${PORT}`);
  const token = url.searchParams.get("token");
  if (token !== AUTH_TOKEN) {
    console.log("Rejected connection: invalid token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Relay client (initialized after server starts if RELAY_URL is set)
let relayClient: RelayClient | null = null;
let relayConnectionHandler: ReturnType<typeof createConnectionHandler> | null = null;

httpServer.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT} (WebSocket + HTTP)`);
  console.log(`Default working directory: ${DEFAULT_CWD}`);

  // Initialize plugins
  const pluginContext: PluginContext = {
    getActiveSessions: () => activeSessions,
    getConnectedClients: () => connectedClients,
    broadcast: (msg: string) => {
      for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
      if (relayConnectionHandler) {
        relayConnectionHandler.sendRaw(msg);
      }
    },
    getPort: () => PORT,
    getDefaultCwd: () => DEFAULT_CWD,
  };
  for (const plugin of plugins) {
    if (plugin.init) {
      try {
        await plugin.init(pluginContext);
      } catch (e: any) {
        console.error(`Plugin ${plugin.name} init failed: ${e.message}`);
      }
    }
  }

  // Start relay client if configured
  if (RELAY_URL) {
    startRelayClient();
  }
});

// Clean up any tool calls left pending from a previous server crash
cleanupPendingToolCalls();


// ── Periodic status sync heartbeat ──
// Broadcasts current state to all connected clients so the app stays in sync
// after reconnects, server restarts, or dropped messages.
const SERVER_STARTED_AT = new Date().toISOString();
// Cache git version at startup for status_sync
let SERVER_GIT_HASH = "";
try {
  const { execSync } = require("child_process");
  const gitRoot = findGitRoot(path.resolve(__dirname, ".."));
  if (gitRoot) SERVER_GIT_HASH = execSync("git rev-parse --short HEAD", { cwd: gitRoot, stdio: "pipe" }).toString().trim();
} catch {}
const STATUS_SYNC_IDLE_INTERVAL = 10000; // 10s when idle
const STATUS_SYNC_RUNNING_INTERVAL = 3000; // 3s when running

/** Build and broadcast status_sync to all connected clients (and relay). */
function broadcastStatusSync(): void {
  if (connectedClients.size === 0 && !relayConnectionHandler) return;

  const msg = buildStatusSyncMessage();
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
  if (relayConnectionHandler) {
    relayConnectionHandler.sendRaw(msg);
  }
}

/** Send status_sync to a single client. */
function sendStatusSyncTo(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buildStatusSyncMessage());
  }
}

function buildStatusSyncMessage(): string {
  let anyRunning = false;
  const runningSessions: string[] = [];
  const compactingSessions: string[] = [];
  const backgroundTaskIds: string[] = [];
  for (const [sid, session] of activeSessions) {
    if (session.isRunning) {
      anyRunning = true;
      runningSessions.push(sid);
    }
    if (session.isCompacting) {
      compactingSessions.push(sid);
    }
    for (const [taskId] of session.activeBackgroundTasks) {
      backgroundTaskIds.push(taskId);
    }
  }
  return JSON.stringify({
    type: "status_sync",
    running: anyRunning,
    runningSessions,
    compactingSessions,
    serverStartedAt: SERVER_STARTED_AT,
    serverPid: process.pid,
    serverVersion: SERVER_GIT_HASH || undefined,
    backgroundTaskIds,
  });
}

// Adaptive heartbeat: 3s when any session is running, 10s when idle
let statusSyncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleStatusSync(): void {
  if (statusSyncTimer) clearTimeout(statusSyncTimer);

  let anyRunning = false;
  for (const [, session] of activeSessions) {
    if (session.isRunning) { anyRunning = true; break; }
  }

  const interval = anyRunning ? STATUS_SYNC_RUNNING_INTERVAL : STATUS_SYNC_IDLE_INTERVAL;
  statusSyncTimer = setTimeout(() => {
    broadcastStatusSync();
    scheduleStatusSync(); // reschedule
  }, interval);
}
scheduleStatusSync();

// ── Scheduled task executor ──
const SCHEDULER_INTERVAL = 30000; // 30s

async function checkScheduledTasks(): Promise<void> {
  const dueTasks = getDueTasks();
  for (const task of dueTasks) {
    // Mark as running immediately to prevent double-execution
    task.status = "running";
    saveScheduledTask(task);
    broadcastScheduledTaskList();

    const isRecurring = task.recurrence && task.recurrence.type !== "once";
    const runNumber = (task.runCount || 0) + 1;
    console.log(`[Scheduler] Executing task ${task.id} (run #${runNumber}): ${task.prompt.slice(0, 80)}`);

    // Notify clients that task is starting
    broadcastScheduledTaskNotification(
      isRecurring ? `Recurring task started (run #${runNumber})` : "Scheduled task started",
      task.prompt.slice(0, 200),
      "" // no session ID yet
    );

    try {
      // Verify CWD exists
      if (!fs.existsSync(task.cwd)) {
        task.status = "failed";
        task.error = `Directory not found: ${task.cwd}`;
        saveScheduledTask(task);
        broadcastScheduledTaskList();
        broadcastScheduledTaskNotification("Scheduled task failed", task.error, "");
        continue;
      }

      // Determine if we should resume an existing session
      const shouldResume = task.reuseSession && task.sessionId;

      // Create headless session (same pattern as /continue endpoint)
      const ws = { readyState: WebSocket.CLOSED, send: () => {} } as any;
      const session = new ClaudeSession(ws, task.cwd, plugins);
      session.onActivity = () => scheduleBroadcast();

      // If reusing session, set the resume ID so SDK continues that session
      if (shouldResume) {
        (session as any)._resumeSessionId = task.sessionId;
        console.log(`[Scheduler] Reusing session ${task.sessionId}`);
      }

      const tempId = `scheduled-${task.id}`;
      activeSessions.set(tempId, session);

      // Track this run
      const currentRun: import("./scheduled-task-store").TaskRun = {
        sessionId: "", // will be filled in
        startedAt: new Date().toISOString(),
        status: "running",
      };

      // Poll for real session ID
      const registerInterval = setInterval(() => {
        const sid = session.getSessionId();
        if (sid && sid !== tempId) {
          clearInterval(registerInterval);
          activeSessions.delete(tempId);
          activeSessions.set(sid, session);
          task.sessionId = sid;
          currentRun.sessionId = sid;
          saveScheduledTask(task);
          broadcastSessionList();
        }
      }, 500);
      setTimeout(() => clearInterval(registerInterval), 30000);

      // Use resumeSessionId for session reuse, otherwise undefined for new session
      const resumeId = shouldResume ? task.sessionId : undefined;

      session.runQuery(task.prompt, resumeId).then(() => {
        clearInterval(registerInterval);
        const sid = session.getSessionId() || tempId;
        task.sessionId = sid;
        currentRun.sessionId = sid;
        currentRun.completedAt = new Date().toISOString();
        currentRun.status = "completed";
        currentRun.resultSummary = (session as any)._lastPreview || "Task completed";

        task.resultSummary = currentRun.resultSummary;
        task.runCount = runNumber;
        task.lastRunAt = new Date().toISOString();
        if (!task.runs) task.runs = [];
        task.runs.push(currentRun);

        if (activeSessions.get(sid) === session) activeSessions.delete(sid);
        if (activeSessions.get(tempId) === session) activeSessions.delete(tempId);

        // For recurring tasks, schedule the next run
        if (isRecurring) {
          const nextTime = getNextRunTime(task);
          if (nextTime) {
            task.status = "pending";
            task.scheduledTime = nextTime;
            task.error = undefined;
            console.log(`[Scheduler] Task ${task.id} next run at ${nextTime}`);
          } else {
            task.status = "completed";
          }
        } else {
          task.status = "completed";
        }
        saveScheduledTask(task);

        broadcastScheduledTaskList();
        broadcastSessionList();
        broadcastScheduledTaskNotification(
          isRecurring ? `Recurring task complete (run #${runNumber})` : "Scheduled task complete",
          task.resultSummary || task.prompt.slice(0, 200),
          task.sessionId || ""
        );
        console.log(`[Scheduler] Task ${task.id} run #${runNumber} completed, session ${sid}`);
      }).catch((err) => {
        clearInterval(registerInterval);
        const sid = session.getSessionId() || tempId;
        task.sessionId = sid !== tempId ? sid : undefined;
        currentRun.sessionId = sid !== tempId ? sid : "";
        currentRun.completedAt = new Date().toISOString();
        currentRun.status = "failed";
        currentRun.error = err.message || "Unknown error";

        task.error = currentRun.error;
        task.runCount = runNumber;
        task.lastRunAt = new Date().toISOString();
        if (!task.runs) task.runs = [];
        task.runs.push(currentRun);

        activeSessions.delete(tempId);
        if (sid !== tempId) activeSessions.delete(sid);

        // For recurring tasks, still schedule next run even if this one failed
        if (isRecurring) {
          const nextTime = getNextRunTime(task);
          if (nextTime) {
            task.status = "pending";
            task.scheduledTime = nextTime;
            console.log(`[Scheduler] Task ${task.id} failed but rescheduled for ${nextTime}`);
          } else {
            task.status = "failed";
          }
        } else {
          task.status = "failed";
        }
        saveScheduledTask(task);

        broadcastScheduledTaskList();
        broadcastScheduledTaskNotification(
          isRecurring ? `Recurring task failed (run #${runNumber})` : "Scheduled task failed",
          currentRun.error || task.prompt.slice(0, 200),
          task.sessionId || ""
        );
        console.error(`[Scheduler] Task ${task.id} run #${runNumber} failed: ${err.message}`);
      });

    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      saveScheduledTask(task);
      broadcastScheduledTaskList();
      broadcastScheduledTaskNotification("Scheduled task failed", task.error!, "");
    }
  }
}

setInterval(checkScheduledTasks, SCHEDULER_INTERVAL);
// Also run once on startup to catch overdue tasks
setTimeout(checkScheduledTasks, 5000);

// ── Direct WebSocket connections ──
wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected (authenticated)");
  connectedClients.add(ws);

  // Send immediate status so the app knows server state right away
  sendStatusSyncTo(ws);

  const handler = createConnectionHandler(ws);

  ws.on("message", async (data: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      await handler.handleMessage(msg);
    } catch (err: any) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: err.message || "Server error",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    connectedClients.delete(ws);
    // Clean up session client mapping for this connection
    if (handler.activeSessionId) {
      const client = sessionClients.get(handler.activeSessionId);
      if (client && client.ws === ws) {
        sessionClients.delete(handler.activeSessionId);
      }
    }
    // DON'T abort — let the session keep running in the background
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ── Relay client setup ──
function startRelayClient(): void {
  const keysPath = path.join(
    process.env.HOME || require("os").homedir(),
    ".claude-assistant",
    "relay-keys.json"
  );
  const keyPair = loadOrCreateKeyPair(keysPath);
  const pubkeyBase64 = toBase64(keyPair.publicKey);

  console.log(`[Relay] Connecting to ${RELAY_URL}`);
  console.log(`[Relay] Pairing token: ${PAIRING_TOKEN}`);

  // Display QR code for pairing (format: SC|<token>|<pubkey>)
  const qrPayload = `SC|${PAIRING_TOKEN}|${pubkeyBase64}`;

  try {
    const qrcode = require("qrcode-terminal");
    console.log(`\n[Relay] Scan this QR code with SocketClaude app to pair:\n`);
    qrcode.generate(qrPayload, { small: true }, (qr: string) => {
      console.log(qr);
    });
  } catch {
    console.log(`[Relay] QR payload (paste into app): ${qrPayload}`);
  }

  relayClient = new RelayClient({
    relayUrl: RELAY_URL,
    pairingToken: PAIRING_TOKEN,
    keyPair,
    onMessage: (msg: ClientMessage) => {
      if (!relayConnectionHandler) {
        // Create handler on first message (phone just paired)
        relayConnectionHandler = createConnectionHandler(relayClient!.getVirtualSocket() as any);
        console.log(`[Relay] Created connection handler for phone`);
      }
      relayConnectionHandler.handleMessage(msg).catch((err: any) => {
        console.error(`[Relay] Message handler error: ${err.message}`);
        relayConnectionHandler?.sendJson({
          type: "error",
          message: err.message || "Server error",
        });
      });
    },
    onStatusChange: (status: RelayStatus) => {
      console.log(`[Relay] Status: ${status}`);
      if (status === "paired") {
        // Reset handler when phone reconnects so it gets a fresh state
        relayConnectionHandler = createConnectionHandler(relayClient!.getVirtualSocket() as any);
        console.log(`[Relay] Phone paired — ready for messages`);
      }
      if (status === "waiting_for_peer" || status === "disconnected") {
        relayConnectionHandler = null;
      }
    },
  });

  relayClient.connect();
}

// ── Auto-update from git ──
const AUTO_UPDATE_INTERVAL = 60000; // Check every 60s
const SERVER_DIR = path.resolve(__dirname, ".."); // server/ directory

function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const GIT_ROOT = findGitRoot(SERVER_DIR);

async function checkForUpdates(): Promise<void> {
  if (!GIT_ROOT) return;
  try {
    const { execSync } = require("child_process");

    // Fetch latest from origin
    execSync("git fetch origin", { cwd: GIT_ROOT, stdio: "pipe", timeout: 30000 });

    // Get current branch name
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

    // Compare local vs remote
    const local = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
    let remote: string;
    try {
      remote = execSync(`git rev-parse origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
    } catch {
      return; // No remote tracking branch
    }

    if (local === remote) return; // Already up to date

    // Check if any sessions are actively running
    for (const [, session] of activeSessions) {
      if (session.isRunning) {
        console.log(`[Auto-update] Update available (${local.substring(0, 7)} → ${remote.substring(0, 7)}) but sessions are running, deferring...`);
        return;
      }
    }

    console.log(`[Auto-update] Updating ${local.substring(0, 7)} → ${remote.substring(0, 7)}...`);

    // Pull
    execSync(`git pull origin ${branch}`, { cwd: GIT_ROOT, stdio: "pipe", timeout: 60000 });

    // Compile TypeScript — find the server dir (could be repo root or server/ subdir)
    const tscDir = fs.existsSync(path.join(GIT_ROOT, "server", "tsconfig.json"))
      ? path.join(GIT_ROOT, "server")
      : GIT_ROOT;
    execSync("npx tsc", { cwd: tscDir, stdio: "pipe", timeout: 120000 });

    console.log(`[Auto-update] Compiled successfully, restarting...`);

    // Exit with non-zero so systemd Restart=on-failure triggers a restart.
    // exit(0) is clean and won't restart. Windows batch loops check for any exit.
    process.exit(1);
  } catch (e: any) {
    console.error(`[Auto-update] Error: ${e.message}`);
  }
}

if (GIT_ROOT) {
  console.log(`[Auto-update] Watching git repo at ${GIT_ROOT} (every ${AUTO_UPDATE_INTERVAL / 1000}s)`);
  setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
} else {
  console.log(`[Auto-update] No git repo found, auto-update disabled`);
}

// Graceful shutdown — clean up plugins, relay, and watchers
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, cleaning up...`);
    if (relayClient) relayClient.close();
    for (const [, watcher] of desktopWatchers) {
      watcher.stop();
    }
    desktopWatchers.clear();
    for (const plugin of plugins) {
      if (plugin.cleanup) {
        try { await plugin.cleanup(); } catch {}
      }
    }
    process.exit(0);
  });
}
