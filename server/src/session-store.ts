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

// ── Recent CWDs (persisted per-server) ──

const RECENT_CWDS_FILE = path.join(STORE_DIR, "recent-cwds.json");
const MAX_RECENT_CWDS = 20;

function readRecentCwds(): string[] {
  ensureStoreDir();
  if (!fs.existsSync(RECENT_CWDS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RECENT_CWDS_FILE, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function writeRecentCwds(cwds: string[]): void {
  ensureStoreDir();
  fs.writeFileSync(RECENT_CWDS_FILE, JSON.stringify(cwds, null, 2), "utf-8");
}

export function getRecentCwds(): string[] {
  return readRecentCwds();
}

export function addRecentCwd(cwd: string): string[] {
  const cwds = readRecentCwds().filter(c => c !== cwd);
  cwds.unshift(cwd);
  if (cwds.length > MAX_RECENT_CWDS) cwds.length = MAX_RECENT_CWDS;
  writeRecentCwds(cwds);
  return cwds;
}

export function removeRecentCwd(cwd: string): string[] {
  const cwds = readRecentCwds().filter(c => c !== cwd);
  writeRecentCwds(cwds);
  return cwds;
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

export function updateSessionContextUsage(id: string, contextUsage: any): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === id);
  if (session) {
    (session as any).lastContextUsage = contextUsage;
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

// Sessions whose user-uuid backfill has already run this process lifetime.
// Re-running is harmless but doubles the disk reads — once per restart is enough.
const _backfilledSessions = new Set<string>();

/**
 * Locate the Claude Code JSONL transcript for a session without needing the cwd.
 * Scans ~/.claude/projects/* for `<sessionId>.jsonl` and returns the first match.
 */
function findJsonlForSession(sessionId: string): string | undefined {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return undefined;
  let projects: string[];
  try { projects = fs.readdirSync(projectsRoot); } catch { return undefined; }
  for (const proj of projects) {
    const p = path.join(projectsRoot, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Extract plain text from a Claude Code JSONL user message's content field. */
function extractJsonlUserText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

/**
 * Backfill UUIDs onto user history entries that pre-date self-assigned UUIDs.
 * Reads the Claude Code JSONL transcript for the session and matches user
 * entries by content in order. Idempotent: if no entries are missing UUIDs,
 * the JSONL is never read.
 */
export function backfillUserUuids(sessionId: string): void {
  if (_backfilledSessions.has(sessionId)) return;
  _backfilledSessions.add(sessionId);

  ensureHistoryDir();
  const file = historyFile(sessionId);
  if (!fs.existsSync(file)) return;

  let entries: HistoryEntry[];
  try { entries = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return; }

  const missingIdx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].role === "user" && !entries[i].uuid) missingIdx.push(i);
  }
  if (missingIdx.length === 0) return;

  const jsonlPath = findJsonlForSession(sessionId);
  if (!jsonlPath) return;

  // Pull user prompts from the JSONL in order. Skip entries that don't carry a
  // uuid (queue-operation rows etc.) and synthetic tool_result echoes.
  const jsonlUsers: { uuid: string; text: string }[] = [];
  try {
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== "user" || !row.uuid || !row.message) continue;
      const text = extractJsonlUserText(row.message.content);
      if (!text) continue;
      jsonlUsers.push({ uuid: row.uuid, text });
    }
  } catch { return; }

  if (jsonlUsers.length === 0) return;

  // Don't reuse UUIDs that other history entries already claim.
  const usedUuids = new Set<string>();
  for (const e of entries) {
    if (e.role === "user" && e.uuid) usedUuids.add(e.uuid);
  }
  const available = jsonlUsers.filter(j => !usedUuids.has(j.uuid));

  // Match in order, but a missing entry that can't be found doesn't stop the
  // rest of the run. The cursor only advances when we consume an entry.
  let cursor = 0;
  let changed = false;
  for (const idx of missingIdx) {
    const histText = entries[idx].content || "";
    let found = -1;
    for (let j = cursor; j < available.length; j++) {
      if (available[j].text === histText) { found = j; break; }
    }
    if (found >= 0) {
      entries[idx].uuid = available[found].uuid;
      cursor = found + 1;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
    console.log(`[Backfill] Restored UUIDs for ${sessionId} (${missingIdx.length} candidate entries)`);
  }
}

/** Assign UUID to the most recent user history entry (for rewind support) */
export function assignUserUuid(sessionId: string, uuid: string): void {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  if (!fs.existsSync(file)) return;
  try {
    const entries: HistoryEntry[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Walk backwards to find the most recent user entry without a uuid
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "user" && !entries[i].uuid) {
        entries[i].uuid = uuid;
        fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
        return;
      }
    }
  } catch {}
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
  // Recover UUIDs on user prompts saved before self-assigned UUIDs (Apr 22 →
  // Apr 27). Once-per-process and a no-op when nothing's missing.
  backfillUserUuids(sessionId);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/**
 * Get the last prompt suggestion stored in session history.
 * Returns the suggestion string, or undefined if none exists.
 */
export function getLastPromptSuggestion(sessionId: string): string | undefined {
  const all = getHistory(sessionId);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === "prompt_suggestion") {
      return all[i].content;
    }
  }
  return undefined;
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

/**
 * Get history page that includes at least back to the user's most recent prompt.
 * Ensures the app has enough context to render subagent tasks properly.
 */
export function getHistoryPageToLastPrompt(
  sessionId: string,
  minEntries: number = 50
): { entries: HistoryEntry[]; total: number; offset: number } {
  const all = getHistory(sessionId);
  const total = all.length;
  if (total === 0) {
    return { entries: [], total: 0, offset: 0 };
  }

  // Default start: last minEntries
  let start = Math.max(0, total - minEntries);

  // Find the last user message and ensure we include it
  for (let i = total - 1; i >= 0; i--) {
    if (all[i].role === "user") {
      start = Math.min(start, i);
      break;
    }
  }

  return { entries: all.slice(start), total, offset: start };
}

/**
 * Truncate history at a specific user message UUID.
 * Keeps all entries up to and including the entry with the given UUID.
 * Returns the number of entries removed, or -1 if UUID not found.
 */
export function truncateHistoryAtMessage(
  sessionId: string,
  userMessageUuid: string
): { removed: number; kept: number } {
  const all = getHistory(sessionId);
  // Find the index of the user message with this UUID
  const idx = all.findIndex(
    (e) => e.uuid === userMessageUuid && e.role === "user"
  );
  if (idx === -1) {
    // Try matching any role with this UUID (user_uuid entries store UUID differently)
    const altIdx = all.findIndex((e) => e.uuid === userMessageUuid);
    if (altIdx === -1) return { removed: -1, kept: all.length };
    const kept = all.slice(0, altIdx + 1);
    const removed = all.length - kept.length;
    const file = historyFile(sessionId);
    fs.writeFileSync(file, JSON.stringify(kept, null, 2), "utf-8");
    return { removed, kept: kept.length };
  }
  const kept = all.slice(0, idx + 1);
  const removed = all.length - kept.length;
  const file = historyFile(sessionId);
  fs.writeFileSync(file, JSON.stringify(kept, null, 2), "utf-8");
  return { removed, kept: kept.length };
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

/** Sanitize CWD to match the SDK's project directory naming convention.
 *  Works on both Unix (/home/user/code) and Windows (C:\Users\user\code) paths. */
function sanitizeCwdToProjectDir(cwd: string): string {
  let dir = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (dir.length > 200) {
    let hash = 0;
    for (let i = 0; i < cwd.length; i++) {
      hash = (hash << 5) - hash + cwd.charCodeAt(i);
      hash |= 0;
    }
    dir = dir.slice(0, 200) + "-" + Math.abs(hash).toString(36);
  }
  return dir;
}

/** Build the path to Claude Code's JSONL session file */
export function getJsonlPath(sessionId: string, cwd: string): string {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectDir = sanitizeCwdToProjectDir(cwd);
  return path.join(homeDir, ".claude", "projects", projectDir, `${sessionId}.jsonl`);
}

/** Get the timestamp of the last entry in a session's history */
export function getLastHistoryTimestamp(sessionId: string): string {
  const history = getHistory(sessionId);
  return history.length > 0 ? history[history.length - 1].timestamp : "";
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
  const jsonlPath = getJsonlPath(sessionId, cwd);

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
            } else if (block.type === "text") {
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

// ── SDK event history (separate JSONL files per session) ──

const SDK_EVENTS_DIR = path.join(STORE_DIR, "sdk-events");

function ensureSdkEventsDir(): void {
  if (!fs.existsSync(SDK_EVENTS_DIR)) {
    fs.mkdirSync(SDK_EVENTS_DIR, { recursive: true });
  }
}

function sdkEventsFile(sessionId: string): string {
  return path.join(SDK_EVENTS_DIR, `${sessionId}.jsonl`);
}

/** Append a single SDK event to the session's JSONL file */
export function appendSdkEvent(sessionId: string, event: Record<string, any>): void {
  ensureSdkEventsDir();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(sdkEventsFile(sessionId), line, "utf-8");
}

/** Read all SDK events for a session */
export function getSdkEvents(sessionId: string): Record<string, any>[] {
  ensureSdkEventsDir();
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as Record<string, any>[];
  } catch {
    return [];
  }
}

/** Get SDK event count for a session (for deciding whether to send) */
export function getSdkEventCount(sessionId: string): number {
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return 0;
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
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
  const jsonlPath = getJsonlPath(sessionId, cwd);
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

  // 4. Archive SDK events
  const sdkFile = sdkEventsFile(sessionId);
  if (fs.existsSync(sdkFile)) {
    const archiveName = `${sessionId}_${ts}_sdk-events.jsonl`;
    fs.renameSync(sdkFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived SDK events: ${archiveName}`);
  }

  // 5. Write a metadata sidecar so restore can recover the title/cwd
  // even after the session row has been remapped to a new SDK session id.
  const sessions = readStore();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    const metaName = `${sessionId}_${ts}_meta.json`;
    const meta = {
      sid: sessionId,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      clearedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(ARCHIVE_DIR, metaName), JSON.stringify(meta, null, 2), "utf-8");
    console.log(`[ClearContext] Wrote meta: ${metaName}`);

    // 6. Update session metadata to reflect the clear
    session.messagePreview = "(context cleared)";
    session.lastActive = new Date().toISOString();
    delete (session as any).lastContextUsage;
    writeStore(sessions);
  }
}

export interface ArchiveEntry {
  sid: string;
  ts: string;
  title: string;
  cwd: string;
  createdAt: string;
  clearedAt: string;
  messagePreview: string;
  messageCount: number;
  hasJsonl: boolean;
}

const ARCHIVE_SUFFIXES: Array<[string, string]> = [
  ["_sdk-events.jsonl", "sdk-events"],
  ["_history.json", "history"],
  ["_todos.json", "todos"],
  ["_meta.json", "meta"],
  [".jsonl", "jsonl"],
];

function parseArchiveFilename(name: string): { sid: string; ts: string; kind: string } | null {
  for (const [suffix, kind] of ARCHIVE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      const underscoreIdx = base.lastIndexOf("_");
      if (underscoreIdx < 0) return null;
      return { sid: base.slice(0, underscoreIdx), ts: base.slice(underscoreIdx + 1), kind };
    }
  }
  return null;
}

export function listArchives(): ArchiveEntry[] {
  ensureArchiveDir();
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const files = fs.readdirSync(ARCHIVE_DIR);
  const groups = new Map<string, { sid: string; ts: string; files: Map<string, string> }>();
  for (const f of files) {
    const parsed = parseArchiveFilename(f);
    if (!parsed) continue;
    const key = `${parsed.sid}_${parsed.ts}`;
    let group = groups.get(key);
    if (!group) {
      group = { sid: parsed.sid, ts: parsed.ts, files: new Map() };
      groups.set(key, group);
    }
    group.files.set(parsed.kind, f);
  }

  const entries: ArchiveEntry[] = [];
  for (const group of groups.values()) {
    let title = "";
    let cwd = "";
    let createdAt = "";
    // Timestamp encoding in the archive filename is `toISOString().replace(/[:.]/g, "-")`.
    // Reverse it: the first three dashes after `T` were `:`/`:`/`.` in the original.
    let clearedAt = tsToIso(group.ts);
    const metaName = group.files.get("meta");
    if (metaName) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, metaName), "utf-8"));
        if (typeof meta.title === "string" && meta.title) title = meta.title;
        if (typeof meta.cwd === "string" && meta.cwd) cwd = meta.cwd;
        if (typeof meta.createdAt === "string") createdAt = meta.createdAt;
        if (typeof meta.clearedAt === "string" && meta.clearedAt) clearedAt = meta.clearedAt;
      } catch {}
    }

    let messagePreview = "";
    let messageCount = 0;
    const histName = group.files.get("history");
    if (histName) {
      try {
        const hist = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, histName), "utf-8")) as any[];
        messageCount = Array.isArray(hist) ? hist.length : 0;
        const firstUser = (hist as any[]).find((e) => e.role === "user");
        if (firstUser) messagePreview = String(firstUser.content || "").slice(0, 200);
      } catch {}
    }

    // Title fallback: the session's first user message, trimmed to a single line.
    if (!title && messagePreview) {
      const firstLine = messagePreview.split(/\r?\n/)[0].trim();
      title = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine || "Untitled";
    }
    if (!title) title = "Untitled";

    // cwd fallback: pull from the first line of the archived Claude Code JSONL.
    const jsonlName = group.files.get("jsonl");
    if (!cwd && jsonlName) {
      try {
        const buf = fs.readFileSync(path.join(ARCHIVE_DIR, jsonlName), "utf-8");
        const firstLine = buf.split("\n", 1)[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine);
          if (typeof obj.cwd === "string") cwd = obj.cwd;
        }
      } catch {}
    }

    entries.push({
      sid: group.sid,
      ts: group.ts,
      title,
      cwd,
      createdAt,
      clearedAt,
      messagePreview,
      messageCount,
      hasJsonl: group.files.has("jsonl"),
    });
  }

  return entries.sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));
}

function tsToIso(ts: string): string {
  // `2026-04-22T10-30-45-123Z` → `2026-04-22T10:30:45.123Z`
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)(Z?)$/);
  if (!m) return ts;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}${m[6] || "Z"}`;
}

export function getArchiveHistory(sid: string, ts: string): HistoryEntry[] {
  const p = path.join(ARCHIVE_DIR, `${sid}_${ts}_history.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

export function restoreArchive(sid: string, ts: string): { ok: true; session: SessionInfo } | { ok: false; reason: string } {
  ensureArchiveDir();

  const metaPath = path.join(ARCHIVE_DIR, `${sid}_${ts}_meta.json`);
  const jsonlArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}.jsonl`);
  const histArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_history.json`);
  const todosArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_todos.json`);
  const sdkEventsArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_sdk-events.jsonl`);

  let metaTitle = "";
  let metaCreatedAt = "";
  let cwd = "";
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (typeof meta.title === "string") metaTitle = meta.title;
      if (typeof meta.createdAt === "string") metaCreatedAt = meta.createdAt;
      if (typeof meta.cwd === "string") cwd = meta.cwd;
    } catch {}
  }

  // cwd fallback: first line of the archived JSONL carries the session's cwd.
  if (!cwd && fs.existsSync(jsonlArchive)) {
    try {
      const firstLine = fs.readFileSync(jsonlArchive, "utf-8").split("\n", 1)[0];
      if (firstLine) {
        const obj = JSON.parse(firstLine);
        if (typeof obj.cwd === "string") cwd = obj.cwd;
      }
    } catch {}
  }
  if (!cwd) return { ok: false, reason: "cannot determine cwd for this archive" };

  const liveHist = historyFile(sid);
  const liveJsonl = getJsonlPath(sid, cwd);

  if (fs.existsSync(jsonlArchive)) {
    const destDir = path.dirname(liveJsonl);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(liveJsonl)) fs.unlinkSync(liveJsonl);
    fs.renameSync(jsonlArchive, liveJsonl);
  }
  if (fs.existsSync(histArchive)) {
    ensureHistoryDir();
    if (fs.existsSync(liveHist)) fs.unlinkSync(liveHist);
    fs.renameSync(histArchive, liveHist);
  }
  if (fs.existsSync(todosArchive)) {
    ensureTodosDir();
    const liveTodos = todosFile(sid);
    if (fs.existsSync(liveTodos)) fs.unlinkSync(liveTodos);
    fs.renameSync(todosArchive, liveTodos);
  }
  if (fs.existsSync(sdkEventsArchive)) {
    ensureSdkEventsDir();
    const liveSdkEvents = sdkEventsFile(sid);
    if (fs.existsSync(liveSdkEvents)) fs.unlinkSync(liveSdkEvents);
    fs.renameSync(sdkEventsArchive, liveSdkEvents);
  }
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  const restoredAt = new Date().toISOString();
  let messagePreview = "";
  let titleFallback = "";
  try {
    const hist = JSON.parse(fs.readFileSync(liveHist, "utf-8")) as any[];
    const lastUser = [...hist].reverse().find((e) => e.role === "user");
    if (lastUser) messagePreview = String(lastUser.content || "").slice(0, 200);
    const firstUser = (hist as any[]).find((e) => e.role === "user");
    if (firstUser) {
      const line = String(firstUser.content || "").split(/\r?\n/)[0].trim();
      titleFallback = line.length > 60 ? line.slice(0, 60) + "…" : line;
    }
  } catch {}

  const sessions = readStore();
  const existingIdx = sessions.findIndex((s) => s.id === sid);
  const restored: SessionInfo = {
    id: sid,
    title: metaTitle || titleFallback || "Untitled",
    cwd,
    createdAt: metaCreatedAt || restoredAt,
    lastActive: restoredAt,
    messagePreview,
  };
  if (existingIdx >= 0) {
    sessions[existingIdx] = restored;
  } else {
    sessions.push(restored);
  }
  writeStore(sessions);
  console.log(`[RestoreArchive] Restored ${sid}_${ts} (title="${restored.title}", cwd=${cwd})`);

  return { ok: true, session: restored };
}

export function deleteArchive(sid: string, ts: string): void {
  ensureArchiveDir();
  for (const suffix of [".jsonl", "_history.json", "_todos.json", "_sdk-events.jsonl", "_meta.json"]) {
    const p = path.join(ARCHIVE_DIR, `${sid}_${ts}${suffix}`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[DeleteArchive] Removed ${sid}_${ts}${suffix}`);
    }
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

// ── SDK session discovery ──

export interface SdkSessionEntry {
  sessionId: string;
  firstMessage: string;
  createdAt: string;
  lastActive: string;
  tracked: boolean; // true if already in SocketClaude store
}

/**
 * Build a map of sessionId → last user prompt from ~/.claude/history.jsonl.
 * This file stores every prompt the user sent, with `display`, `sessionId`, and `project`.
 */
function loadPromptHistory(cwd: string): Map<string, string> {
  const homeDir = process.env.HOME || require("os").homedir();
  const historyPath = path.join(homeDir, ".claude", "history.jsonl");
  const map = new Map<string, string>();
  if (!fs.existsSync(historyPath)) return map;

  try {
    const lines = fs.readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      // Match sessions for this project (CWD)
      if (obj.project === cwd && obj.sessionId && obj.display) {
        map.set(obj.sessionId, obj.display); // last prompt wins
      }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * List Claude Code SDK sessions for a given CWD.
 * Scans ~/.claude/projects/-{cwd-sanitized}/ for JSONL files.
 * Uses ~/.claude/history.jsonl for session preview text.
 * Includes both tracked (already in SocketClaude store) and untracked sessions.
 */
export function listSdkSessions(cwd: string, limit = 30): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectDir = sanitizeCwdToProjectDir(cwd);
  const projectPath = path.join(homeDir, ".claude", "projects", projectDir);

  if (!fs.existsSync(projectPath)) return [];

  let files: string[];
  try {
    // Filter out agent-* files (subagent sessions — not independently resumable)
    files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch {
    return [];
  }

  // Build lookup of tracked sessions for this CWD
  const store = readStore();
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of store) {
    if (s.cwd === cwd) trackedMap.set(s.id, s);
  }

  // Load prompt history from ~/.claude/history.jsonl
  const promptHistory = loadPromptHistory(cwd);

  // Sort by mtime, scan more files than the limit since some will be skipped as stubs
  const scanLimit = limit * 5;
  const fileStats = files
    .map(f => {
      try {
        const mtime = fs.statSync(path.join(projectPath, f)).mtimeMs;
        return { file: f, mtime };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b!.mtime - a!.mtime)
    .slice(0, scanLimit) as { file: string; mtime: number }[];

  const results: SdkSessionEntry[] = [];

  for (const { file, mtime } of fileStats) {
    const sessionId = file.replace(".jsonl", "");
    const tracked = trackedMap.get(sessionId);

    // For tracked sessions, use stored preview instead of parsing JSONL
    if (tracked) {
      results.push({
        sessionId,
        firstMessage: tracked.messagePreview || tracked.title || "Untitled",
        createdAt: tracked.createdAt,
        lastActive: tracked.lastActive,
        tracked: true,
      });
      continue;
    }

    // Use prompt history for the preview (last user prompt for this session)
    const promptPreview = promptHistory.get(sessionId);
    if (promptPreview) {
      results.push({
        sessionId,
        firstMessage: promptPreview.slice(0, 200),
        createdAt: new Date(mtime).toISOString(),
        lastActive: new Date(mtime).toISOString(),
        tracked: false,
      });
      continue;
    }

    // Fallback: parse the JSONL for the first real (non-Warmup) user message
    const filePath = path.join(projectPath, file);
    let userMessage = "";

    try {
      const stat = fs.statSync(filePath);
      // Read up to 256KB from the head — the real prompt is usually near the start
      const readSize = Math.min(256 * 1024, stat.size);
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      fs.closeSync(fd);

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === "user" && obj.message?.content) {
          const content = obj.message.content;
          let text = "";
          if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === "text");
            if (textBlock?.text) text = textBlock.text;
          } else if (typeof content === "string") {
            text = content;
          }
          // Skip warmup/internal messages, keep looking
          if (text && !/^\s*Warmup\s*$/i.test(text)) {
            userMessage = text.slice(0, 200);
            break;
          }
        }
      }
    } catch { /* ignore */ }

    // Skip sessions with no discoverable user message (true stubs)
    if (!userMessage) continue;

    results.push({
      sessionId,
      firstMessage: userMessage,
      createdAt: new Date(mtime).toISOString(),
      lastActive: new Date(mtime).toISOString(),
      tracked: false,
    });

    // Stop once we have enough results
    if (results.length >= limit) break;
  }

  return results;
}
