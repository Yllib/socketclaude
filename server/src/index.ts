import * as dotenv from "dotenv";
dotenv.config({ path: require("path").join(__dirname, "..", ".env") });

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { ClaudeSession } from "./claude-session";
import { listSessions, getSession, getHistory, getHistoryPage, deleteSession, clearSessionContext, cleanupPendingToolCalls, getTodos, getMissedMessages, appendHistory } from "./session-store";
import { ClientMessage } from "./protocol";
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

// Sessions whose context has been cleared — next query should NOT pass resume
const clearedSessions: Set<string> = new Set();

// Track all connected WebSocket clients for broadcasting
const connectedClients = new Set<WebSocket>();

/** Broadcast current session list to all connected clients */
function broadcastSessionList(): void {
  const sessions = listSessions();
  const enriched = sessions.map(s => {
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
  let pendingTtsEnabled = false;
  let pendingEffort: 'low' | 'medium' | 'high' | 'max' = 'high';
  let pendingThinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };

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
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd,
        });
        break;
      }

      case "resume_session": {
        // Detach old session so it stops sending to this client
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        const sessionInfo = getSession(msg.sessionId);
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
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);

        sendJson({
          type: "session_created",
          sessionId: msg.sessionId,
          cwd: sessionInfo.cwd,
        });

        // Send most recent page of message history (always send, even if empty)
        const page = getHistoryPage(msg.sessionId, 50);
        sendJson({
          type: "session_history",
          sessionId: msg.sessionId,
          messages: page.entries,
          total: page.total,
          offset: page.offset,
        });

        // Check for missed messages from Claude Code's session file
        const allHistory = getHistory(msg.sessionId);
        const lastTimestamp = allHistory.length > 0
          ? allHistory[allHistory.length - 1].timestamp
          : "";
        if (lastTimestamp) {
          const missed = getMissedMessages(msg.sessionId, sessionInfo.cwd, lastTimestamp);
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

        // Send stored todos
        const todos = getTodos(msg.sessionId);
        if (todos.length > 0) {
          sendJson({
            type: "todos",
            sessionId: msg.sessionId,
            todos,
          });
        }

        // Restore last usage data if available
        if ((sessionInfo as any).lastUsage) {
          sendJson({
            type: "usage_restore",
            usage: (sessionInfo as any).lastUsage,
          });
        }

        // Let the client know if the session is still working
        if (existing && existing.isRunning) {
          sendJson({
            type: "status",
            sessionId: msg.sessionId,
            running: true,
          });
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
          console.log(`[Inject] Session running, injecting user message inline`);
          activeSession.injectMessage(msg.text);
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
            activeSessions.delete(sid);
            console.log(`Session ${sid} completed, removed from active pool`);
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
              if (result.handled) { answerHandled = true; break; }
            }
          }
        }
        if (!answerHandled && activeSession) {
          activeSession.resolveQuestion(qId, msg.answers);
        }
        break;
      }

      case "list_sessions": {
        const sessionList = listSessions();
        sendJson({
          type: "session_list",
          sessions: sessionList,
        });
        break;
      }

      case "delete_session": {
        const sid = msg.sessionId;
        const running = activeSessions.get(sid);
        if (running) {
          running.abort();
          activeSessions.delete(sid);
        }
        deleteSession(sid);
        console.log(`Deleted session ${sid}`);
        broadcastSessionList();
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
          clearSessionContext(sid, sessionInfo.cwd);
          clearedSessions.add(sid);
          console.log(`Cleared context for session ${sid}`);
          sendJson({ type: "context_cleared", sessionId: sid });
          broadcastSessionList();
        }
        break;
      }

      case "abort": {
        if (activeSession) {
          console.log(`Aborting active session`);
          activeSession.abort();
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

      case "stop_task": {
        const taskId = (msg as any).taskId as string;
        console.log(`[stop_task] received: taskId=${taskId} activeSession=${!!activeSession}`);
        if (activeSession && taskId) {
          activeSession.stopTask(taskId).catch(e => console.error(`[stop_task] error: ${e}`));
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
        activeSession.setEffort(pendingEffort);
        activeSession.setThinking(pendingThinking);
        activeSession.setForkSource(sourceId);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd: sessionInfo.cwd,
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
        const fileName = msg.fileName;
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

  return { handleMessage, sendJson, sendRaw };
}

const httpServer = http.createServer((req, res) => {
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

// ── Direct WebSocket connections ──
wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected (authenticated)");
  connectedClients.add(ws);

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

  // Display QR code for pairing
  const qrPayload = JSON.stringify({
    relay: RELAY_URL,
    token: PAIRING_TOKEN,
    pubkey: pubkeyBase64,
  });

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

// Graceful shutdown — clean up plugins and relay
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, cleaning up...`);
    if (relayClient) relayClient.close();
    for (const plugin of plugins) {
      if (plugin.cleanup) {
        try { await plugin.cleanup(); } catch {}
      }
    }
    process.exit(0);
  });
}
