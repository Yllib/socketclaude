import * as fs from "fs";
import * as path from "path";
import { SessionInfo, HistoryEntry } from "./protocol";

const STORE_DIR = path.join(
  process.env.HOME || require("os").homedir(),
  ".claude-assistant"
);
const STORE_FILE = path.join(STORE_DIR, "sessions.json");
const HISTORY_DIR = path.join(STORE_DIR, "history");

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readStore(): SessionInfo[] {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(STORE_FILE, "utf-8");
  return JSON.parse(raw) as SessionInfo[];
}

function writeStore(sessions: SessionInfo[]): void {
  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(sessions, null, 2), "utf-8");
}

export function listSessions(): SessionInfo[] {
  return readStore().sort(
    (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
  );
}

export function saveSession(session: SessionInfo): void {
  const sessions = readStore();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  writeStore(sessions);
}

export function getSession(id: string): SessionInfo | undefined {
  return readStore().find((s) => s.id === id);
}

export function deleteSession(id: string): void {
  const sessions = readStore().filter((s) => s.id !== id);
  writeStore(sessions);
}

/** Remap a session entry from oldId to newId (after context clear creates a fresh SDK session) */
export function remapSession(oldId: string, newId: string): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === oldId);
  if (session) {
    session.id = newId;
    session.lastActive = new Date().toISOString();
    writeStore(sessions);
    console.log(`[Remap] Session ${oldId} → ${newId}`);
  }
}

export function updateSessionActivity(
  id: string,
  messagePreview: string,
  lastUsage?: any
): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === id);
  if (session) {
    session.lastActive = new Date().toISOString();
    session.messagePreview = messagePreview.slice(0, 200);
    if (lastUsage) {
      (session as any).lastUsage = lastUsage;
    }
    writeStore(sessions);
  }
}

// ── Message history per session ──

function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function historyFile(sessionId: string): string {
  return path.join(HISTORY_DIR, `${sessionId}.json`);
}

export function appendHistory(sessionId: string, entry: HistoryEntry): void {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  let entries: HistoryEntry[] = [];
  if (fs.existsSync(file)) {
    entries = JSON.parse(fs.readFileSync(file, "utf-8"));
  }
  entries.push(entry);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
}

/** Mark a question entry as answered in the history file */
export function markQuestionAnswered(sessionId: string, questionId: string): void {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  if (!fs.existsSync(file)) return;
  try {
    const entries: HistoryEntry[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    const entry = entries.find(
      (e) => e.role === "question" && e.questionId === questionId
    );
    if (entry) {
      entry.answered = true;
      fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
    }
  } catch (e) {
    console.error(`[History] Error marking question answered: ${e}`);
  }
}

export function getHistory(sessionId: string): HistoryEntry[] {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  if (!fs.existsSync(file)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/**
 * Get a page of history entries.
 * Returns the most recent `limit` entries by default, or entries starting at `offset`.
 * offset is 0-based from the start (oldest) of the array.
 */
export function getHistoryPage(
  sessionId: string,
  limit: number,
  offset?: number
): { entries: HistoryEntry[]; total: number; offset: number } {
  const all = getHistory(sessionId);
  const total = all.length;
  if (total === 0) {
    return { entries: [], total: 0, offset: 0 };
  }

  let start: number;
  if (offset !== undefined) {
    start = Math.max(0, offset);
  } else {
    // Default: last `limit` entries
    start = Math.max(0, total - limit);
  }
  const end = Math.min(start + limit, total);
  return { entries: all.slice(start, end), total, offset: start };
}

// ── Per-session todo list ──

const TODOS_DIR = path.join(STORE_DIR, "todos");

function ensureTodosDir(): void {
  if (!fs.existsSync(TODOS_DIR)) {
    fs.mkdirSync(TODOS_DIR, { recursive: true });
  }
}

function todosFile(sessionId: string): string {
  return path.join(TODOS_DIR, `${sessionId}.json`);
}

export function saveTodos(sessionId: string, todos: any[]): void {
  ensureTodosDir();
  fs.writeFileSync(todosFile(sessionId), JSON.stringify(todos, null, 2), "utf-8");
}

export function getTodos(sessionId: string): any[] {
  ensureTodosDir();
  const file = todosFile(sessionId);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * Read missed messages from Claude Code's own session JSONL file.
 * Returns HistoryEntry[] for messages that occurred after `afterTimestamp`.
 * This fills gaps when the server was down but Claude kept working.
 */
export function getMissedMessages(
  sessionId: string,
  cwd: string,
  afterTimestamp: string
): HistoryEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  // Claude Code stores sessions in ~/.claude/projects/<cwd-with-dashes>/
  const projectDir = cwd.replace(/^\//, "").replace(/\//g, "-");
  const jsonlPath = path.join(homeDir, ".claude", "projects", `-${projectDir}`, `${sessionId}.jsonl`);

  if (!fs.existsSync(jsonlPath)) return [];

  const afterTime = new Date(afterTimestamp).getTime();
  const entries: HistoryEntry[] = [];

  try {
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);

    for (const line of lines) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      // Skip messages before our cutoff
      if (!msg.timestamp) continue;
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime <= afterTime) continue;

      // Convert to our HistoryEntry format
      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        // Extract text
        const textParts = Array.isArray(content)
          ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : "";
        if (textParts) {
          entries.push({
            role: "assistant",
            content: textParts,
            timestamp: msg.timestamp,
          });
        }
        // Extract tool calls
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              entries.push({
                role: "tool_call",
                content: "",
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
                timestamp: msg.timestamp,
              });
            }
          }
        }
      } else if (msg.type === "user" && msg.message?.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const output = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : "";
              entries.push({
                role: "tool_result",
                content: "",
                toolUseId: block.tool_use_id || "",
                toolOutput: output.slice(0, 2000), // Truncate large outputs
                timestamp: msg.timestamp,
              });
            } else if (block.type === "text" && msg.userType === "external") {
              entries.push({
                role: "user",
                content: block.text,
                timestamp: msg.timestamp,
              });
            }
          }
        } else if (typeof content === "string") {
          entries.push({
            role: "user",
            content,
            timestamp: msg.timestamp,
          });
        }
      }
    }
  } catch (e) {
    console.error(`[MissedMessages] Error reading JSONL: ${e}`);
  }

  return entries;
}

const ARCHIVE_DIR = path.join(STORE_DIR, "archive");

function ensureArchiveDir(): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * Clear context for a session: archive Claude Code's JSONL, our history, and todos.
 * The session metadata (sessions.json) is preserved so it still shows in the list.
 * Archived files get a timestamp suffix so multiple clears don't overwrite.
 */
export function clearSessionContext(sessionId: string, cwd: string): void {
  ensureArchiveDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // 1. Archive Claude Code's JSONL session file
  const homeDir = process.env.HOME || require("os").homedir();
  const projectDir = cwd.replace(/^\//, "").replace(/\//g, "-");
  const jsonlPath = path.join(homeDir, ".claude", "projects", `-${projectDir}`, `${sessionId}.jsonl`);
  if (fs.existsSync(jsonlPath)) {
    const archiveName = `${sessionId}_${ts}.jsonl`;
    fs.renameSync(jsonlPath, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived JSONL: ${archiveName}`);
  }

  // 2. Archive our chat history
  const histFile = historyFile(sessionId);
  if (fs.existsSync(histFile)) {
    const archiveName = `${sessionId}_${ts}_history.json`;
    fs.renameSync(histFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived history: ${archiveName}`);
  }

  // 3. Archive todos
  const todoFile = todosFile(sessionId);
  if (fs.existsSync(todoFile)) {
    const archiveName = `${sessionId}_${ts}_todos.json`;
    fs.renameSync(todoFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived todos: ${archiveName}`);
  }

  // 4. Update session metadata to reflect the clear
  const sessions = readStore();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    session.messagePreview = "(context cleared)";
    session.lastActive = new Date().toISOString();
    writeStore(sessions);
  }
}

/** On startup, close out any tool_calls that never got a result (e.g. server crashed mid-query) */
export function cleanupPendingToolCalls(): void {
  ensureHistoryDir();
  if (!fs.existsSync(HISTORY_DIR)) return;

  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const filePath = path.join(HISTORY_DIR, file);
    let entries: HistoryEntry[];
    try {
      entries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }

    // Collect all tool_use_ids that have results
    const resultIds = new Set(
      entries
        .filter((e) => e.role === "tool_result" && e.toolUseId)
        .map((e) => e.toolUseId!)
    );

    // Add empty results for any tool_calls missing them
    let modified = false;
    for (const entry of entries) {
      if (entry.role === "tool_call" && entry.toolUseId && !resultIds.has(entry.toolUseId)) {
        entries.push({
          role: "tool_result",
          content: "",
          toolUseId: entry.toolUseId,
          toolOutput: "",
          timestamp: new Date().toISOString(),
        });
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
      console.log(`Cleaned up pending tool calls in ${file}`);
    }
  }
}
