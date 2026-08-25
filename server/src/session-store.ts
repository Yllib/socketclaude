import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { execFileSync } from "child_process";
import { listSessions as sdkListSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionSettings, Backend, SessionInfo, HistoryEntry } from "./protocol";
import { CodexAppServerClient, type CodexAppServerThreadListParams } from "./codex-app-server-client";
import { codexAppServerThreadToHistory, codexRolloutJsonlToHistory } from "./codex-native-history";
import { buildCodexSpawn } from "./codex-env";
import { redactSecretsDeep } from "./secure-input-store";
import { socketAgentDataPath } from "./socket-agent-paths";
import { remapHtmlPlans } from "./html-plan-store";
import { createInteractiveRequestId } from "./interactive-request-id";
import { repairTranscriptIdentityCollisions, sameLogicalTranscriptEntry } from "./transcript-repair";
import { deleteSendFileDelivery } from "./send-file-store";
import {
  TranscriptDatabase,
  type TranscriptLegacyFingerprint,
  type TranscriptSearchHit,
  transcriptDatabase,
} from "./transcript-database";

const STORE_DIR = socketAgentDataPath();
const STORE_FILE = path.join(STORE_DIR, "sessions.json");
const HISTORY_DIR = path.join(STORE_DIR, "history");
const TOOL_OUTPUT_DIR = path.join(STORE_DIR, "tool-output");
const TOOL_IMAGE_CACHE_DIR = path.join(STORE_DIR, "tool-images");
const ARCHIVED_SESSION_IDS_FILE = path.join(STORE_DIR, "archived-session-ids.json");
const TRANSCRIPT_IDENTITY_REPAIR_MARKER = path.join(STORE_DIR, ".transcript-identity-repair-v1");
const HISTORY_IO_WARN_MS = Number(process.env.SOCKETAGENT_HISTORY_IO_WARN_MS || 500);
const HISTORY_PAGE_WARN_MS = Number(process.env.SOCKETAGENT_HISTORY_PAGE_WARN_MS || 250);
const SESSION_LIST_WARN_MS = Number(process.env.SOCKETAGENT_SESSION_LIST_WARN_MS || 500);
const TOOL_OUTPUT_BLOB_THRESHOLD = Number(process.env.SOCKETAGENT_TOOL_OUTPUT_BLOB_THRESHOLD || 8 * 1024);
const TOOL_OUTPUT_PREVIEW_CHARS = Number(process.env.SOCKETAGENT_TOOL_OUTPUT_PREVIEW_CHARS || 1024);
const HISTORY_COMPACT_MIN_BYTES = Number(process.env.SOCKETAGENT_HISTORY_COMPACT_MIN_BYTES || 8 * 1024 * 1024);
const configuredToolImageCacheTtl = Number(process.env.SOCKETAGENT_TOOL_IMAGE_CACHE_TTL_MS);
const TOOL_IMAGE_CACHE_TTL_MS = Math.max(
  30 * 60 * 1000,
  Number.isFinite(configuredToolImageCacheTtl)
    ? configuredToolImageCacheTtl
    : 60 * 60 * 1000,
);
let lastToolImageCacheCleanupAt = 0;

function toolImageExtension(mimeType: string, sourcePath = ""): string {
  const sourceExt = path.extname(sourcePath).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|bmp|svg)$/.test(sourceExt)) return sourceExt;
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    case "image/svg+xml": return ".svg";
    default: return ".png";
  }
}

function cleanupToolImageCache(nowMs = Date.now()): void {
  if (nowMs - lastToolImageCacheCleanupAt < 5 * 60 * 1000) return;
  lastToolImageCacheCleanupAt = nowMs;
  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(TOOL_IMAGE_CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;
    const dirPath = path.join(TOOL_IMAGE_CACHE_DIR, sessionDir.name);
    let files: fs.Dirent[];
    try { files = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile()) continue;
      const filePath = path.join(dirPath, file.name);
      try {
        if (nowMs - fs.statSync(filePath).mtimeMs >= TOOL_IMAGE_CACHE_TTL_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
    try {
      if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
    } catch {}
  }
}

export function cacheToolImage(
  sessionId: string,
  toolUseId: string,
  bytes: Buffer,
  mimeType: string,
  sourcePath = "",
): string {
  cleanupToolImageCache();
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeToolUseId = toolUseId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160)
    || crypto.createHash("sha256").update(toolUseId).digest("hex").slice(0, 32);
  const sessionDir = path.join(TOOL_IMAGE_CACHE_DIR, safeSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const cachePath = path.join(
    sessionDir,
    `${safeToolUseId}${toolImageExtension(mimeType, sourcePath)}`,
  );
  fs.writeFileSync(cachePath, bytes, { mode: 0o600 });
  return cachePath;
}

function warnIfSlow(label: string, startedAt: number, details: Record<string, unknown> = {}): void {
  const elapsedMs = Date.now() - startedAt;
  const threshold = label.startsWith("history_page") ? HISTORY_PAGE_WARN_MS
    : label.startsWith("session_list") ? SESSION_LIST_WARN_MS
      : HISTORY_IO_WARN_MS;
  if (elapsedMs < threshold) return;
  const suffix = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.warn(`[Perf] ${label} ms=${elapsedMs}${suffix ? ` ${suffix}` : ""}`);
}

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

export function updateSessionAgentSettings(id: string, patch: Partial<AgentSessionSettings>): void {
  const sessions = readStore();
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.agentSettings = {
    ...(session.agentSettings || {}),
    ...patch,
  };
  writeStore(sessions);
}

/** Clear a transferred handoff only after the destination accepted it. */
export function clearSessionPendingHandoffContext(id: string): void {
  const sessions = readStore();
  const session = sessions.find((entry) => entry.id === id);
  if (!session?.pendingHandoffContext) return;
  delete session.pendingHandoffContext;
  writeStore(sessions);
}

export function deleteSession(id: string): void {
  const sessions = readStore().filter((s) => s.id !== id);
  writeStore(sessions);
}

function readArchivedSessionIds(): Set<string> {
  ensureStoreDir();
  if (!fs.existsSync(ARCHIVED_SESSION_IDS_FILE)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(ARCHIVED_SESSION_IDS_FILE, "utf-8"));
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id) => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

function writeArchivedSessionIds(ids: Set<string>): void {
  ensureStoreDir();
  fs.writeFileSync(
    ARCHIVED_SESSION_IDS_FILE,
    JSON.stringify([...ids].sort(), null, 2),
    "utf-8",
  );
}

export function markSessionArchived(sessionId: string): void {
  if (!sessionId) return;
  const ids = readArchivedSessionIds();
  ids.add(sessionId);
  writeArchivedSessionIds(ids);
  invalidateCodexNativeListCache();
}

export function unmarkSessionArchived(sessionId: string): void {
  if (!sessionId) return;
  const ids = readArchivedSessionIds();
  if (!ids.delete(sessionId)) return;
  writeArchivedSessionIds(ids);
  invalidateCodexNativeListCache();
}

export interface DeleteSessionArtifactsResult {
  removed: string[];
  warnings: string[];
}

function unlinkIfExists(filePath: string | undefined, removed: string[], label = "file"): void {
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;
    fs.unlinkSync(filePath);
    removed.push(`${label}:${filePath}`);
  } catch (err: any) {
    throw new Error(`Failed to delete ${label} ${filePath}: ${err?.message || String(err)}`);
  }
}

function rmDirIfExists(dirPath: string | undefined, removed: string[], label = "dir"): void {
  if (!dirPath) return;
  try {
    if (!fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
    removed.push(`${label}:${dirPath}`);
  } catch (err: any) {
    throw new Error(`Failed to delete ${label} ${dirPath}: ${err?.message || String(err)}`);
  }
}

function deleteCodexThreadState(sessionId: string, removed: string[], warnings: string[]): void {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return;
  const sql = `DELETE FROM threads WHERE id = ${sqlStringLiteral(sessionId)};`;
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    removed.push(`codex-thread:${sessionId}`);
  } catch (err: any) {
    warnings.push(`Failed to delete Codex thread state for ${sessionId}: ${err?.message || String(err)}`);
  }
}

export function deleteSessionArtifacts(sessionId: string, sessionInfo?: SessionInfo): DeleteSessionArtifactsResult {
  const removed: string[] = [];
  const warnings: string[] = [];
  const info = sessionInfo || getSession(sessionId) || getCodexThreadSessionInfo(sessionId) || undefined;
  const backend = info?.backend;

  // SendFile cards own immutable snapshots so their downloads survive source
  // rebuilds and deletions. Remove those snapshots only when the session itself
  // is permanently deleted.
  try {
    for (const entry of readHistoryEntries(sessionId)) {
      if (entry.fileDeliveryPath) deleteSendFileDelivery(entry.fileDeliveryPath);
    }
  } catch (error: any) {
    warnings.push(`Failed to delete sent-file snapshots: ${error?.message || String(error)}`);
  }

  unlinkIfExists(historyFile(sessionId), removed, "history");
  unlinkIfExists(historyBackupFile(sessionId), removed, "history-backup");
  if (historyDatabase().hasSession(sessionId)) {
    historyDatabase().deleteSession(sessionId);
    removed.push(`transcript-database:${sessionId}`);
  }
  try {
    for (const fileName of fs.readdirSync(HISTORY_DIR)) {
      if (fileName.startsWith(`${sessionId}.json.corrupt-`)
          || fileName.startsWith(`${sessionId}.json.bak.corrupt-`)) {
        unlinkIfExists(path.join(HISTORY_DIR, fileName), removed, "history-corrupt");
      }
    }
  } catch {}
  historyCache.delete(sessionId);
  transcriptPositionStates.delete(sessionId);
  rmDirIfExists(toolOutputSessionDir(sessionId), removed, "tool-output");
  unlinkIfExists(todosFile(sessionId), removed, "todos");
  discardPendingSdkEvents(sessionId);
  unlinkIfExists(sdkEventsFile(sessionId), removed, "sdk-events");

  if (backend === "codex" || (!backend && !!getCodexThreadSessionInfo(sessionId))) {
    const rolloutPath = findCodexRolloutFile(sessionId);
    unlinkIfExists(rolloutPath || undefined, removed, "codex-rollout");
    deleteCodexThreadState(sessionId, removed, warnings);
  }

  if (backend === "claude" || !backend) {
    const cwdPath = info?.cwd ? getJsonlPath(sessionId, info.cwd) : undefined;
    unlinkIfExists(cwdPath, removed, "claude-jsonl");
    const discoveredPath = findJsonlForSession(sessionId);
    if (discoveredPath && discoveredPath !== cwdPath) {
      unlinkIfExists(discoveredPath, removed, "claude-jsonl");
    }
  }

  deleteSession(sessionId);
  return { removed, warnings };
}

/** Remap a session entry from oldId to newId (after context clear creates a fresh SDK session) */
export function remapSession(oldId: string, newId: string): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === oldId);
  if (session) {
    const oldHistory = historyFile(oldId);
    const newHistory = historyFile(newId);
    const oldHistoryBackup = historyBackupFile(oldId);
    ensureHistoryDatabaseSession(oldId);
    const hasOldHistory = historyDatabase().count(oldId) > 0;
    const hasNewHistory = historyDatabase().hasSession(newId)
      && historyDatabase().count(newId) > 0;
    if (hasOldHistory && !hasNewHistory) {
      const oldImageDir = path.join(
        TOOL_IMAGE_CACHE_DIR,
        oldId.replace(/[^A-Za-z0-9_-]/g, "_"),
      );
      const newImageDir = path.join(
        TOOL_IMAGE_CACHE_DIR,
        newId.replace(/[^A-Za-z0-9_-]/g, "_"),
      );
      const oldToolOutputDir = toolOutputSessionDir(oldId);
      const newToolOutputDir = toolOutputSessionDir(newId);
      let movedImages = false;
      let movedToolOutput = false;
      if (fs.existsSync(oldImageDir) && !fs.existsSync(newImageDir)) {
        fs.mkdirSync(path.dirname(newImageDir), { recursive: true });
        fs.renameSync(oldImageDir, newImageDir);
        movedImages = true;
      }
      if (fs.existsSync(oldToolOutputDir) && !fs.existsSync(newToolOutputDir)) {
        fs.mkdirSync(path.dirname(newToolOutputDir), { recursive: true });
        fs.renameSync(oldToolOutputDir, newToolOutputDir);
        movedToolOutput = true;
      }
      try {
        historyDatabase().remapSession(oldId, newId, {
          ...(movedImages ? {
            filePathPrefix: { from: oldImageDir + path.sep, to: newImageDir + path.sep },
          } : {}),
          ...(movedToolOutput ? {
            toolOutputRefPrefix: { from: `${oldId}/`, to: `${newId}/` },
          } : {}),
        });
      } catch (error) {
        if (movedImages && !fs.existsSync(oldImageDir)) fs.renameSync(newImageDir, oldImageDir);
        if (movedToolOutput && !fs.existsSync(oldToolOutputDir)) {
          fs.renameSync(newToolOutputDir, oldToolOutputDir);
        }
        throw error;
      }
      fs.rmSync(oldHistory, { force: true });
      fs.rmSync(oldHistoryBackup, { force: true });
    }
    historyCache.delete(oldId);
    historyCache.delete(newId);
    transcriptPositionStates.delete(oldId);
    transcriptPositionStates.delete(newId);

    const oldTodos = todosFile(oldId);
    const newTodos = todosFile(newId);
    if (fs.existsSync(oldTodos) && !fs.existsSync(newTodos)) {
      ensureTodosDir();
      fs.renameSync(oldTodos, newTodos);
    }

    const oldSdkEvents = sdkEventsFile(oldId);
    const newSdkEvents = sdkEventsFile(newId);
    flushSdkEventQueue(oldId);
    if (fs.existsSync(oldSdkEvents) && !fs.existsSync(newSdkEvents)) {
      ensureSdkEventsDir();
      fs.renameSync(oldSdkEvents, newSdkEvents);
    }

    session.id = newId;
    session.replacedSessionIds = [
      ...new Set([...(session.replacedSessionIds || []), oldId]),
    ];
    delete (session as any).contextClearedAt;
    session.lastActive = new Date().toISOString();
    writeStore(sessions);
    remapHtmlPlans(oldId, newId);
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
    session.messagePreview = cleanPreviewText(messagePreview);
    session.turnCount = normalizedTurnCount(session.turnCount) ?? 0;
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

function historyBackupFile(sessionId: string): string {
  return `${historyFile(sessionId)}.bak`;
}

function toolOutputSessionDir(sessionId: string): string {
  const root = path.resolve(TOOL_OUTPUT_DIR);
  const resolved = path.resolve(TOOL_OUTPUT_DIR, sessionId);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid tool output session id: ${sessionId}`);
  }
  return resolved;
}

function ensureToolOutputDir(sessionId?: string): string {
  const dir = sessionId ? toolOutputSessionDir(sessionId) : TOOL_OUTPUT_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeBlobSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.slice(0, 80) || "entry";
}

function toolOutputBlobRef(sessionId: string, entry: HistoryEntry, index: number, output: string): string {
  const idPart = sanitizeBlobSegment(entry.toolUseId || `${entry.role}-${index}`);
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(entry.toolUseId || "")
    .update("\0")
    .update(entry.timestamp || "")
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(output)
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}/${idPart}-${hash}.txt.gz`;
}

function toolOutputBlobPath(ref: string | undefined): string | null {
  if (!ref) return null;
  const root = path.resolve(TOOL_OUTPUT_DIR);
  const resolved = path.resolve(TOOL_OUTPUT_DIR, ref);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function writeToolOutputBlob(sessionId: string, entry: HistoryEntry, index: number, output: string): {
  ref: string;
  bytes: number;
  storedBytes: number;
} {
  const ref = toolOutputBlobRef(sessionId, entry, index, output);
  const file = toolOutputBlobPath(ref);
  if (!file) throw new Error(`Invalid tool output blob ref for ${sessionId}`);
  ensureToolOutputDir(sessionId);
  if (!fs.existsSync(file)) {
    const compressed = zlib.gzipSync(Buffer.from(output, "utf8"));
    fs.writeFileSync(file, compressed);
  }
  const stat = fs.statSync(file);
  return {
    ref,
    bytes: Buffer.byteLength(output, "utf8"),
    storedBytes: stat.size,
  };
}

function readToolOutputBlob(entry: HistoryEntry): string | undefined {
  const file = toolOutputBlobPath(entry.toolOutputRef);
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file);
    return entry.toolOutputEncoding === "gzip"
      ? zlib.gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
  } catch (err: any) {
    console.warn(`[HistoryBlob] Failed to read ${entry.toolOutputRef}: ${err?.message || String(err)}`);
    return undefined;
  }
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return { ...entry, toolInput: entry.toolInput ? { ...entry.toolInput } : entry.toolInput };
}

function compactHistoryEntryForStorage(sessionId: string, entry: HistoryEntry, index: number): HistoryEntry {
  const compacted = cloneHistoryEntry(entry);
  if (compacted.role !== "tool_result") return compacted;
  if (compacted.toolOutputRef && typeof compacted.toolOutput !== "string") {
    const preview = (compacted.toolOutputPreview || compacted.content || "").slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
    compacted.content = preview;
    compacted.toolOutputPreview = preview;
    return compacted;
  }

  const output = typeof compacted.toolOutput === "string"
    ? compacted.toolOutput
    : typeof compacted.content === "string"
      ? compacted.content
      : "";

  if (!output) {
    delete compacted.toolOutputRef;
    delete compacted.toolOutputBytes;
    delete compacted.toolOutputStoredBytes;
    delete compacted.toolOutputPreview;
    delete compacted.toolOutputEncoding;
    return compacted;
  }

  if (Buffer.byteLength(output, "utf8") <= TOOL_OUTPUT_BLOB_THRESHOLD) {
    compacted.toolOutput = output;
    compacted.content = typeof compacted.content === "string" ? compacted.content : output;
    delete compacted.toolOutputRef;
    delete compacted.toolOutputBytes;
    delete compacted.toolOutputStoredBytes;
    delete compacted.toolOutputPreview;
    delete compacted.toolOutputEncoding;
    return compacted;
  }

  const blob = writeToolOutputBlob(sessionId, compacted, index, output);
  compacted.content = output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  compacted.toolOutputPreview = compacted.content;
  compacted.toolOutputRef = blob.ref;
  compacted.toolOutputBytes = blob.bytes;
  compacted.toolOutputStoredBytes = blob.storedBytes;
  compacted.toolOutputEncoding = "gzip";
  delete compacted.toolOutput;
  return compacted;
}

function hydrateHistoryEntry(entry: HistoryEntry): HistoryEntry {
  const hydrated = cloneHistoryEntry(entry);
  if (entry.role === "tool_result" && typeof entry.toolOutput !== "string" && entry.toolOutputRef) {
    hydrated.toolOutput = readToolOutputBlob(entry) ?? entry.toolOutputPreview ?? entry.content ?? "";
  }
  return hydrated;
}

function hydrateHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(hydrateHistoryEntry);
}

type HistoryCacheEntry = {
  entries: HistoryEntry[];
};

const historyCache = new Map<string, HistoryCacheEntry>();

function historyDatabase(): TranscriptDatabase {
  ensureHistoryDir();
  return transcriptDatabase();
}

type TranscriptPosition = {
  entryId: string;
  sessionSeq: number;
  revision: number;
};

type TranscriptPositionState = {
  nextSeq: number;
  byKey: Map<string, TranscriptPosition>;
  byEntryId: Map<string, TranscriptPosition>;
};

const transcriptPositionStates = new Map<string, TranscriptPositionState>();

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function historyPositionKey(entry: HistoryEntry): string | null {
  if (entry.streamId) {
    const streamRole = entry.thinking ? `${entry.role}_thinking` : entry.role;
    return `${streamRole}:stream:${entry.streamId}`;
  }
  if (entry.toolUseId && (entry.role === "tool_call" || entry.role === "tool_result" || entry.role === "tool_image")) {
    return `${entry.role}:tool:${entry.toolUseId}`;
  }
  if (entry.questionId) return `${entry.role}:question:${entry.questionId}`;
  if (entry.role === "user" && entry.uuid) return `user:uuid:${entry.uuid}`;
  if (entry.role === "monitor" && entry.taskId) return `monitor:${entry.taskId}`;
  if (entry.role === "task_state" && entry.taskId) {
    return `task_state:${entry.taskKind || "background"}:${entry.taskId}`;
  }
  if (entry.role === "work_review" && entry.reviewId) {
    return `work_review:${entry.reviewId}`;
  }
  return null;
}

function serverMessagePositionKey(message: Record<string, any>): string | null {
  const type = String(message.type || "");
  if ((type === "text" || type === "thinking") && message.streamId) {
    const role = type === "text" ? "assistant" : "assistant_thinking";
    return `${role}:stream:${String(message.streamId)}`;
  }
  if ((type === "tool_call" || type === "tool_result" || type === "tool_image") && message.toolUseId) {
    const role = type === "tool_call" ? "tool_call" : type === "tool_result" ? "tool_result" : "tool_image";
    return `${role}:tool:${String(message.toolUseId)}`;
  }
  const questionId = message.questionId || message.requestId;
  if (questionId && (type === "question" || type === "secure_input_request" || type === "elicitation_url")) {
    const role = type === "secure_input_request" ? "secure_input" : type === "elicitation_url" ? "elicitation_url" : "question";
    return `${role}:question:${String(questionId)}`;
  }
  if (type === "monitor_output" && message.taskId) return `monitor:${String(message.taskId)}`;
  if (type === "work_review_card" && message.reviewId) {
    return `work_review:${String(message.reviewId)}`;
  }
  return null;
}

function syncTranscriptPositionState(sessionId: string, entries: HistoryEntry[]): TranscriptPositionState {
  let state = transcriptPositionStates.get(sessionId);
  if (!state) {
    state = { nextSeq: 1, byKey: new Map(), byEntryId: new Map() };
    transcriptPositionStates.set(sessionId, state);
  }

  // Legacy histories have no durable positions. Migrate the whole snapshot in
  // physical order once, rather than mixing newly allocated positions with
  // array indexes. Once positions exist, preserve them exactly: concurrent
  // streams can finish and be persisted in a different order from the order
  // in which their first live frames were allocated.
  const needsMigration = entries.some((entry) =>
    !entry.entryId || positiveInteger(entry.sessionSeq) === null,
  );
  let maxSeq = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const sessionSeq = needsMigration
      ? index + 1
      : positiveInteger(entry.sessionSeq)!;
    entry.sessionSeq = sessionSeq;
    entry.entryId ||= `history:${sessionSeq}`;
    entry.revision = positiveInteger(entry.revision) || 1;
    maxSeq = Math.max(maxSeq, sessionSeq);

    const position: TranscriptPosition = {
      entryId: entry.entryId,
      sessionSeq,
      revision: entry.revision,
    };
    state.byEntryId.set(position.entryId, position);
    const key = historyPositionKey(entry);
    if (key) state.byKey.set(key, position);
  }
  state.nextSeq = Math.max(state.nextSeq, maxSeq + 1);
  return state;
}

function transcriptPositionState(sessionId: string): TranscriptPositionState {
  const existing = transcriptPositionStates.get(sessionId);
  if (existing) return existing;
  ensureHistoryDatabaseSession(sessionId);
  const state: TranscriptPositionState = {
    nextSeq: historyDatabase().maxSessionSeq(sessionId) + 1,
    byKey: new Map(),
    byEntryId: new Map(),
  };
  transcriptPositionStates.set(sessionId, state);
  return state;
}

function reserveTranscriptPosition(
  sessionId: string,
  key: string | null,
  entryId?: string,
  sessionSeq?: number,
): TranscriptPosition {
  const state = transcriptPositionState(sessionId);
  const knownById = entryId ? state.byEntryId.get(entryId) : undefined;
  const knownInMemory = knownById || (key ? state.byKey.get(key) : undefined);
  const stored = knownInMemory
    ? undefined
    : historyDatabase().findPosition(sessionId, entryId, key);
  const known = knownInMemory || (stored
    ? {
        entryId: stored.entryId,
        sessionSeq: stored.sessionSeq,
        revision: stored.revision,
      }
    : undefined);
  if (known) {
    state.byEntryId.set(known.entryId, known);
    if (key) state.byKey.set(key, known);
  }
  if (known) return known;

  const reservedSeq = positiveInteger(sessionSeq) || state.nextSeq++;
  state.nextSeq = Math.max(state.nextSeq, reservedSeq + 1);
  const position: TranscriptPosition = {
    entryId: entryId || crypto.randomUUID(),
    sessionSeq: reservedSeq,
    revision: 0,
  };
  state.byEntryId.set(position.entryId, position);
  if (key) state.byKey.set(key, position);
  return position;
}

/** Assign a durable transcript identity before the first live frame is sent. */
export function positionSessionMessage<T extends Record<string, any>>(sessionId: string, message: T): T {
  if (!sessionId) return message;
  const mutable = message as Record<string, any>;
  const key = serverMessagePositionKey(mutable);
  if (!key && !mutable.entryId) return message;
  const position = reserveTranscriptPosition(sessionId, key, mutable.entryId, mutable.sessionSeq);
  if (!positiveInteger(mutable.revision)) position.revision++;
  mutable.entryId = position.entryId;
  mutable.sessionSeq = position.sessionSeq;
  mutable.revision = positiveInteger(mutable.revision) || Math.max(1, position.revision);
  return message;
}

function positionHistoryEntry(sessionId: string, entry: HistoryEntry): HistoryEntry {
  const key = historyPositionKey(entry);
  const position = reserveTranscriptPosition(sessionId, key, entry.entryId, entry.sessionSeq);
  if (positiveInteger(entry.revision)) {
    position.revision = Math.max(position.revision, entry.revision!);
  } else if (position.revision === 0) {
    position.revision = 1;
  }
  entry.entryId = position.entryId;
  entry.sessionSeq = position.sessionSeq;
  entry.revision = Math.max(1, position.revision);
  return entry;
}

function isSendFileCall(entry: HistoryEntry): boolean {
  if (entry.role !== "tool_call") return false;
  const name = String(entry.toolName || "");
  return name === "SendFile" || name.endsWith("__SendFile");
}

function sendFilePath(entry: HistoryEntry): string {
  return String(entry.toolInput?.file_path || "");
}

function visibleToolTimestampsMatch(first: HistoryEntry, second: HistoryEntry): boolean {
  const firstMs = Date.parse(first.timestamp || "");
  const secondMs = Date.parse(second.timestamp || "");
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return true;
  return Math.abs(firstMs - secondMs) <= 2_500;
}

function isSpeakCall(entry: HistoryEntry): boolean {
  if (entry.role !== "tool_call") return false;
  const name = String(entry.toolName || "");
  return name === "Speak" || name.endsWith("__Speak") || name.endsWith("/Speak");
}

function speakText(entry: HistoryEntry): string {
  return String(entry.toolInput?.text || "");
}

/** Remove the old handler-generated Speak pair beside its canonical call. */
export function normalizeSpeakHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const normalized = entries.map(cloneHistoryEntry);
  const removedIndexes = new Set<number>();
  const removedToolUseIds = new Set<string>();

  for (let canonicalIndex = 0; canonicalIndex < normalized.length; canonicalIndex++) {
    const canonical = normalized[canonicalIndex];
    const canonicalId = String(canonical.toolUseId || "");
    const text = speakText(canonical);
    if (!isSpeakCall(canonical)
      || !canonicalId
      || canonicalId.startsWith("mcp_Speak_")
      || !text) continue;

    const start = Math.max(0, canonicalIndex - 4);
    const end = Math.min(normalized.length - 1, canonicalIndex + 4);
    for (let syntheticIndex = start; syntheticIndex <= end; syntheticIndex++) {
      if (syntheticIndex === canonicalIndex) continue;
      const synthetic = normalized[syntheticIndex];
      const syntheticId = String(synthetic.toolUseId || "");
      if (!isSpeakCall(synthetic)
        || !syntheticId.startsWith("mcp_Speak_")
        || speakText(synthetic) !== text
        || !visibleToolTimestampsMatch(canonical, synthetic)) continue;

      removedIndexes.add(syntheticIndex);
      removedToolUseIds.add(syntheticId);
    }
  }

  return normalized.filter((entry, index) =>
    !removedIndexes.has(index)
    && !(entry.role === "tool_result"
      && removedToolUseIds.has(String(entry.toolUseId || ""))),
  );
}

/**
 * Older app-tool handlers wrote a synthetic SendFile pair in addition to the
 * backend's canonical pair. Filter that exact adjacent duplicate before any
 * history paging so the visible copy cannot jump when an offset crosses it.
 */
export function normalizeSendFileHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const normalized = entries.map(cloneHistoryEntry);
  const removedIndexes = new Set<number>();
  const removedToolUseIds = new Set<string>();

  for (let canonicalIndex = 0; canonicalIndex < normalized.length; canonicalIndex++) {
    const canonical = normalized[canonicalIndex];
    const canonicalId = String(canonical.toolUseId || "");
    const filePath = sendFilePath(canonical);
    if (!isSendFileCall(canonical)
      || !canonicalId
      || canonicalId.startsWith("mcp_SendFile_")
      || !filePath) continue;

    const start = Math.max(0, canonicalIndex - 4);
    const end = Math.min(normalized.length - 1, canonicalIndex + 4);
    for (let syntheticIndex = start; syntheticIndex <= end; syntheticIndex++) {
      if (syntheticIndex === canonicalIndex) continue;
      const synthetic = normalized[syntheticIndex];
      const syntheticId = String(synthetic.toolUseId || "");
      if (!isSendFileCall(synthetic)
        || !syntheticId.startsWith("mcp_SendFile_")
        || sendFilePath(synthetic) !== filePath
        || !visibleToolTimestampsMatch(canonical, synthetic)) continue;

      canonical.fileId ??= synthetic.fileId;
      canonical.fileName ??= synthetic.fileName;
      canonical.fileSize ??= synthetic.fileSize;
      canonical.fileVersion ??= synthetic.fileVersion;
      canonical.fileDeliveryPath ??= synthetic.fileDeliveryPath;
      removedIndexes.add(syntheticIndex);
      removedToolUseIds.add(syntheticId);
    }
  }

  return normalized.filter((entry, index) =>
    !removedIndexes.has(index)
    && !(entry.role === "tool_result"
      && removedToolUseIds.has(String(entry.toolUseId || ""))),
  );
}

/**
 * SocketAgent 1.0.198 briefly classified the start frame of ordinary
 * agentMessage and plan items as future schema items. Remove those diagnostic
 * calls (and any matching result) while reading history. The real assistant
 * message/plan entry remains authoritative.
 */
export function normalizeMisclassifiedCodexItemEntries(
  entries: HistoryEntry[],
): HistoryEntry[] {
  const removedToolUseIds = new Set<string>();
  for (const entry of entries) {
    const itemType = String(entry.toolInput?.itemType || "");
    if (entry.role === "tool_call"
      && entry.toolName === "CodexItem"
      && entry.toolInput?._codexItemType === "unrecognized"
      && (itemType === "agentMessage" || itemType === "plan")) {
      const toolUseId = String(entry.toolUseId || "");
      if (toolUseId) removedToolUseIds.add(toolUseId);
    }
  }
  return entries
    .filter((entry) =>
      !(entry.role === "tool_call"
        && removedToolUseIds.has(String(entry.toolUseId || "")))
      && !(entry.role === "tool_result"
        && removedToolUseIds.has(String(entry.toolUseId || ""))))
    .map(cloneHistoryEntry);
}

/**
 * SocketAgent-native tools already have dedicated app cards. Version 1.0.198
 * attached generic Codex MCP metadata to them, which could take precedence
 * over FileCard, SpeakCard, ReminderCard, and MonitorToolCard. Strip only that
 * presentation metadata while preserving the tool arguments and result.
 */
export function normalizeSocketAgentAppToolEntries(
  entries: HistoryEntry[],
): HistoryEntry[] {
  const removedToolUseIds = new Set<string>();
  const normalized = entries.map((rawEntry) => {
    const entry = cloneHistoryEntry(rawEntry);
    const input = entry.toolInput;
    const server = String(input?._codexServer || "");
    const rawName = String(entry.toolName || "");
    const appTool = String(input?._codexTool || "")
      || (rawName.endsWith("__NotifyUser")
        || rawName.endsWith("/NotifyUser")
        || rawName === "NotifyUser"
        ? "NotifyUser"
        : "");
    if (entry.role === "tool_call" && appTool === "NotifyUser") {
      const toolUseId = String(entry.toolUseId || "");
      if (toolUseId) removedToolUseIds.add(toolUseId);
    }
    if (entry.role === "tool_call"
      && (server === "socketagent_app" || server === "socketagent-app")
      && input?._codexItemType === "mcpToolCall") {
      delete input._codexItemType;
      delete input._codexServer;
      delete input._codexTool;
      delete input._codexAppContext;
      delete input._codexPluginId;
    }
    return entry;
  });
  return normalized.filter((entry) =>
    !removedToolUseIds.has(String(entry.toolUseId || "")),
  );
}

function assistantDuplicateTimestampsMatch(first: HistoryEntry, second: HistoryEntry): boolean {
  const firstMs = Date.parse(first.timestamp || "");
  const secondMs = Date.parse(second.timestamp || "");
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return false;
  return Math.abs(firstMs - secondMs) <= 2_500;
}

/**
 * Older Claude result handling persisted the completed assistant message and
 * then an UUID-less copy from the final result event. Collapse only that exact
 * adjacent shape so historical paging and previews use one canonical entry.
 */
export function normalizeClaudeResultFallbackHistoryEntries(
  entries: HistoryEntry[],
): HistoryEntry[] {
  const normalized: HistoryEntry[] = [];
  for (const rawEntry of entries) {
    const entry = cloneHistoryEntry(rawEntry);
    const previous = normalized.at(-1);
    const isExactFallbackDuplicate = previous?.role === "assistant"
      && entry.role === "assistant"
      && !previous.thinking
      && !entry.thinking
      && Boolean(previous.content)
      && previous.content === entry.content
      && (previous.parentToolUseId || null) === (entry.parentToolUseId || null)
      && Boolean(previous.uuid) !== Boolean(entry.uuid)
      && assistantDuplicateTimestampsMatch(previous, entry);

    if (!isExactFallbackDuplicate) {
      normalized.push(entry);
      continue;
    }

    // Prefer the SDK assistant event because its UUID is stable across replay.
    if (!previous?.uuid && entry.uuid) normalized[normalized.length - 1] = entry;
  }
  return normalized;
}

function parseHistorySnapshot(file: string): HistoryEntry[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`History snapshot is not an array: ${file}`);
  }
  return normalizeClaudeResultFallbackHistoryEntries(
    normalizeSocketAgentAppToolEntries(
      normalizeMisclassifiedCodexItemEntries(
        normalizeSpeakHistoryEntries(
          normalizeSendFileHistoryEntries(parsed as HistoryEntry[]),
        ),
      ),
    ),
  );
}

function quarantineCorruptHistoryFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const quarantined = `${file}.corrupt-${Date.now()}-${process.pid}`;
  fs.renameSync(file, quarantined);
  return quarantined;
}

function recoverCorruptHistory(
  sessionId: string,
  file: string,
  originalError: unknown,
): HistoryEntry[] {
  historyCache.delete(sessionId);
  transcriptPositionStates.delete(sessionId);
  const backup = historyBackupFile(sessionId);

  if (fs.existsSync(backup)) {
    let backupEntries: HistoryEntry[] | undefined;
    try {
      backupEntries = parseHistorySnapshot(backup);
    } catch (backupError: any) {
      const quarantinedBackup = quarantineCorruptHistoryFile(backup);
      console.error(
        `[HistoryRecovery] Invalid backup session=${sessionId}`
        + ` quarantined=${quarantinedBackup || "none"}`
        + ` error=${backupError?.message || String(backupError)}`,
      );
    }
    if (backupEntries) {
      const quarantined = quarantineCorruptHistoryFile(file);
      syncTranscriptPositionState(sessionId, backupEntries);
      const safeEntries = safeHistoryEntriesForStorage(sessionId, backupEntries);
      historyDatabase().replace(
        sessionId,
        safeEntries.map((entry) => ({ entry, positionKey: historyPositionKey(entry) })),
        legacyHistoryFingerprint(backup),
      );
      historyCache.set(sessionId, { entries: safeEntries });
      console.warn(
        `[HistoryRecovery] Restored backup session=${sessionId}`
        + ` entries=${backupEntries.length} quarantined=${quarantined || "none"}`,
      );
      return safeEntries;
    }
  }

  const session = getSession(sessionId);
  if (session?.backend === "claude" && session.cwd) {
    const nativeEntries = getMissedMessages(
      sessionId,
      session.cwd,
      new Date(0).toISOString(),
    );
    if (nativeEntries.length > 0) {
      const quarantined = quarantineCorruptHistoryFile(file);
      syncTranscriptPositionState(sessionId, nativeEntries);
      const safeEntries = safeHistoryEntriesForStorage(sessionId, nativeEntries);
      historyDatabase().replace(
        sessionId,
        safeEntries.map((entry) => ({ entry, positionKey: historyPositionKey(entry) })),
      );
      historyCache.set(sessionId, { entries: safeEntries });
      console.warn(
        `[HistoryRecovery] Rebuilt from Claude transcript session=${sessionId}`
        + ` entries=${nativeEntries.length} quarantined=${quarantined || "none"}`,
      );
      return safeEntries;
    }
  }

  throw originalError;
}

function legacyHistoryFingerprint(file: string): TranscriptLegacyFingerprint {
  const stat = fs.statSync(file);
  return { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
}

function safeHistoryEntriesForStorage(
  sessionId: string,
  entries: HistoryEntry[],
  dirtyEntries?: Set<HistoryEntry>,
): HistoryEntry[] {
  const positioned = entries
    .map((entry, originalIndex) => ({
      entry: positionHistoryEntry(sessionId, entry),
      originalIndex,
    }))
    .sort((left, right) =>
      (left.entry.sessionSeq! - right.entry.sessionSeq!)
      || (left.originalIndex - right.originalIndex),
    )
    .map(({ entry }) => entry);
  return dirtyEntries
    ? positioned.map((entry, index) => dirtyEntries.has(entry)
      ? compactHistoryEntryForStorage(sessionId, redactSecretsDeep(entry), index)
      : entry)
    : (redactSecretsDeep(positioned) as HistoryEntry[])
      .map((entry, index) => compactHistoryEntryForStorage(sessionId, entry, index));
}

/** Lazily import a legacy JSON snapshot, retaining the snapshot as a rollback backup. */
function ensureHistoryDatabaseSession(sessionId: string): void {
  ensureHistoryDir();
  const database = historyDatabase();
  const current = historyFile(sessionId);
  const backup = historyBackupFile(sessionId);
  const source = fs.existsSync(current) ? current : fs.existsSync(backup) ? backup : undefined;

  if (!source) {
    if (!database.hasSession(sessionId)) database.replace(sessionId, []);
    return;
  }

  const fingerprint = legacyHistoryFingerprint(source);
  if (database.legacyMatches(sessionId, fingerprint)) return;

  let legacyEntries: HistoryEntry[];
  try {
    legacyEntries = parseHistorySnapshot(source);
  } catch (error) {
    // A successfully migrated database is authoritative if its retained JSON
    // backup is later damaged. Only invoke legacy recovery before migration.
    if (database.hasSession(sessionId)) {
      console.warn(`[HistoryMigration] Ignoring damaged retained snapshot session=${sessionId}`);
      return;
    }
    recoverCorruptHistory(sessionId, source, error);
    return;
  }

  const repair = repairTranscriptIdentityCollisions(legacyEntries);
  transcriptPositionStates.delete(sessionId);
  let combined = repair.entries;
  if (database.hasSession(sessionId)) {
    // This path handles a temporary rollback to an older SocketAgent build:
    // merge newly written JSON rows back into the WAL store without dropping
    // database-only history.
    const existing = database.getAll(sessionId);
    const byEntryId = new Map(existing.map((entry) => [entry.entryId, entry]));
    for (const legacyEntry of repair.entries) {
      const prior = legacyEntry.entryId ? byEntryId.get(legacyEntry.entryId) : undefined;
      if (!prior || Number(legacyEntry.revision || 1) >= Number(prior.revision || 1)) {
        if (legacyEntry.entryId) byEntryId.set(legacyEntry.entryId, legacyEntry);
      }
    }
    combined = [...byEntryId.values()];
  }
  syncTranscriptPositionState(sessionId, combined);
  const safeEntries = safeHistoryEntriesForStorage(sessionId, combined);
  database.replace(
    sessionId,
    safeEntries.map((entry) => ({ entry, positionKey: historyPositionKey(entry) })),
    fingerprint,
  );
  historyCache.delete(sessionId);
  transcriptPositionStates.delete(sessionId);
  console.log(
    `[HistoryMigration] session=${sessionId} entries=${safeEntries.length}`
    + ` sourceMb=${(fingerprint.size / 1024 / 1024).toFixed(1)}`
    + ` repaired=${repair.changed}`,
  );
}

function readHistoryEntries(sessionId: string, options: { backfillUserUuids?: boolean } = {}): HistoryEntry[] {
  const startedAt = Date.now();
  ensureHistoryDatabaseSession(sessionId);

  if (options.backfillUserUuids) {
    backfillUserUuids(sessionId);
  }

  const cached = historyCache.get(sessionId);
  if (cached) return cached.entries;

  const entries = historyDatabase().getAll(sessionId);
  syncTranscriptPositionState(sessionId, entries);
  historyCache.set(sessionId, { entries });
  warnIfSlow("history_read", startedAt, {
    sessionId,
    entries: entries.length,
  });
  return entries;
}

function cleanPreviewText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function latestHistoryTimestamp(entries: HistoryEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const timestamp = entries[i]?.timestamp;
    if (timestamp && Number.isFinite(Date.parse(timestamp))) return timestamp;
  }
  return undefined;
}

function latestConversationPreviewFromEntries(entries: HistoryEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = cleanPreviewText(entry.content);
    if (text) return text;
  }
  return "";
}

function conversationTurnCountFromEntries(entries: HistoryEntry[]): number {
  return entries.reduce((count, entry) => {
    if (entry.role !== "user") return count;
    return cleanPreviewText(entry.content) ? count + 1 : count;
  }, 0);
}

function updateSessionHistoryMetadata(sessionId: string, entries: HistoryEntry[]): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const preview = latestConversationPreviewFromEntries(entries);
  if (preview) session.messagePreview = preview;
  session.turnCount = conversationTurnCountFromEntries(entries);
  (session as any).historyCount = entries.length;

  const latestTimestamp = latestHistoryTimestamp(entries);
  if (latestTimestamp) {
    const currentMs = Date.parse(session.lastActive);
    const latestMs = Date.parse(latestTimestamp);
    if (!Number.isFinite(currentMs) || (Number.isFinite(latestMs) && latestMs > currentMs)) {
      session.lastActive = latestTimestamp;
    }
  }

  writeStore(sessions);
}

function updateSessionHistoryMetadataFromDatabase(sessionId: string): void {
  const summary = historyDatabase().summary(sessionId);
  if (!summary) return;
  const sessions = readStore();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  if (summary.messagePreview) session.messagePreview = summary.messagePreview;
  session.turnCount = summary.userPromptCount;
  (session as any).historyCount = summary.entryCount;
  if (summary.latestTimestamp) {
    const currentMs = Date.parse(session.lastActive);
    const latestMs = Date.parse(summary.latestTimestamp);
    if (!Number.isFinite(currentMs) || (Number.isFinite(latestMs) && latestMs > currentMs)) {
      session.lastActive = summary.latestTimestamp;
    }
  }
  writeStore(sessions);
}

function normalizedTurnCount(value: unknown): number | undefined {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return undefined;
  return Math.floor(count);
}

function withCachedTurnCount(session: SessionInfo): SessionInfo {
  return {
    ...session,
    turnCount: normalizedTurnCount((session as any).turnCount) ?? 0,
    historyCount: normalizedTurnCount((session as any).historyCount),
  };
}

function writeHistoryEntries(
  sessionId: string,
  entries: HistoryEntry[],
  options: { dirtyEntries?: Set<HistoryEntry> } = {},
): void {
  const startedAt = Date.now();
  ensureHistoryDatabaseSession(sessionId);
  const safeEntries = safeHistoryEntriesForStorage(sessionId, entries, options.dirtyEntries);
  historyDatabase().replace(
    sessionId,
    safeEntries.map((entry) => ({ entry, positionKey: historyPositionKey(entry) })),
  );
  historyCache.set(sessionId, { entries: safeEntries });
  updateSessionHistoryMetadata(sessionId, safeEntries);
  warnIfSlow("history_write", startedAt, {
    sessionId,
    entries: safeEntries.length,
  });
}

export function appendHistory(sessionId: string, entry: HistoryEntry): HistoryEntry {
  ensureHistoryDatabaseSession(sessionId);
  const database = historyDatabase();
  let positioned = positionHistoryEntry(sessionId, entry);
  let existing = positioned.entryId
    ? database.getByEntryId(sessionId, positioned.entryId)
    : undefined;
  if (existing && !sameLogicalTranscriptEntry(existing, positioned)) {
    console.warn(
      `[History] Refusing transcript identity collision session=${sessionId} entryId=${positioned.entryId} role=${positioned.role}`,
    );
    const repaired = { ...entry };
    if (repaired.questionId) repaired.questionId = createInteractiveRequestId("recovered_question");
    delete repaired.entryId;
    delete repaired.sessionSeq;
    delete repaired.revision;
    positioned = positionHistoryEntry(sessionId, repaired);
    existing = undefined;
  }
  if (existing) {
    if (isSendFileCall(positioned) && isSendFileCall(existing)) {
      // A later SDK/native revision of the canonical tool call must not erase
      // delivery metadata attached by the app-tool handler.
      positioned.fileId ??= existing.fileId;
      positioned.fileName ??= existing.fileName;
      positioned.fileSize ??= existing.fileSize;
      positioned.fileVersion ??= existing.fileVersion;
      positioned.fileDeliveryPath ??= existing.fileDeliveryPath;
    }
    positioned.revision = Math.max(
      positiveInteger(positioned.revision) || 1,
      (positiveInteger(existing.revision) || 1) + 1,
    );
  }
  const safeEntry = compactHistoryEntryForStorage(
    sessionId,
    redactSecretsDeep(positioned),
    Math.max(0, Number(positioned.sessionSeq || 1) - 1),
  );
  database.upsert(sessionId, safeEntry, historyPositionKey(safeEntry));
  const cached = historyCache.get(sessionId);
  if (cached) {
    const existingIndex = cached.entries.findIndex((candidate) => candidate.entryId === safeEntry.entryId);
    if (existingIndex >= 0) cached.entries[existingIndex] = safeEntry;
    else {
      cached.entries.push(safeEntry);
      cached.entries.sort((left, right) => Number(left.sessionSeq || 0) - Number(right.sessionSeq || 0));
    }
  }
  updateSessionHistoryMetadataFromDatabase(sessionId);
  return safeEntry;
}

export interface SendFileDeliveryMetadata {
  filePath: string;
  fileDeliveryPath: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  fileVersion: string;
  advertisedAtMs: number;
}

/**
 * Attach one app-tool delivery to its canonical SendFile history entry.
 *
 * The delivery ID is deliberately invocation-scoped. The content version is
 * kept separately so two sends of the same unchanged path never share the
 * phone's downloaded state while transfer mutation checks still work.
 */
export function attachSendFileDeliveryToHistory(
  sessionId: string,
  metadata: SendFileDeliveryMetadata,
): HistoryEntry | undefined {
  if (!sessionId || !metadata.filePath || !metadata.fileId) return undefined;
  const entries = readHistoryEntries(sessionId);
  const earliestMatch = metadata.advertisedAtMs - 5_000;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isSendFileCall(entry) || sendFilePath(entry) !== metadata.filePath) continue;
    if (entry.fileId) {
      if (entry.fileId === metadata.fileId) return hydrateHistoryEntry(entry);
      continue;
    }
    const entryTime = Date.parse(entry.timestamp || "");
    if (Number.isFinite(entryTime) && entryTime < earliestMatch) break;
    entry.fileId = metadata.fileId;
    entry.fileName = metadata.fileName;
    entry.fileSize = metadata.fileSize;
    entry.fileVersion = metadata.fileVersion;
    entry.fileDeliveryPath = metadata.fileDeliveryPath;
    entry.revision = (positiveInteger(entry.revision) || 1) + 1;
    return hydrateHistoryEntry(appendHistory(sessionId, entry));
  }
  return undefined;
}

/** Run the collision migration before accepting clients on the first fixed build. */
export function repairStoredTranscriptIdentitiesOnce(): void {
  if (fs.existsSync(TRANSCRIPT_IDENTITY_REPAIR_MARKER)) return;
  ensureHistoryDir();
  fs.writeFileSync(TRANSCRIPT_IDENTITY_REPAIR_MARKER, `${new Date().toISOString()}\n`, { mode: 0o600 });
  // Lazy SQLite migration runs the same collision repair before importing
  // each session. Avoid an eager startup walk across every retained history.
  console.log("[HistoryRepair] Enabled lazy transcript identity repair");
}

export function appendHistoryBulk(sessionId: string, newEntries: HistoryEntry[]): void {
  if (newEntries.length === 0) return;
  ensureHistoryDatabaseSession(sessionId);
  const database = historyDatabase();
  const positioned: HistoryEntry[] = [];
  for (const newEntry of newEntries) {
    let entry = positionHistoryEntry(sessionId, newEntry);
    let existing = entry.entryId ? database.getByEntryId(sessionId, entry.entryId) : undefined;
    if (existing) {
      if (!sameLogicalTranscriptEntry(existing, entry)) {
        console.warn(`[History] Recovering colliding bulk entry session=${sessionId} entryId=${entry.entryId}`);
        const repaired = { ...newEntry };
        if (repaired.questionId) repaired.questionId = createInteractiveRequestId("recovered_question");
        delete repaired.entryId;
        delete repaired.sessionSeq;
        delete repaired.revision;
        entry = positionHistoryEntry(sessionId, repaired);
        existing = undefined;
      }
    }
    if (existing) {
      entry.revision = Math.max(
        positiveInteger(entry.revision) || 1,
        (positiveInteger(existing.revision) || 1) + 1,
      );
    }
    positioned.push(compactHistoryEntryForStorage(
      sessionId,
      redactSecretsDeep(entry),
      Math.max(0, Number(entry.sessionSeq || 1) - 1),
    ));
  }
  database.upsertMany(
    sessionId,
    positioned.map((entry) => ({ entry, positionKey: historyPositionKey(entry) })),
  );
  const cached = historyCache.get(sessionId);
  if (cached) {
    const indexes = new Map(cached.entries.map((entry, index) => [entry.entryId, index]));
    for (const entry of positioned) {
      const index = indexes.get(entry.entryId);
      if (index === undefined) cached.entries.push(entry);
      else cached.entries[index] = entry;
    }
    cached.entries.sort((left, right) => Number(left.sessionSeq || 0) - Number(right.sessionSeq || 0));
  }
  updateSessionHistoryMetadataFromDatabase(sessionId);
}

/** Replace a session transcript with an already validated transfer snapshot. */
export function replaceHistory(sessionId: string, entries: HistoryEntry[]): void {
  transcriptPositionStates.delete(sessionId);
  historyCache.delete(sessionId);
  syncTranscriptPositionState(sessionId, entries);
  writeHistoryEntries(sessionId, entries);
}

export function removeHtmlPlanHistoryEntries(sessionId: string, planId: string): void {
  if (!sessionId || !planId) return;
  const entries = readHistoryEntries(sessionId);
  const filtered = entries.filter((entry) =>
    !(entry.role === "html_plan" && String(entry.toolInput?.planId || "") === planId));
  if (filtered.length !== entries.length) writeHistoryEntries(sessionId, filtered);
}

export function updateHtmlPlanHistoryEntry(
  sessionId: string,
  plan: { planId: string; title: string; html: string; createdAt: string; updatedAt: string },
): void {
  const entries = readHistoryEntries(sessionId);
  const changedEntries: HistoryEntry[] = [];
  for (const entry of entries) {
    if (entry.role !== "html_plan" || String(entry.toolInput?.planId || "") !== plan.planId) continue;
    entry.content = plan.title;
    entry.toolInput = { ...entry.toolInput, ...plan, sessionId };
    entry.timestamp = plan.updatedAt;
    entry.revision = Math.max(1, Number(entry.revision || 1) + 1);
    changedEntries.push(entry);
  }
  if (changedEntries.length > 0) appendHistoryBulk(sessionId, changedEntries);
}

function nativeSyncTextKey(entry: HistoryEntry): string | null {
  if (entry.role !== "user" && entry.role !== "assistant") return null;
  const content = String(entry.content ?? "").trim().replace(/\s+/g, " ");
  if (!content) return null;
  return `${entry.role}\u0001${entry.parentToolUseId || ""}\u0001${content}`;
}

function nativeSyncEntryKey(entry: HistoryEntry): string {
  if (entry.toolUseId && (entry.role === "tool_call" || entry.role === "tool_result" || entry.role === "tool_image")) {
    return [
      entry.role,
      entry.toolName || "",
      entry.toolUseId,
      entry.filePath || "",
      entry.parentToolUseId || "",
    ].join("\u0001");
  }
  const content = String(entry.content ?? "").trim().replace(/\s+/g, " ");
  return [
    entry.role,
    entry.toolName || "",
    entry.toolUseId || "",
    entry.filePath || "",
    entry.parentToolUseId || "",
    content,
  ].join("\u0001");
}

/**
 * Append only the native transcript suffix that follows the latest local
 * user/assistant text entry. This is intentionally conservative: if we cannot
 * anchor the native transcript to the local tail, we do nothing rather than
 * appending an old transcript chunk to the end of the chat.
 */
export function appendNativeHistorySuffix(sessionId: string, nativeEntries: HistoryEntry[]): HistoryEntry[] {
  if (nativeEntries.length === 0) return [];
  let localEntries: HistoryEntry[] = [];
  try { localEntries = readHistoryEntries(sessionId); } catch { localEntries = []; }

  if (localEntries.length === 0) {
    writeHistoryEntries(sessionId, nativeEntries);
    return nativeEntries;
  }

  let localAnchorKey: string | null = null;
  for (let i = localEntries.length - 1; i >= 0; i--) {
    localAnchorKey = nativeSyncTextKey(localEntries[i]);
    if (localAnchorKey) break;
  }
  if (!localAnchorKey) return [];

  let nativeAnchorIndex = -1;
  for (let i = nativeEntries.length - 1; i >= 0; i--) {
    if (nativeSyncTextKey(nativeEntries[i]) === localAnchorKey) {
      nativeAnchorIndex = i;
      break;
    }
  }
  if (nativeAnchorIndex < 0) return [];

  const suffix = nativeEntries.slice(nativeAnchorIndex + 1);
  if (!suffix.some((entry) => nativeSyncTextKey(entry))) return [];

  const localCounts = new Map<string, number>();
  for (const entry of localEntries) {
    const key = nativeSyncEntryKey(entry);
    localCounts.set(key, (localCounts.get(key) || 0) + 1);
  }

  const missing: HistoryEntry[] = [];
  for (const entry of suffix) {
    const key = nativeSyncEntryKey(entry);
    const count = localCounts.get(key) || 0;
    if (count > 0) {
      localCounts.set(key, count - 1);
    } else {
      missing.push(entry);
    }
  }
  if (!missing.some((entry) => nativeSyncTextKey(entry))) return [];

  appendHistoryBulk(sessionId, missing);
  return missing;
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
  if (getSession(sessionId)?.backend !== "claude") return;

  let entries: HistoryEntry[];
  try { entries = readHistoryEntries(sessionId, { backfillUserUuids: false }); } catch { return; }
  if (entries.length === 0) return;

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
  const changedEntries: HistoryEntry[] = [];
  for (const idx of missingIdx) {
    const histText = entries[idx].content || "";
    let found = -1;
    for (let j = cursor; j < available.length; j++) {
      if (available[j].text === histText) { found = j; break; }
    }
    if (found >= 0) {
      entries[idx].uuid = available[found].uuid;
      cursor = found + 1;
      changedEntries.push(entries[idx]);
    }
  }

  if (changedEntries.length > 0) {
    appendHistoryBulk(sessionId, changedEntries);
    console.log(`[Backfill] Restored UUIDs for ${sessionId} (${missingIdx.length} candidate entries)`);
  }
}

/** Assign UUID to the most recent user history entry (for rewind support) */
export function assignUserUuid(sessionId: string, uuid: string): void {
  try {
    const entries = readHistoryEntries(sessionId);
    if (entries.length === 0) return;
    // Walk backwards to find the most recent user entry without a uuid
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "user" && !entries[i].uuid) {
        entries[i].uuid = uuid;
        appendHistory(sessionId, entries[i]);
        return;
      }
    }
  } catch {}
}

/** Remove messages superseded by an SDK refusal fallback. */
export function removeHistoryEntriesByUuids(sessionId: string, uuids: readonly string[]): number {
  if (!sessionId || uuids.length === 0) return 0;
  const removed = historyDatabase().deleteByUuids(sessionId, uuids);
  if (removed === 0) return 0;
  const cached = historyCache.get(sessionId);
  if (cached) {
    const retracted = new Set(uuids);
    cached.entries = cached.entries.filter((entry) => !entry.uuid || !retracted.has(entry.uuid));
  }
  updateSessionHistoryMetadataFromDatabase(sessionId);
  return removed;
}

/** Persist the terminal state of a user-visible interaction.
 *
 * Answers are intentionally supported only for ordinary question/elicitation
 * cards. Secure-input values have a separate status-only lifecycle and must
 * never pass through this function.
 */
export function markQuestionAnswered(
  sessionId: string,
  questionId: string,
  answers: Record<string, string> = {},
): void {
  try {
    const entries = readHistoryEntries(sessionId);
    if (entries.length === 0) return;
    const changedEntries: HistoryEntry[] = [];
    for (const entry of entries) {
      if (
        (entry.role !== "question" && entry.role !== "elicitation_url")
        || entry.questionId !== questionId
      ) {
        continue;
      }
      const answersChanged = JSON.stringify(entry.answers || {}) !== JSON.stringify(answers);
      if (entry.answered && !answersChanged) continue;
      entry.answered = true;
      entry.answers = { ...answers };
      entry.revision = (positiveInteger(entry.revision) || 1) + 1;
      changedEntries.push(entry);
    }
    if (changedEntries.length > 0) appendHistoryBulk(sessionId, changedEntries);
  } catch (e) {
    console.error(`[History] Error marking question answered: ${e}`);
  }
}

export interface PersistedSecureInputRequest {
  requestId: string;
  label: string;
  reason: string;
  envHint?: string;
  scope: "session" | "project" | "global";
}

/** Returns the latest unresolved request state from durable history. */
export function getPersistedSecureInputRequest(
  sessionId: string,
  requestId: string,
): PersistedSecureInputRequest | undefined {
  const entries = readHistoryEntries(sessionId);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.role !== "secure_input" || entry.questionId !== requestId) continue;
    if (entry.answered || ["saved", "cancelled", "expired"].includes(String(entry.status))) {
      return undefined;
    }
    const input = entry.toolInput || {};
    const rawScope = String(input.scope || "session");
    return {
      requestId,
      label: String(input.label || "Secret"),
      reason: String(input.reason || entry.content || ""),
      envHint: String(input.envHint || "") || undefined,
      scope: rawScope === "project" || rawScope === "global" ? rawScope : "session",
    };
  }
  return undefined;
}

export function markSecureInputRequestResolved(
  sessionId: string,
  requestId: string,
  status: "saved" | "cancelled" | "expired",
): void {
  try {
    const entries = readHistoryEntries(sessionId);
    const changedEntries: HistoryEntry[] = [];
    for (const entry of entries) {
      if (entry.role !== "secure_input" || entry.questionId !== requestId) continue;
      if (
        entry.answered
        && entry.status === status
        && entry.toolInput?.status === status
      ) {
        continue;
      }
      entry.status = status;
      entry.answered = true;
      entry.toolInput = { ...(entry.toolInput || {}), status };
      // Terminal state is a new canonical card revision. Without this, a
      // reconnect cache can legitimately retain an older pending snapshot.
      entry.revision = (positiveInteger(entry.revision) || 1) + 1;
      changedEntries.push(entry);
    }
    if (changedEntries.length > 0) appendHistoryBulk(sessionId, changedEntries);
  } catch (error) {
    console.error(`[History] Error resolving secure input ${requestId}: ${error}`);
  }
}

export function getHistory(sessionId: string): HistoryEntry[] {
  // Recover UUIDs on user prompts saved before self-assigned UUIDs (Apr 22 →
  // Apr 27). Once-per-process and a no-op when nothing's missing.
  return hydrateHistoryEntries(readHistoryEntries(sessionId, { backfillUserUuids: true }));
}

/** Latest canonical lifecycle snapshot for every native task/runtime task. */
export function getTaskStates(sessionId: string): HistoryEntry[] {
  ensureHistoryDatabaseSession(sessionId);
  return historyDatabase().getByRole(sessionId, "task_state").map(cloneHistoryEntry);
}

export function getHistoryCount(sessionId: string): number {
  ensureHistoryDatabaseSession(sessionId);
  return historyDatabase().count(sessionId);
}

/** Count persisted Codex compaction boundaries without hydrating transcript rows. */
export function getSessionCompactionCount(sessionId: string): number {
  ensureHistoryDatabaseSession(sessionId);
  return historyDatabase().countCompactionBoundaries(sessionId);
}

export interface RememberSearchOptions {
  query: string;
  roles?: string[];
  toolName?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** Full-text search over one session's durable transcript. */
export function rememberSearchHistory(
  sessionId: string,
  options: RememberSearchOptions,
): TranscriptSearchHit[] {
  ensureHistoryDatabaseSession(sessionId);
  return historyDatabase().search(sessionId, options);
}

/** Retrieve one durable transcript entry by stable sequence or entry ID. */
export function rememberGetHistoryEntry(
  sessionId: string,
  selector: { sessionSeq?: number; entryId?: string },
): HistoryEntry | undefined {
  ensureHistoryDatabaseSession(sessionId);
  const entry = selector.entryId
    ? historyDatabase().getByEntryId(sessionId, selector.entryId)
    : selector.sessionSeq
      ? historyDatabase().getBySessionSeq(sessionId, selector.sessionSeq)
      : undefined;
  return entry ? hydrateHistoryEntry(entry) : undefined;
}

/** Retrieve bounded neighboring entries around one stable sequence. */
export function rememberHistoryContext(
  sessionId: string,
  sessionSeq: number,
  before = 3,
  after = 3,
): HistoryEntry[] {
  ensureHistoryDatabaseSession(sessionId);
  return hydrateHistoryEntries(historyDatabase().context(
    sessionId,
    sessionSeq,
    Math.max(0, Math.min(20, before)),
    Math.max(0, Math.min(20, after)),
  ));
}

/** List a bounded transcript page before/after a stable sequence, or the latest page. */
export function rememberListHistory(
  sessionId: string,
  options: { sessionSeq?: number; direction?: "before" | "after"; limit?: number } = {},
): HistoryEntry[] {
  ensureHistoryDatabaseSession(sessionId);
  return hydrateHistoryEntries(historyDatabase().list(
    sessionId,
    Math.max(1, Math.min(50, options.limit ?? 20)),
    options.sessionSeq,
    options.direction ?? "before",
  ));
}

/** List recent user-initiated runs with their durable completion boundary. */
export function rememberRecentRuns(
  sessionId: string,
  limit = 10,
): Array<{ prompt: HistoryEntry; boundary?: HistoryEntry }> {
  ensureHistoryDatabaseSession(sessionId);
  return historyDatabase().recentRuns(sessionId, Math.max(1, Math.min(50, limit)))
    .map((run) => ({
      prompt: hydrateHistoryEntry(run.prompt),
      ...(run.boundary ? { boundary: hydrateHistoryEntry(run.boundary) } : {}),
    }));
}

/**
 * Get the last prompt suggestion stored in session history.
 * Returns the suggestion string, or undefined if none exists.
 */
export function getLastPromptSuggestion(sessionId: string): string | undefined {
  const all = readHistoryEntries(sessionId);
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
  const startedAt = Date.now();
  ensureHistoryDatabaseSession(sessionId);
  backfillUserUuids(sessionId);
  const database = historyDatabase();
  const total = database.count(sessionId);
  if (total === 0) {
    warnIfSlow("history_page", startedAt, { sessionId, total, limit, offset: offset ?? "tail" });
    return { entries: [], total: 0, offset: 0 };
  }

  let start: number;
  if (offset !== undefined) {
    start = Math.max(0, offset);
  } else {
    // Default: last `limit` entries
    start = Math.max(0, total - limit);
  }
  const entries = hydrateHistoryEntries(database.getPage(sessionId, start, Math.max(1, limit)));
  warnIfSlow("history_page", startedAt, { sessionId, total, limit, offset: start });
  return { entries, total, offset: start };
}

export interface BoundedHistoryPage {
  entries: HistoryEntry[];
  total: number;
  offset: number;
  deferredContextAvailable: boolean;
  totalUserPrompts: number;
}

export interface ResumeHistoryPage extends BoundedHistoryPage {
  historyKind: "initial" | "delta";
}

export interface ResumeHistoryOptions {
  knownSessionSeq?: number;
  knownHistoryOffset?: number;
  knownHistoryEntryCount?: number;
  minEntries?: number;
  recentUserPrompts?: number;
  maxDeltaEntries?: number;
  maxDeltaBytes?: number;
  maxInitialEntries?: number;
  maxInitialBytes?: number;
}

function hydratedTailWithinBudget(
  all: HistoryEntry[],
  endExclusive: number,
  maxEntries: number,
  maxBytes: number,
): { entries: HistoryEntry[]; offset: number } {
  const selected: HistoryEntry[] = [];
  let bytes = 2;
  let offset = endExclusive;
  for (let index = endExclusive - 1; index >= 0 && selected.length < maxEntries; index--) {
    const hydrated = hydrateHistoryEntry(all[index]);
    const entryBytes = Buffer.byteLength(JSON.stringify(hydrated), "utf8") + 1;
    if (selected.length > 0 && bytes + entryBytes > maxBytes) break;
    selected.unshift(hydrated);
    bytes += entryBytes;
    offset = index;
  }
  return { entries: selected, offset };
}

/** A ready-to-render latest page with hard entry and serialized-byte bounds. */
export function getBoundedHistoryTail(
  sessionId: string,
  maxEntries = 50,
  maxBytes = 256 * 1024,
): BoundedHistoryPage {
  const startedAt = Date.now();
  ensureHistoryDatabaseSession(sessionId);
  backfillUserUuids(sessionId);
  const database = historyDatabase();
  const summary = database.summary(sessionId)!;
  const tail = database.getTail(sessionId, Math.max(1, maxEntries));
  const bounded = hydratedTailWithinBudget(tail, tail.length, maxEntries, maxBytes);
  const offset = summary.entryCount - tail.length + bounded.offset;
  warnIfSlow("history_bounded_tail", startedAt, {
    sessionId,
    total: summary.entryCount,
    entries: bounded.entries.length,
    offset,
  });
  return {
    entries: bounded.entries,
    offset,
    total: summary.entryCount,
    deferredContextAvailable: offset > 0,
    totalUserPrompts: summary.userPromptCount,
  };
}

/**
 * Return only durable entries newer than a cached sequence. Null means the
 * cache is incompatible or the delta exceeds the initial response budget.
 */
export function getBoundedHistoryDelta(
  sessionId: string,
  knownSessionSeq: number,
  maxEntries = 500,
  maxBytes = 2 * 1024 * 1024,
  knownHistoryOffset?: number,
  knownHistoryEntryCount?: number,
): BoundedHistoryPage | null {
  ensureHistoryDatabaseSession(sessionId);
  backfillUserUuids(sessionId);
  const database = historyDatabase();
  const summary = database.summary(sessionId)!;
  const knownIndex = database.offsetForSessionSeq(sessionId, knownSessionSeq);
  if (knownIndex === undefined) return null;
  if (knownHistoryOffset !== undefined || knownHistoryEntryCount !== undefined) {
    if (!Number.isSafeInteger(knownHistoryOffset) ||
        !Number.isSafeInteger(knownHistoryEntryCount) ||
        knownHistoryOffset! < 0 ||
        knownHistoryEntryCount! <= 0 ||
        knownHistoryOffset! + knownHistoryEntryCount! !== knownIndex + 1) {
      return null;
    }
  }
  const count = summary.entryCount - knownIndex - 1;
  if (count > maxEntries) return null;
  const entries = hydrateHistoryEntries(database.getAfter(sessionId, knownSessionSeq, maxEntries));
  if (Buffer.byteLength(JSON.stringify(entries), "utf8") > maxBytes) return null;
  return {
    entries,
    total: summary.entryCount,
    offset: knownIndex + 1,
    deferredContextAvailable: false,
    totalUserPrompts: summary.userPromptCount,
  };
}

/**
 * Build the complete visible window for a session resume in one server read.
 *
 * The initial snapshot targets at least `minEntries` and the requested recent
 * prompts, then applies hard entry/byte limits so a pathological tool-heavy
 * turn cannot freeze the phone. Any contiguous cached suffix is a safe delta
 * cursor; older context remains available through normal pagination.
 */
export function getResumeHistoryPage(
  sessionId: string,
  options: ResumeHistoryOptions = {},
): ResumeHistoryPage {
  const startedAt = Date.now();
  ensureHistoryDatabaseSession(sessionId);
  backfillUserUuids(sessionId);
  const database = historyDatabase();
  const summary = database.summary(sessionId)!;
  const total = summary.entryCount;
  const minEntries = Math.max(1, options.minEntries ?? 50);
  const recentUserPrompts = Math.max(0, options.recentUserPrompts ?? 3);
  const maxDeltaEntries = Math.max(1, options.maxDeltaEntries ?? 500);
  const maxDeltaBytes = Math.max(1, options.maxDeltaBytes ?? 2 * 1024 * 1024);
  const maxInitialEntries = Math.max(1, options.maxInitialEntries ?? 500);
  const maxInitialBytes = Math.max(1, options.maxInitialBytes ?? 2 * 1024 * 1024);
  const totalUserPrompts = summary.userPromptCount;
  const targetUserPrompts = Math.min(totalUserPrompts, recentUserPrompts);

  const knownSessionSeq = options.knownSessionSeq;
  const knownHistoryOffset = options.knownHistoryOffset;
  const knownHistoryEntryCount = options.knownHistoryEntryCount;
  if (Number.isSafeInteger(knownSessionSeq) && knownSessionSeq! >= 0 &&
      Number.isSafeInteger(knownHistoryOffset) && knownHistoryOffset! >= 0 &&
      Number.isSafeInteger(knownHistoryEntryCount) && knownHistoryEntryCount! > 0) {
    const knownIndex = database.offsetForSessionSeq(sessionId, knownSessionSeq!);
    const cacheIsContiguous = knownIndex !== undefined &&
      knownHistoryOffset! + knownHistoryEntryCount! === knownIndex + 1;
    if (cacheIsContiguous) {
      const deltaCount = total - knownIndex! - 1;
      if (deltaCount <= maxDeltaEntries) {
        const deltaEntries = database.getAfter(sessionId, knownSessionSeq!, maxDeltaEntries);
        const hydratedDelta = hydrateHistoryEntries(deltaEntries);
        if (Buffer.byteLength(JSON.stringify(hydratedDelta), "utf8") <= maxDeltaBytes) {
          warnIfSlow("history_resume_delta", startedAt, {
            sessionId,
            total,
            entries: hydratedDelta.length,
            offset: knownIndex + 1,
          });
          return {
            entries: hydratedDelta,
            total,
            offset: knownIndex + 1,
            deferredContextAvailable: false,
            totalUserPrompts,
            historyKind: "delta",
          };
        }
      }
    }
  }

  let start = Math.max(0, total - minEntries);
  if (targetUserPrompts > 0) {
    const promptOffset = database.recentUserPromptOffset(sessionId, targetUserPrompts);
    if (promptOffset !== undefined) start = Math.min(start, promptOffset);
  }
  const candidateLimit = Math.min(maxInitialEntries, total - start);
  const candidateStart = total - candidateLimit;
  const candidate = database.getPage(sessionId, candidateStart, candidateLimit);
  const bounded = hydratedTailWithinBudget(
    candidate,
    candidate.length,
    maxInitialEntries,
    maxInitialBytes,
  );
  const entries = bounded.entries;
  const boundedStart = candidateStart + bounded.offset;
  warnIfSlow("history_resume_initial", startedAt, {
    sessionId,
    total,
    entries: entries.length,
    offset: boundedStart,
  });
  return {
    entries,
    total,
    offset: boundedStart,
    deferredContextAvailable: boundedStart > start,
    totalUserPrompts,
    historyKind: "initial",
  };
}

/**
 * Get history page that includes at least back to the user's most recent prompt.
 * Ensures the app has enough context to render subagent tasks properly.
 */
export function getHistoryPageToLastPrompt(
  sessionId: string,
  minEntries: number = 50
): { entries: HistoryEntry[]; total: number; offset: number } {
  const startedAt = Date.now();
  const all = readHistoryEntries(sessionId, { backfillUserUuids: true });
  const total = all.length;
  if (total === 0) {
    warnIfSlow("history_page_to_prompt", startedAt, { sessionId, total, minEntries });
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

  warnIfSlow("history_page_to_prompt", startedAt, { sessionId, total, minEntries, offset: start });
  return { entries: hydrateHistoryEntries(all.slice(start)), total, offset: start };
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
  const all = readHistoryEntries(sessionId, { backfillUserUuids: true });
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
    writeHistoryEntries(sessionId, kept);
    return { removed, kept: kept.length };
  }
  const kept = all.slice(0, idx + 1);
  const removed = all.length - kept.length;
  writeHistoryEntries(sessionId, kept);
  return { removed, kept: kept.length };
}

// ── Per-session todo list ──

const TODOS_DIR = path.join(STORE_DIR, "todos");
const CLAUDE_TASK_BACKFILL_SCANNED = new Set<string>();
const SERVER_PROCESS_STARTED_AT_MS = Date.now();

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
 * One-time-compatible recovery for Claude's modern TaskCreate/TaskUpdate list.
 * Older SocketAgent builds persisted the tool transcript but discarded the
 * TaskCreated hooks, so rebuild missing native task rows from the full durable
 * history before sending the bounded resume page.
 */
export function deriveClaudeTasksFromHistoryEntries(entries: HistoryEntry[]): any[] {
  const derived = new Map<string, any>();
  const pendingCreates = new Map<string, {
    subject: string;
    description?: string;
  }>();
  for (const entry of entries) {
    if (entry.role === "tool_call" && entry.toolName === "TaskCreate") {
      const input = entry.toolInput || {};
      pendingCreates.set(String(entry.toolUseId || ""), {
        subject: String(input.subject || ""),
        description: String(input.description || "") || undefined,
      });
      continue;
    }
    if (entry.role === "tool_result") {
      const output = String(entry.toolOutput || entry.content || "");
      const match = output.match(/Task #([^\s]+) created successfully:\s*(.*)/i);
      if (!match) continue;
      const pending = pendingCreates.get(String(entry.toolUseId || ""));
      const taskId = match[1];
      const subject = String(pending?.subject || match[2] || `Task #${taskId}`);
      derived.set(taskId, {
        id: taskId,
        taskId,
        content: subject,
        activeForm: subject,
        status: "pending",
        source: "claude_tasks",
        ...(pending?.description ? { description: pending.description } : {}),
      });
      continue;
    }
    if (entry.role !== "tool_call" || entry.toolName !== "TaskUpdate") continue;
    const input = entry.toolInput || {};
    const taskId = String(input.taskId || "");
    if (!taskId) continue;
    const status = String(input.status || "");
    if (status === "deleted") {
      derived.delete(taskId);
      continue;
    }
    const previous = derived.get(taskId);
    const subject = String(input.subject || previous?.content || `Task #${taskId}`);
    derived.set(taskId, {
      ...(previous || {}),
      id: taskId,
      taskId,
      content: subject,
      activeForm: subject,
      status: status === "pending"
        || status === "in_progress"
        || status === "completed"
        ? status
        : previous?.status || "pending",
      source: "claude_tasks",
    });
  }
  return Array.from(derived.values());
}

export function backfillClaudeTasksFromHistory(sessionId: string): any[] {
  const current = getTodos(sessionId);
  if (CLAUDE_TASK_BACKFILL_SCANNED.has(sessionId)) return current;
  CLAUDE_TASK_BACKFILL_SCANNED.add(sessionId);
  let entries: HistoryEntry[];
  try {
    entries = readHistoryEntries(sessionId, { backfillUserUuids: false });
  } catch {
    return current;
  }
  const derived = deriveClaudeTasksFromHistoryEntries(entries);

  const existingIds = new Set(
    current
      .filter((item) => item?.source === "claude_tasks")
      .map((item) => String(item?.id ?? item?.taskId ?? "")),
  );
  const recovered = derived.filter(
    (item) => !existingIds.has(String(item.id)),
  );
  if (recovered.length === 0) return current;
  const merged = [...current, ...recovered];
  saveTodos(sessionId, merged);
  for (const task of recovered) {
    appendHistory(sessionId, {
      role: "task_state",
      content: String(task.content || ""),
      taskId: String(task.id || task.taskId || ""),
      taskKind: "claude_task",
      status: String(task.status || "pending"),
      taskSubject: String(task.content || "") || undefined,
      taskDescription: task.description,
      teammateName: task.teammateName,
      isBackgrounded: false,
      timestamp: new Date().toISOString(),
    });
  }
  console.log(`[Tasks] Recovered ${recovered.length} Claude task(s) from history for ${sessionId}`);
  return merged;
}

/**
 * Settle runtime work whose owning SDK process died in a previous server
 * process. Do not settle work merely because its foreground turn is idle:
 * Claude background work can legitimately outlive that turn.
 */
export function settleStaleRuntimeTaskStates(sessionId: string): number {
  let entries: HistoryEntry[];
  try {
    entries = readHistoryEntries(sessionId, { backfillUserUuids: false });
  } catch {
    return 0;
  }
  let settled = 0;
  const changedEntries: HistoryEntry[] = [];
  const timestamp = new Date().toISOString();
  for (const entry of entries) {
    if (entry.role !== "task_state"
      || entry.taskKind === "claude_task"
      || !["pending", "running", "paused"].includes(String(entry.status || ""))
      || !Number.isFinite(Date.parse(entry.timestamp || ""))
      || Date.parse(entry.timestamp || "") >= SERVER_PROCESS_STARTED_AT_MS) {
      continue;
    }
    entry.status = "stopped";
    entry.isBackgrounded = false;
    entry.content = entry.content || "Interrupted when the Claude SDK process ended";
    entry.timestamp = timestamp;
    entry.revision = (positiveInteger(entry.revision) || 1) + 1;
    changedEntries.push(entry);
    settled++;
  }
  if (settled > 0) {
    appendHistoryBulk(sessionId, changedEntries);
    console.log(`[Tasks] Settled ${settled} stale runtime task(s) for ${sessionId}`);
  }
  return settled;
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
  const history = readHistoryEntries(sessionId);
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
            parentToolUseId: msg.parent_tool_use_id || null,
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
                parentToolUseId: msg.parent_tool_use_id || null,
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
                parentToolUseId: msg.parent_tool_use_id || null,
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
const SDK_EVENTS_FLUSH_MS = 100;
const SDK_EVENTS_MAX_BYTES = 32 * 1024 * 1024;
const SDK_EVENTS_KEEP_BYTES = 16 * 1024 * 1024;
const pendingSdkEventLines = new Map<string, string[]>();
let sdkEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureSdkEventsDir(): void {
  if (!fs.existsSync(SDK_EVENTS_DIR)) {
    fs.mkdirSync(SDK_EVENTS_DIR, { recursive: true });
  }
}

function sdkEventsFile(sessionId: string): string {
  return path.join(SDK_EVENTS_DIR, `${sessionId}.jsonl`);
}

function compactSdkEventsFile(file: string): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return; }
  if (stat.size <= SDK_EVENTS_MAX_BYTES) return;

  const keepBytes = Math.min(SDK_EVENTS_KEEP_BYTES, stat.size);
  const fd = fs.openSync(file, "r");
  try {
    const tail = Buffer.allocUnsafe(keepBytes);
    fs.readSync(fd, tail, 0, keepBytes, stat.size - keepBytes);
    const newline = tail.indexOf(10);
    const retained = newline >= 0 ? tail.subarray(newline + 1) : tail;
    const temp = `${file}.compact-${process.pid}`;
    fs.writeFileSync(temp, retained, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.closeSync(fd);
  }
}

function flushSdkEventQueue(sessionId?: string): void {
  ensureSdkEventsDir();
  const sessionIds = sessionId ? [sessionId] : [...pendingSdkEventLines.keys()];
  for (const sid of sessionIds) {
    const lines = pendingSdkEventLines.get(sid);
    if (!lines || lines.length === 0) continue;
    pendingSdkEventLines.delete(sid);
    const file = sdkEventsFile(sid);
    fs.appendFileSync(file, lines.join(""), { encoding: "utf-8", mode: 0o600 });
    compactSdkEventsFile(file);
  }
  if (pendingSdkEventLines.size === 0 && sdkEventFlushTimer) {
    clearTimeout(sdkEventFlushTimer);
    sdkEventFlushTimer = null;
  }
}

function discardPendingSdkEvents(sessionId: string): void {
  pendingSdkEventLines.delete(sessionId);
  if (pendingSdkEventLines.size === 0 && sdkEventFlushTimer) {
    clearTimeout(sdkEventFlushTimer);
    sdkEventFlushTimer = null;
  }
}

/** Queue SDK debug events and write them in batches instead of blocking once per delta. */
export function appendSdkEvent(sessionId: string, event: Record<string, any>): void {
  const line = JSON.stringify(event) + "\n";
  const pending = pendingSdkEventLines.get(sessionId) || [];
  pending.push(line);
  pendingSdkEventLines.set(sessionId, pending);
  if (!sdkEventFlushTimer) {
    sdkEventFlushTimer = setTimeout(() => {
      sdkEventFlushTimer = null;
      flushSdkEventQueue();
    }, SDK_EVENTS_FLUSH_MS);
    sdkEventFlushTimer.unref?.();
  }
}

/** Read recent SDK events for a session. Raw history can be huge, so cap it. */
export function getSdkEvents(sessionId: string, limit = 300): Record<string, any>[] {
  flushSdkEventQueue(sessionId);
  ensureSdkEventsDir();
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    return readJsonlTailLines(file, { maxLines: Math.max(1, limit), maxBytes: 16 * 1024 * 1024 })
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as Record<string, any>[];
  } catch {
    return [];
  }
}

/** Replace the bounded raw SDK event tail restored by a session transfer. */
export function replaceSdkEvents(
  sessionId: string,
  events: Record<string, any>[],
): void {
  discardPendingSdkEvents(sessionId);
  ensureSdkEventsDir();
  const file = sdkEventsFile(sessionId);
  if (!Array.isArray(events) || events.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const lines = events
    .filter((event) => event && typeof event === "object" && !Array.isArray(event))
    .map((event) => `${JSON.stringify(event)}\n`);
  let bytes = 0;
  const retained: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const lineBytes = Buffer.byteLength(lines[index], "utf8");
    if (bytes + lineBytes > SDK_EVENTS_KEEP_BYTES) break;
    retained.unshift(lines[index]);
    bytes += lineBytes;
  }
  fs.writeFileSync(file, retained.join(""), { encoding: "utf8", mode: 0o600 });
}

function readJsonlTailLines(
  file: string,
  options: { maxLines?: number; maxBytes?: number } = {}
): string[] {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 300));
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const stat = fs.statSync(file);
  if (stat.size === 0) return [];

  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let position = stat.size;
    let totalBytes = 0;
    let newlineCount = 0;

    while (position > 0 && totalBytes < maxBytes && newlineCount <= maxLines) {
      const readSize = Math.min(64 * 1024, position, maxBytes - totalBytes);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = fs.readSync(fd, buffer, 0, readSize, position);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      totalBytes += bytesRead;
      for (const byte of chunk) {
        if (byte === 10) newlineCount++;
      }
    }

    const lines = Buffer.concat(chunks).toString("utf-8").split("\n");
    if (position > 0) lines.shift();
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/** Get SDK event count for a session (for deciding whether to send) */
export function getSdkEventCount(sessionId: string): number {
  flushSdkEventQueue(sessionId);
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return 0;
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Read only the compact lifecycle subset needed to reconstruct historical
 * run durations. This intentionally avoids retaining multi-megabyte deltas,
 * tool payloads, and assistant content from the raw SDK event log.
 */
export function getSdkRunLifecycleEvents(sessionId: string): Record<string, any>[] {
  flushSdkEventQueue(sessionId);
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return [];
  const lifecycle: Record<string, any>[] = [];
  const inspectLine = (line: string) => {
    if (!line || (!line.includes('"sdkType":"result"')
      && !line.includes('"method":"turn/started"')
      && !line.includes('"method":"turn/completed"'))) {
      return;
    }
    try {
      lifecycle.push(JSON.parse(line));
    } catch {}
  };
  let fd: number | undefined;
  try {
    // SDK event logs can be very large. Scan in bounded chunks rather than
    // loading an entire multi-gigabyte transcript-adjacent log into memory.
    fd = fs.openSync(file, "r");
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let carry = "";
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytes <= 0) break;
      const text = carry + chunk.toString("utf8", 0, bytes);
      const lines = text.split("\n");
      carry = lines.pop() || "";
      for (const line of lines) inspectLine(line);
    }
    inspectLine(carry);
    return lifecycle;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const ARCHIVE_DIR = path.join(STORE_DIR, "archive");

function ensureArchiveDir(): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * Clear context for a session: archive the backend transcript, our history, and todos.
 * The session metadata (sessions.json) is preserved so it still shows in the list.
 * Archived files get a timestamp suffix so multiple clears don't overwrite.
 */
export function clearSessionContext(sessionId: string, cwd: string): void {
  flushSdkEventQueue(sessionId);
  ensureArchiveDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sessions = readStore();
  const session = sessions.find((s) => s.id === sessionId);
  const backend = session?.backend;
  let codexRolloutPath: string | undefined;

  // 1. Archive the backend's native transcript.
  if (backend === "codex") {
    const rolloutPath = findCodexRolloutFile(sessionId);
    if (rolloutPath && fs.existsSync(rolloutPath)) {
      codexRolloutPath = rolloutPath;
      const archiveName = `${sessionId}_${ts}_codex-rollout.jsonl`;
      fs.copyFileSync(rolloutPath, path.join(ARCHIVE_DIR, archiveName));
      archiveCodexNativeRollout(sessionId, rolloutPath);
      console.log(`[ClearContext] Archived Codex rollout: ${archiveName}`);
    }
  } else {
    const jsonlPath = getJsonlPath(sessionId, cwd);
    if (fs.existsSync(jsonlPath)) {
      const archiveName = `${sessionId}_${ts}.jsonl`;
      fs.renameSync(jsonlPath, path.join(ARCHIVE_DIR, archiveName));
      console.log(`[ClearContext] Archived JSONL: ${archiveName}`);
    }
  }

  // 2. Archive our chat history
  const histFile = historyFile(sessionId);
  const histBackup = historyBackupFile(sessionId);
  ensureHistoryDatabaseSession(sessionId);
  if (historyDatabase().count(sessionId) > 0) {
    const archiveName = `${sessionId}_${ts}_history.json`;
    fs.writeFileSync(
      path.join(ARCHIVE_DIR, archiveName),
      JSON.stringify(readHistoryEntries(sessionId)),
      { encoding: "utf8", mode: 0o600 },
    );
    historyDatabase().deleteSession(sessionId);
    fs.rmSync(histFile, { force: true });
    fs.rmSync(histBackup, { force: true });
    historyCache.delete(sessionId);
    console.log(`[ClearContext] Archived history: ${archiveName}`);
  } else if (fs.existsSync(histFile)) {
    const archiveName = `${sessionId}_${ts}_history.json`;
    fs.renameSync(histFile, path.join(ARCHIVE_DIR, archiveName));
    fs.rmSync(histBackup, { force: true });
    historyCache.delete(sessionId);
    console.log(`[ClearContext] Archived history: ${archiveName}`);
  } else if (fs.existsSync(histBackup)) {
    const archiveName = `${sessionId}_${ts}_history.json`;
    fs.renameSync(histBackup, path.join(ARCHIVE_DIR, archiveName));
    historyCache.delete(sessionId);
    console.log(`[ClearContext] Archived history backup: ${archiveName}`);
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
  if (session) {
    const clearedAt = new Date().toISOString();
    const metaName = `${sessionId}_${ts}_meta.json`;
    const meta = {
      sid: sessionId,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      clearedAt,
      ...(session.backend ? { backend: session.backend } : {}),
      ...((session as any).codexDriver ? { codexDriver: (session as any).codexDriver } : {}),
      ...(codexRolloutPath ? { codexRolloutPath } : {}),
    };
    fs.writeFileSync(path.join(ARCHIVE_DIR, metaName), JSON.stringify(meta, null, 2), "utf-8");
    console.log(`[ClearContext] Wrote meta: ${metaName}`);

    // 6. Update session metadata to reflect the clear
    session.messagePreview = "(context cleared)";
    session.lastActive = new Date().toISOString();
    (session as any).contextClearedAt = clearedAt;
    delete (session as any).lastContextUsage;
    writeStore(sessions);
  }
}

export interface ArchiveEntry {
  sid: string;
  ts: string;
  title: string;
  cwd: string;
  backend?: Backend;
  createdAt: string;
  clearedAt: string;
  messagePreview: string;
  messageCount: number;
  hasJsonl: boolean;
}

const CODEX_NATIVE_ARCHIVE_TS_PREFIX = "codex-native-";

const ARCHIVE_SUFFIXES: Array<[string, string]> = [
  ["_codex-rollout.jsonl", "codex-rollout"],
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
    let backend: Backend | undefined;
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
        if (meta.backend === "claude" || meta.backend === "codex") backend = meta.backend;
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

    // cwd fallback: pull from the archived backend transcript.
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
    const codexRolloutName = group.files.get("codex-rollout");
    if (!backend && codexRolloutName) backend = "codex";
    if (!cwd && codexRolloutName) {
      try {
        const firstLine = fs.readFileSync(path.join(ARCHIVE_DIR, codexRolloutName), "utf-8").split("\n", 1)[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine);
          if (obj?.type === "session_meta" && typeof obj.payload?.cwd === "string") {
            cwd = obj.payload.cwd;
          }
        }
      } catch {}
    }

    entries.push({
      sid: group.sid,
      ts: group.ts,
      title,
      cwd,
      ...(backend ? { backend } : {}),
      createdAt,
      clearedAt,
      messagePreview,
      messageCount,
      hasJsonl: group.files.has("jsonl") || group.files.has("codex-rollout"),
    });
  }

  for (const native of listCodexNativeArchives()) {
    const existingIdx = entries.findIndex((entry) => entry.sid === native.sid && entry.backend === "codex");
    if (existingIdx >= 0) {
      entries[existingIdx] = {
        ...native,
        title: entries[existingIdx].title || native.title,
        messagePreview: entries[existingIdx].messagePreview || native.messagePreview,
        messageCount: entries[existingIdx].messageCount || native.messageCount,
      };
    } else {
      entries.push(native);
    }
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
    return hydrateHistoryEntries(JSON.parse(fs.readFileSync(p, "utf-8")) as HistoryEntry[]);
  } catch {
    return [];
  }
}

export function restoreArchive(sid: string, ts: string): { ok: true; session: SessionInfo } | { ok: false; reason: string } {
  ensureArchiveDir();

  if (isCodexNativeArchiveTs(ts)) {
    const native = getCodexThreadSessionInfo(sid);
    if (!native) return { ok: false, reason: "Codex thread not found" };
    const restoredAt = new Date().toISOString();
    const sessions = readStore();
    const existingIdx = sessions.findIndex((s) => s.id === sid);
    const restored: SessionInfo = {
      ...native,
      lastActive: restoredAt,
      codexDriver: "app-server",
    } as SessionInfo;
    if (existingIdx >= 0) {
      sessions[existingIdx] = restored;
    } else {
      sessions.push(restored);
    }
    writeStore(sessions);
    unmarkSessionArchived(sid);
    return { ok: true, session: restored };
  }

  const metaPath = path.join(ARCHIVE_DIR, `${sid}_${ts}_meta.json`);
  const jsonlArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}.jsonl`);
  const codexRolloutArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_codex-rollout.jsonl`);
  const histArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_history.json`);
  const todosArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_todos.json`);
  const sdkEventsArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_sdk-events.jsonl`);

  let metaTitle = "";
  let metaCreatedAt = "";
  let metaBackend: Backend | undefined;
  let metaCodexDriver: string | undefined;
  let codexRolloutPath = "";
  let cwd = "";
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (typeof meta.title === "string") metaTitle = meta.title;
      if (typeof meta.createdAt === "string") metaCreatedAt = meta.createdAt;
      if (typeof meta.cwd === "string") cwd = meta.cwd;
      if (meta.backend === "claude" || meta.backend === "codex") metaBackend = meta.backend;
      if (meta.codexDriver === "exec" || meta.codexDriver === "app-server") metaCodexDriver = "app-server";
      if (typeof meta.codexRolloutPath === "string") codexRolloutPath = meta.codexRolloutPath;
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
  if (!cwd && fs.existsSync(codexRolloutArchive)) {
    try {
      const firstLine = fs.readFileSync(codexRolloutArchive, "utf-8").split("\n", 1)[0];
      if (firstLine) {
        const obj = JSON.parse(firstLine);
        if (obj?.type === "session_meta" && typeof obj.payload?.cwd === "string") {
          cwd = obj.payload.cwd;
        }
      }
    } catch {}
  }
  if (!cwd) return { ok: false, reason: "cannot determine cwd for this archive" };

  const liveHist = historyFile(sid);
  const liveJsonl = getJsonlPath(sid, cwd);
  let restoredCodexRolloutPath = "";

  if (fs.existsSync(jsonlArchive)) {
    const destDir = path.dirname(liveJsonl);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(liveJsonl)) fs.unlinkSync(liveJsonl);
    fs.renameSync(jsonlArchive, liveJsonl);
  }
  if (fs.existsSync(codexRolloutArchive)) {
    const homeDir = process.env.HOME || require("os").homedir();
    const archivedRoot = path.resolve(path.join(homeDir, ".codex", "archived_sessions"));
    const metaRolloutPath = codexRolloutPath && !path.resolve(codexRolloutPath).startsWith(archivedRoot + path.sep)
      ? codexRolloutPath
      : "";
    const liveCodexRollout = metaRolloutPath || buildCodexRolloutRestorePath(sid, codexRolloutArchive) || findCodexRolloutFile(sid);
    if (!liveCodexRollout) {
      return { ok: false, reason: "cannot determine Codex rollout path for this archive" };
    }
    const destDir = path.dirname(liveCodexRollout);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(liveCodexRollout)) fs.unlinkSync(liveCodexRollout);
    fs.renameSync(codexRolloutArchive, liveCodexRollout);
    restoredCodexRolloutPath = liveCodexRollout;
  }
  if (fs.existsSync(histArchive)) {
    ensureHistoryDir();
    if (fs.existsSync(liveHist)) fs.unlinkSync(liveHist);
    fs.rmSync(historyBackupFile(sid), { force: true });
    fs.renameSync(histArchive, liveHist);
    historyCache.delete(sid);
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
  let turnCount = 0;
  try {
    const hist = JSON.parse(fs.readFileSync(liveHist, "utf-8")) as any[];
    turnCount = Array.isArray(hist) ? conversationTurnCountFromEntries(hist as HistoryEntry[]) : 0;
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
    turnCount,
    ...(metaBackend ? { backend: metaBackend } : {}),
    ...(metaCodexDriver ? { codexDriver: metaCodexDriver as any } : {}),
  };
  if (existingIdx >= 0) {
    sessions[existingIdx] = restored;
  } else {
    sessions.push(restored);
  }
  writeStore(sessions);
  unmarkSessionArchived(sid);
  if (restored.backend === "codex" && restoredCodexRolloutPath) {
    updateCodexThreadRolloutState(sid, restoredCodexRolloutPath, false);
  }
  console.log(`[RestoreArchive] Restored ${sid}_${ts} (title="${restored.title}", cwd=${cwd})`);

  return { ok: true, session: restored };
}

export function deleteArchive(sid: string, ts: string): void {
  ensureArchiveDir();
  if (isCodexNativeArchiveTs(ts)) return;
  for (const suffix of [".jsonl", "_codex-rollout.jsonl", "_history.json", "_todos.json", "_sdk-events.jsonl", "_meta.json"]) {
    const p = path.join(ARCHIVE_DIR, `${sid}_${ts}${suffix}`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[DeleteArchive] Removed ${sid}_${ts}${suffix}`);
    }
  }
}

export function isCodexNativeArchiveTs(ts: string): boolean {
  return ts.startsWith(CODEX_NATIVE_ARCHIVE_TS_PREFIX);
}

const CODEX_THREAD_LIST_SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];
const CODEX_THREAD_LOOKUP_SOURCE_KINDS = ["cli", "exec", "vscode", "appServer", "unknown"];
const CODEX_THREAD_LIST_LIMIT = 500;
const SDK_SESSION_DISCOVERY_LIMIT = 2000;
const CLAUDE_NATIVE_CWD_LIMIT = 20;
const CLAUDE_NATIVE_SESSIONS_PER_CWD = 75;
const CODEX_NATIVE_LIST_CACHE_MS = 300_000;

let codexNativeSessionsCache:
  | { at: number; sessions: SessionInfo[] }
  | null = null;
let claudeNativeSessionsCache:
  | { at: number; sessions: SessionInfo[] }
  | null = null;
let codexNativeArchivesCache:
  | { at: number; archives: ArchiveEntry[] }
  | null = null;

export function invalidateCodexNativeListCache(): void {
  codexNativeSessionsCache = null;
  claudeNativeSessionsCache = null;
  codexNativeArchivesCache = null;
}

async function withCodexThreadListClient<T>(
  cwd: string,
  fn: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
  const client = new CodexAppServerClient({
    cwd,
    command: codex.command,
    args: codex.args,
    env: codex.env,
    shell: codex.shell,
    requestTimeoutMs: 20_000,
    startupTimeoutMs: 20_000,
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

function unixSecondsToIso(value: unknown, fallback = nowIso()): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n * 1000).toISOString();
}

function codexThreadTitle(thread: any): string {
  const raw = String(thread?.name || thread?.preview || "").trim();
  const firstLine = raw.split(/\r?\n/)[0].trim();
  const title = firstLine || "Codex session";
  return title.length > 80 ? title.slice(0, 80) + "…" : title;
}

function codexThreadPreview(thread: any): string {
  return String(thread?.preview || "").trim().slice(0, 200);
}

function codexThreadPayloadIsArchived(thread: any): boolean {
  const archived = (thread as any)?.archived;
  if (archived === true || archived === 1 || archived === "1") return true;
  if (typeof archived === "string" && archived.toLowerCase() === "true") return true;
  return false;
}

export function codexThreadToSessionInfo(thread: any, stored?: SessionInfo): SessionInfo | null {
  const id = String(thread?.id || thread?.threadId || "").trim();
  const cwd = String(thread?.cwd || stored?.cwd || "").trim();
  if (!id || !cwd) return null;
  const createdAt = unixSecondsToIso(thread?.createdAt, stored?.createdAt || nowIso());
  const lastActive = unixSecondsToIso(thread?.updatedAt, stored?.lastActive || createdAt);
  const preview = codexThreadPreview(thread);
  const storedTitle = stored?.title?.trim();
  return {
    ...(stored || {}),
    id,
    title: storedTitle && storedTitle !== "Untitled"
      ? storedTitle
      : codexThreadTitle(thread),
    cwd,
    createdAt,
    lastActive,
    messagePreview: stored?.messagePreview || preview || "",
    turnCount: normalizedTurnCount(stored?.turnCount) ?? 0,
    historyCount: normalizedTurnCount((stored as any)?.historyCount),
    backend: "codex",
    codexDriver: "app-server",
  } as SessionInfo;
}

function codexThreadToArchiveEntry(thread: any): ArchiveEntry | null {
  const session = codexThreadToSessionInfo(thread);
  if (!session) return null;
  const archivedAt = unixSecondsToIso((thread as any)?.archivedAt, session.lastActive);
  return {
    sid: session.id,
    ts: `${CODEX_NATIVE_ARCHIVE_TS_PREFIX}${Math.floor(new Date(archivedAt).getTime() / 1000) || Date.now()}`,
    title: session.title,
    cwd: session.cwd,
    backend: "codex",
    createdAt: session.createdAt,
    clearedAt: archivedAt,
    messagePreview: session.messagePreview,
    messageCount: 0,
    hasJsonl: true,
  };
}

async function listAllCodexThreads(
  params: CodexAppServerThreadListParams,
  maxRowsLimit = CODEX_THREAD_LIST_LIMIT,
): Promise<any[]> {
  return withCodexThreadListClient(getDefaultProcessCwd(), async (client) => {
    const maxRows = Math.max(
      1,
      Math.min(maxRowsLimit, Math.floor(Number(params.limit ?? maxRowsLimit))),
    );
    const threads: any[] = [];
    let cursor: string | null | undefined = params.cursor ?? null;
    do {
      const response = await client.listThreads({
        ...params,
        cursor,
        limit: Math.max(1, Math.min(maxRows - threads.length, maxRows)),
      }) as any;
      const page = Array.isArray(response?.data) ? response.data : [];
      threads.push(...page);
      cursor = response?.nextCursor || null;
    } while (cursor && threads.length < maxRows);
    return threads.slice(0, maxRows);
  });
}

function getDefaultProcessCwd(): string {
  return process.cwd();
}

async function listCodexNativeSessionsFromAppServer(useCache = true): Promise<SessionInfo[]> {
  const nowMs = Date.now();
  if (useCache && codexNativeSessionsCache && nowMs - codexNativeSessionsCache.at < CODEX_NATIVE_LIST_CACHE_MS) {
    return codexNativeSessionsCache.sessions;
  }

  const stored = readStore();
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const threads = await listAllCodexThreads({
    archived: false,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: CODEX_THREAD_LIST_SOURCE_KINDS,
    useStateDbOnly: true,
  });
  const sessions = threads.flatMap((thread): SessionInfo[] => {
    const id = String(thread?.id || "");
    const info = codexThreadToSessionInfo(thread, storedById.get(id));
    return info ? [info] : [];
  });
  codexNativeSessionsCache = { at: nowMs, sessions };
  return sessions;
}

function newestIso(values: Array<string | undefined>, fallback: string): string {
  let best = fallback;
  let bestMs = Date.parse(fallback);
  if (!Number.isFinite(bestMs)) bestMs = 0;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function sdkSessionInfoToSessionInfo(info: SDKSessionInfo, tracked?: SessionInfo): SessionInfo | null {
  if (!info.sessionId) return null;
  const cwd = tracked?.cwd || info.cwd;
  if (!cwd) return null;

  const fallbackMs = Date.now();
  const lastModified = typeof info.lastModified === "number" ? info.lastModified : fallbackMs;
  const nativeLastActive = isoFromMs(lastModified, fallbackMs);
  const messagePreview = cleanPreviewText(
    tracked?.messagePreview ||
    info.firstPrompt ||
    info.summary ||
    tracked?.title ||
    "Claude session"
  );
  const trackedTitle = tracked?.title && tracked.title !== "Untitled" ? tracked.title : "";
  const title = cleanPreviewText(
    trackedTitle ||
    info.customTitle ||
    info.summary ||
    info.firstPrompt ||
    messagePreview ||
    "Claude session"
  );

  return withCachedTurnCount({
    ...tracked,
    id: info.sessionId,
    title: title || "Claude session",
    cwd,
    createdAt: tracked?.createdAt || isoFromMs(info.createdAt, lastModified),
    lastActive: newestIso([tracked?.lastActive, nativeLastActive], nativeLastActive),
    messagePreview,
    backend: "claude",
  } as SessionInfo);
}

async function listClaudeNativeSessionsFromSdk(useCache = true): Promise<SessionInfo[]> {
  const nowMs = Date.now();
  if (useCache && claudeNativeSessionsCache && nowMs - claudeNativeSessionsCache.at < CODEX_NATIVE_LIST_CACHE_MS) {
    return claudeNativeSessionsCache.sessions;
  }

  const archivedIds = readArchivedSessionIds();
  const stored = readStore();
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const cwdCandidates = claudeNativeCwdCandidates();
  const deduped = new Map<string, SessionInfo>();
  let nextCwd = 0;
  const workerCount = Math.min(8, cwdCandidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextCwd < cwdCandidates.length) {
      const cwd = cwdCandidates[nextCwd++];
      try {
        const sdkSessions = await sdkListSessions({
          dir: cwd,
          limit: CLAUDE_NATIVE_SESSIONS_PER_CWD,
          includeWorktrees: true,
        });
        for (const info of sdkSessions) {
          if (archivedIds.has(info.sessionId)) continue;
          const session = sdkSessionInfoToSessionInfo(info, storedById.get(info.sessionId));
          if (session) deduped.set(session.id, session);
        }
      } catch (err: any) {
        console.warn(`[SdkSessions] Native Claude listSessions failed for ${cwd}: ${err?.message || err}`);
      }
    }
  }));
  const sessions = [...deduped.values()]
    .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
  claudeNativeSessionsCache = { at: nowMs, sessions };
  return sessions;
}

export async function getClaudeNativeSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
  if (!sessionId) return undefined;
  const sessions = await listClaudeNativeSessionsFromSdk(false);
  return sessions.find((session) => session.id === sessionId);
}

function claudeNativeCwdCandidates(): string[] {
  const seen = new Set<string>();
  const add = (cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.trim() === "") return;
    seen.add(path.resolve(cwd.trim()));
  };
  for (const cwd of getRecentCwds()) add(cwd);
  for (const session of readStore()) {
    if ((session.backend ?? "claude") === "claude") add(session.cwd);
  }
  // Claude's prompt history provides the machine-wide project inventory that
  // the SDK's directory-scoped listSessions API does not expose by itself.
  const historyPath = path.join(
    process.env.HOME || require("os").homedir(),
    ".claude",
    "history.jsonl",
  );
  try {
    for (const line of fs.readFileSync(historyPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        add(JSON.parse(line)?.project);
      } catch {}
    }
  } catch {}
  // Newer/cleaner Claude installs may not retain history.jsonl. Recover each
  // native project's real cwd from the transcript metadata instead of trying
  // to reverse Claude's lossy encoded directory name.
  const projectsRoot = path.join(
    process.env.HOME || require("os").homedir(),
    ".claude",
    "projects",
  );
  try {
    for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectPath = path.join(projectsRoot, project.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(projectPath)
          .filter((file) => file.endsWith(".jsonl") && !file.startsWith("agent-"))
          .sort((left, right) => {
            try {
              return fs.statSync(path.join(projectPath, right)).mtimeMs
                - fs.statSync(path.join(projectPath, left)).mtimeMs;
            } catch {
              return 0;
            }
          });
      } catch {}
      for (const file of files.slice(0, 3)) {
        try {
          const filePath = path.join(projectPath, file);
          const stat = fs.statSync(filePath);
          const fd = fs.openSync(filePath, "r");
          const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
          fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          for (const line of buffer.toString("utf8").split("\n")) {
            if (!line) continue;
            try {
              const entry = JSON.parse(line);
              const candidate = entry?.cwd || entry?.project || entry?.message?.cwd;
              if (candidate) {
                add(candidate);
                break;
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  add(getDefaultProcessCwd());
  return [...seen].slice(0, Math.max(CLAUDE_NATIVE_CWD_LIMIT, 2000));
}

function mergeClaudeNativeSession(existing: SessionInfo, nativeSession: SessionInfo): SessionInfo {
  const existingTitle = existing.title && existing.title !== "Untitled" ? existing.title : "";
  return withCachedTurnCount({
    ...nativeSession,
    ...existing,
    title: existingTitle || nativeSession.title,
    cwd: existing.cwd || nativeSession.cwd,
    lastActive: newestIso([existing.lastActive, nativeSession.lastActive], nativeSession.lastActive),
    messagePreview: existing.messagePreview || nativeSession.messagePreview,
    backend: "claude",
  } as SessionInfo);
}

export async function listSessionsWithNativeCodex(useCache = true): Promise<SessionInfo[]> {
  const stored = listSessions();
  let native: SessionInfo[];
  try {
    native = await listCodexNativeSessionsFromAppServer(useCache);
  } catch (err: any) {
    console.warn(`[CodexThreads] native session list failed: ${err?.message || String(err)}`);
    return stored.map(withCachedTurnCount);
  }

  const nativeById = new Map(native.map((s) => [s.id, s]));
  const merged: SessionInfo[] = [];
  for (const session of stored) {
    const nativeSession = nativeById.get(session.id);
    if (nativeSession) {
      const storedTitle = session.title?.trim();
      merged.push({
        ...session,
        ...nativeSession,
        title: storedTitle && storedTitle !== "Untitled"
          ? storedTitle
          : nativeSession.title,
        messagePreview: session.messagePreview || nativeSession.messagePreview,
        turnCount: normalizedTurnCount(session.turnCount ?? nativeSession.turnCount) ?? 0,
        historyCount: normalizedTurnCount((session as any).historyCount ?? (nativeSession as any).historyCount),
        lastUsage: session.lastUsage,
        scheduledTaskId: session.scheduledTaskId,
        permissionMode: session.permissionMode,
        contextClearedAt: session.contextClearedAt,
        ...(session as any).lastContextUsage ? { lastContextUsage: (session as any).lastContextUsage } : {},
      } as SessionInfo);
      nativeById.delete(session.id);
      continue;
    }

    if (
      native.length > 0
      &&
      session.backend === "codex"
      && (session as any).codexDriver === "app-server"
      && !(session as any).contextClearedAt
      && isCodexThreadArchived(session.id)
    ) {
      deleteSession(session.id);
      console.log(`[CodexThreads] Removed archived native Codex session ${session.id} from SocketAgent store`);
      continue;
    }

    merged.push(withCachedTurnCount(session));
  }

  merged.push(...Array.from(nativeById.values()).map(withCachedTurnCount));
  return merged.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
}

export async function listSessionsWithNativeBackends(useCache = true): Promise<SessionInfo[]> {
  const startedAt = Date.now();
  const merged = await listSessionsWithNativeCodex(useCache);
  let claudeNative: SessionInfo[];
  try {
    claudeNative = await listClaudeNativeSessionsFromSdk(useCache);
  } catch (err: any) {
    console.warn(`[SdkSessions] Native Claude global listSessions failed: ${err?.message || err}`);
    warnIfSlow("session_list_native", startedAt, { count: merged.length, claude: "failed", useCache });
    return merged;
  }

  const byId = new Map(merged.map((s) => [s.id, s]));
  for (const nativeSession of claudeNative) {
    const existing = byId.get(nativeSession.id);
    if (!existing) {
      byId.set(nativeSession.id, nativeSession);
      continue;
    }
    if ((existing.backend ?? "claude") === "claude") {
      byId.set(nativeSession.id, mergeClaudeNativeSession(existing, nativeSession));
    }
  }

  const sessions = [...byId.values()].sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
  warnIfSlow("session_list_native", startedAt, { count: sessions.length, useCache });
  return sessions;
}

export async function listArchivesWithNativeCodex(useCache = true): Promise<ArchiveEntry[]> {
  const legacy = listArchives();
  const nowMs = Date.now();
  let nativeArchives: ArchiveEntry[];
  if (useCache && codexNativeArchivesCache && nowMs - codexNativeArchivesCache.at < CODEX_NATIVE_LIST_CACHE_MS) {
    nativeArchives = codexNativeArchivesCache.archives;
  } else {
    try {
      const threads = await listAllCodexThreads({
        archived: true,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: CODEX_THREAD_LOOKUP_SOURCE_KINDS,
        useStateDbOnly: true,
      });
      nativeArchives = threads.flatMap((thread): ArchiveEntry[] => {
        const entry = codexThreadToArchiveEntry(thread);
        return entry ? [entry] : [];
      });
      codexNativeArchivesCache = { at: nowMs, archives: nativeArchives };
    } catch (err: any) {
      console.warn(`[CodexThreads] native archive list failed: ${err?.message || String(err)}`);
      nativeArchives = listCodexNativeArchives();
    }
  }

  const byKey = new Map<string, ArchiveEntry>();
  for (const entry of legacy) byKey.set(`${entry.backend || ""}:${entry.sid}`, entry);
  for (const entry of nativeArchives) byKey.set(`codex:${entry.sid}`, entry);
  return [...byKey.values()].sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));
}

export async function getCodexNativeThreadSessionInfo(sessionId: string, cwd = getDefaultProcessCwd()): Promise<SessionInfo | null> {
  if (isCodexThreadArchived(sessionId)) {
    return null;
  }
  try {
    return await withCodexThreadListClient(cwd, async (client) => {
      const response = await client.readThread({ threadId: sessionId, includeTurns: false }) as any;
      if (codexThreadPayloadIsArchived(response?.thread)) return null;
      return codexThreadToSessionInfo(response?.thread);
    });
  } catch (err: any) {
    console.warn(`[CodexThreads] thread/read failed for ${sessionId}: ${err?.message || String(err)}`);
    if (isCodexThreadArchived(sessionId)) return null;
    return getCodexThreadSessionInfo(sessionId);
  }
}

export async function restoreCodexNativeArchive(sessionId: string, cwd = getDefaultProcessCwd()): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: string }> {
  try {
    const session = await withCodexThreadListClient(cwd, async (client) => {
      const response = await client.unarchiveThread(sessionId) as any;
      const fromResponse = codexThreadToSessionInfo(response?.thread);
      if (fromResponse) return fromResponse;
      const read = await client.readThread({ threadId: sessionId, includeTurns: false }) as any;
      return codexThreadToSessionInfo(read?.thread);
    });
    if (!session) return { ok: false, reason: "Codex thread not found" };
    saveSession({ ...session, lastActive: nowIso(), codexDriver: "app-server" } as SessionInfo);
    invalidateCodexNativeListCache();
    return { ok: true, session: getSession(sessionId) || session };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

export async function renameCodexNativeThread(sessionId: string, cwd: string, title: string): Promise<void> {
  await withCodexThreadListClient(cwd || getDefaultProcessCwd(), async (client) => {
    await client.setThreadName(sessionId, title);
  });
  const session = getSession(sessionId);
  if (session) {
    session.title = title;
    session.lastActive = nowIso();
    saveSession(session);
  }
  invalidateCodexNativeListCache();
}

export async function listCodexNativeSdkSessions(cwd: string, limit = 30): Promise<SdkSessionEntry[]> {
  const cwdCandidates = cwdLookupCandidates(cwd);
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of readStore()) {
    if (s.backend === "codex" && setsIntersect(cwdLookupCandidates(s.cwd), cwdCandidates)) {
      trackedMap.set(s.id, s);
    }
  }

  const threads = await listAllCodexThreads({
    archived: false,
    cwd: [...cwdCandidates],
    limit: Math.max(1, Math.min(SDK_SESSION_DISCOVERY_LIMIT, Math.floor(limit))),
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: CODEX_THREAD_LOOKUP_SOURCE_KINDS,
    useStateDbOnly: true,
  }, SDK_SESSION_DISCOVERY_LIMIT);
  return threads.flatMap((thread): SdkSessionEntry[] => {
    const id = String(thread?.id || "");
    const info = codexThreadToSessionInfo(thread, trackedMap.get(id));
    if (!id || !info) return [];
    return [{
      sessionId: id,
      firstMessage: info.messagePreview || info.title || "Codex session",
      createdAt: info.createdAt,
      lastActive: info.lastActive,
      tracked: trackedMap.has(id),
      backend: "codex",
    }];
  });
}

/** On startup, close out any tool_calls that never got a result (e.g. server crashed mid-query) */
export function cleanupPendingToolCalls(): void {
  ensureHistoryDir();
  const sessionIds = historyDatabase().listSessionIds();
  for (const sessionId of sessionIds) {
    let pending: HistoryEntry[];
    try {
      pending = historyDatabase().pendingToolCalls(sessionId);
    } catch {
      continue;
    }
    let modified = 0;
    for (const entry of pending) {
      appendHistory(sessionId, {
        role: "tool_result",
        content: "",
        toolUseId: entry.toolUseId,
        toolOutput: "",
        timestamp: new Date().toISOString(),
      });
      modified++;
    }

    if (modified > 0) {
      console.log(`Cleaned up ${modified} pending tool calls in ${sessionId}`);
    }
  }
}

export interface HistoryStorageCompactResult {
  scanned: number;
  compacted: number;
  beforeBytes: number;
  afterBytes: number;
  warnings: string[];
}

export function compactHistoryStorage(_options: { minBytes?: number } = {}): HistoryStorageCompactResult {
  // SQLite migration applies tool-output compaction while importing each
  // session. Do not eagerly walk every retained JSON backup at startup: that
  // would defeat lazy migration and stall servers with years of transcripts.
  return {
    scanned: 0,
    compacted: 0,
    beforeBytes: 0,
    afterBytes: 0,
    warnings: [],
  };
}

// ── SDK session discovery ──

export interface SdkSessionEntry {
  sessionId: string;
  firstMessage: string;
  cwd?: string;
  title?: string;
  createdAt: string;
  lastActive: string;
  tracked: boolean; // true if already in SocketAgent store
  backend?: "claude" | "codex"; // absent on legacy entries; treat as claude
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

function isoFromMs(ms: number | undefined, fallbackMs: number): string {
  const value = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
  return new Date(value).toISOString();
}

function buildTrackedClaudeMap(): Map<string, SessionInfo> {
  const store = readStore();
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of store) {
    if ((s.backend ?? "claude") === "claude") trackedMap.set(s.id, s);
  }
  return trackedMap;
}

function sdkSessionInfoToEntry(info: SDKSessionInfo, trackedMap: Map<string, SessionInfo>): SdkSessionEntry | null {
  if (!info.sessionId) return null;
  const tracked = trackedMap.get(info.sessionId);
  const fallbackMs = Date.now();
  const lastModified = typeof info.lastModified === "number" ? info.lastModified : fallbackMs;
  const preview =
    tracked?.messagePreview ||
    tracked?.title ||
    info.firstPrompt ||
    info.summary ||
    "Untitled";

  return {
    sessionId: info.sessionId,
    firstMessage: preview.slice(0, 200),
    createdAt: tracked?.createdAt || isoFromMs(info.createdAt, lastModified),
    lastActive: tracked?.lastActive || isoFromMs(info.lastModified, fallbackMs),
    tracked: !!tracked,
    backend: "claude",
  };
}

/**
 * List Claude Code SDK sessions for a given CWD using Claude's native session
 * index. The SDK includes git worktree paths by default, which avoids stale
 * results from guessing Claude's on-disk project directory names ourselves.
 */
export async function listSdkSessions(cwd: string, limit = 30): Promise<SdkSessionEntry[]> {
  try {
    const trackedMap = buildTrackedClaudeMap();
    const sdkSessions = await sdkListSessions({
      dir: cwd,
      limit,
      includeWorktrees: true,
    });
    const deduped = new Map<string, SdkSessionEntry>();
    for (const info of sdkSessions) {
      const entry = sdkSessionInfoToEntry(info, trackedMap);
      if (entry) deduped.set(entry.sessionId, entry);
    }
    return [...deduped.values()]
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      .slice(0, limit);
  } catch (err: any) {
    console.warn(`[SdkSessions] Native Claude listSessions failed for ${cwd}: ${err?.message || err}`);
    return listSdkSessionsFromFiles(cwd, limit);
  }
}

/**
 * Legacy fallback for older SDK failures. Scans ~/.claude/projects directly.
 */
function listSdkSessionsFromFiles(cwd: string, limit = 30): SdkSessionEntry[] {
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
  const trackedMap = buildTrackedClaudeMap();

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
        backend: "claude",
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
        backend: "claude",
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
      backend: "claude",
    });

    // Stop once we have enough results
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Read the first line of a (potentially huge) file synchronously, growing the
 * buffer as needed. Caps at 1 MB to avoid pathological cases. Returns null on
 * read errors or if no newline appears within the cap.
 */
function readFirstLineSync(filePath: string): string | null {
  let fd: number;
  try { fd = fs.openSync(filePath, "r"); } catch { return null; }
  try {
    let buf = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
      const nl = buf.indexOf(0x0a); // '\n'
      if (nl >= 0) return buf.subarray(0, nl).toString("utf8");
      pos += bytesRead;
      if (buf.length > 1024 * 1024) break;
    }
  } catch {
    /* fall through */
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Locate a codex rollout file by thread id. Walks ~/.codex/sessions/ and
 * returns the first path whose filename ends with `-<sessionId>.jsonl`.
 * Returns null if not found.
 */
export function findCodexRolloutFile(sessionId: string): string | null {
  const indexedPath = findCodexRolloutPathFromStateDb(sessionId);
  if (indexedPath) return indexedPath;

  const homeDir = process.env.HOME || require("os").homedir();
  const roots = [
    path.join(homeDir, ".codex", "sessions"),
    path.join(homeDir, ".codex", "archived_sessions"),
  ].filter((dir) => fs.existsSync(dir));
  if (roots.length === 0) return null;

  const suffix = `-${sessionId}.jsonl`;
  let found: string | null = null;
  function walk(dir: string): void {
    if (found) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const p = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.isDirectory()) {
        walk(p);
      } else if (entry.endsWith(suffix)) {
        found = p;
        return;
      }
    }
  }
  for (const root of roots) {
    walk(root);
    if (found) break;
  }
  return found;
}

function archiveCodexNativeRollout(sessionId: string, rolloutPath: string): string {
  const homeDir = process.env.HOME || require("os").homedir();
  const archiveDir = path.join(homeDir, ".codex", "archived_sessions");
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const archivedPath = path.join(archiveDir, path.basename(rolloutPath));
  let finalPath = rolloutPath;
  const alreadyArchived = path.resolve(path.dirname(rolloutPath)) === path.resolve(archiveDir);
  if (!alreadyArchived && fs.existsSync(rolloutPath)) {
    if (fs.existsSync(archivedPath)) fs.unlinkSync(archivedPath);
    fs.renameSync(rolloutPath, archivedPath);
    finalPath = archivedPath;
  }
  updateCodexThreadRolloutState(sessionId, finalPath, true);
  return finalPath;
}

function updateCodexThreadRolloutState(sessionId: string, rolloutPath: string, archived: boolean): void {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return;
  const archivedAt = archived ? String(Math.floor(Date.now() / 1000)) : "NULL";
  const sql = `
    UPDATE threads
    SET rollout_path = ${sqlStringLiteral(rolloutPath)},
        archived = ${archived ? 1 : 0},
        archived_at = ${archivedAt}
    WHERE id = ${sqlStringLiteral(sessionId)};
  `;
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to update Codex thread state for ${sessionId}: ${err?.message || String(err)}`);
  }
}

function findCodexRolloutPathFromStateDb(sessionId: string): string | null {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const sql = `SELECT rollout_path FROM threads WHERE id = ${sqlStringLiteral(sessionId)} LIMIT 1;`;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }).trim();
    if (!raw) return null;
    const rows = JSON.parse(raw) as Array<{ rollout_path?: string }>;
    const rolloutPath = rows[0]?.rollout_path;
    return rolloutPath && fs.existsSync(rolloutPath) ? rolloutPath : null;
  } catch {
    return null;
  }
}

export function isCodexThreadArchived(sessionId: string): boolean {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const sql = `SELECT archived FROM threads WHERE id = ${sqlStringLiteral(sessionId)} LIMIT 1;`;
  try {
    const raw = execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }).trim();
    return raw === "1";
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to read archived state for ${sessionId}: ${err?.message || String(err)}`);
    return false;
  }
}

export function getCodexThreadSessionInfo(sessionId: string): SessionInfo | null {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      cwd,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE id = ${sqlStringLiteral(sessionId)}
    LIMIT 1;
  `;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }).trim();
    if (!raw) return null;
    const row = JSON.parse(raw)[0];
    if (!row?.id || !row?.cwd) return null;
    const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
    const lastActive = epochToIso(row.updated_at_ms ?? row.updated_at, createdAt);
    const preview = String(row.preview || row.first_user_message || "");
    const title = String(row.title || preview.split(/\r?\n/)[0] || "Codex session");
    return {
      id: String(row.id),
      title: title.length > 80 ? title.slice(0, 80) + "…" : title,
      cwd: String(row.cwd),
      createdAt,
      lastActive,
      messagePreview: preview.slice(0, 200),
      turnCount: 0,
      backend: "codex",
      codexDriver: "app-server",
    } as SessionInfo;
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to read thread metadata for ${sessionId}: ${err?.message || String(err)}`);
    return null;
  }
}

function listCodexNativeArchives(limit = 200): ArchiveEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      cwd,
      archived_at,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE archived = 1
    ORDER BY COALESCE(archived_at, updated_at) DESC, id DESC
    LIMIT ${safeLimit};
  `;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }).trim();
    if (!raw) return [];
    const rows = JSON.parse(raw) as any[];
    return rows.flatMap((row): ArchiveEntry[] => {
      const sessionId = String(row.id || "");
      if (!sessionId) return [];
      const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
      const clearedAt = epochToIso(row.archived_at ?? row.updated_at_ms ?? row.updated_at, createdAt);
      const preview = String(row.preview || row.first_user_message || "");
      const title = String(row.title || preview.split(/\r?\n/)[0] || "Codex session");
      return [{
        sid: sessionId,
        ts: `${CODEX_NATIVE_ARCHIVE_TS_PREFIX}${row.archived_at ?? row.updated_at ?? Date.now()}`,
        title: title.length > 80 ? title.slice(0, 80) + "…" : title,
        cwd: String(row.cwd || ""),
        backend: "codex",
        createdAt,
        clearedAt,
        messagePreview: preview.slice(0, 200),
        messageCount: 0,
        hasJsonl: true,
      }];
    });
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to list native Codex archives: ${err?.message || String(err)}`);
    return [];
  }
}

function buildCodexRolloutRestorePath(sessionId: string, archivePath: string): string | null {
  let timestamp = "";
  try {
    const firstLine = fs.readFileSync(archivePath, "utf-8").split("\n", 1)[0];
    if (firstLine) {
      const obj = JSON.parse(firstLine);
      if (typeof obj?.payload?.timestamp === "string") timestamp = obj.payload.timestamp;
    }
  } catch {}

  const d = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const stamp = d.toISOString().slice(0, 19).replace(/:/g, "-");
  const homeDir = process.env.HOME || require("os").homedir();
  return path.join(homeDir, ".codex", "sessions", year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

/**
 * Read a codex rollout file and translate it into SocketAgent HistoryEntry
 * items. Used to backfill chat history when resuming a codex session that
 * we don't already have local history for (e.g., one created via the codex
 * CLI directly, or before this session's machine ran the SocketAgent
 * server).
 *
 * Mapping:
 *   - event_msg user_message            → role: "user" (canonical user input,
 *     skipping the response_item duplicates that include AGENTS.md/permissions
 *     boilerplate codex injects on each turn)
 *   - response_item message role=assistant → role: "assistant"
 *   - response_item function_call       → role: "tool_call" (exec_command is
 *     re-labelled as "Bash" so the existing tool-call rendering picks it up)
 *   - response_item function_call_output → role: "tool_result"
 *   - response_item reasoning             → role: "assistant", thinking=true
 *   - everything else (session_meta, turn_context,
 *     event_msg token_count/task_started/etc.) → skipped
 */
export function readCodexRolloutHistory(sessionId: string): HistoryEntry[] {
  const file = findCodexRolloutFile(sessionId);
  if (!file) return [];

  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return codexRolloutJsonlToHistory(raw, { threadId: sessionId });
}

export async function readCodexAppServerThreadHistory(sessionId: string): Promise<HistoryEntry[]> {
  const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: codex.command,
    args: codex.args,
    env: codex.env,
    shell: codex.shell,
    requestTimeoutMs: 15_000,
    startupTimeoutMs: 15_000,
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
    const response = await client.readThread({ threadId: sessionId, includeTurns: true });
    return codexAppServerThreadToHistory((response as any)?.thread);
  } catch (err: any) {
    console.warn(`[CodexHistory] app-server thread/read failed for ${sessionId}: ${err?.message || String(err)}`);
    return [];
  } finally {
    await client.stop().catch(() => {});
  }
}

export interface CodexRolloutContextUsage {
  totalTokens: number;
  maxTokens: number;
  model?: string;
  effort?: string;
  categories: Array<{ name: string; tokens: number; color: string }>;
  source: "codex_rollout";
  lastTokenUsage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
  totalTokenUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
  rateLimits?: any;
}

export function readCodexRolloutAgentSettings(sessionId: string): Pick<AgentSessionSettings, "model" | "effort"> {
  const file = findCodexRolloutFile(sessionId);
  if (!file) return {};
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return {}; }

  let model: string | undefined;
  let effort: AgentSessionSettings["effort"];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "turn_context" || !obj.payload) continue;
    if (typeof obj.payload.model === "string") model = obj.payload.model;
    const candidate = obj.payload.effort;
    if (candidate === "minimal" || candidate === "low" || candidate === "medium" || candidate === "high"
      || candidate === "max" || candidate === "xhigh" || candidate === "ultra") {
      effort = candidate;
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Read the latest Codex token_count event for a thread. There is no public
 * `codex status <thread>` CLI surface today, but rollout files include
 * model_context_window and per-turn token usage after each turn.
 */
export function readCodexRolloutContextUsage(sessionId: string): CodexRolloutContextUsage | null {
  const file = findCodexRolloutFile(sessionId);
  if (!file) return null;

  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }

  let latestInfo: any = null;
  let latestRateLimits: any = null;
  let latestModel: string | undefined;
  let latestEffort: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const payload = obj.payload;
    if (!payload || typeof payload !== "object") continue;

    if (obj.type === "turn_context" && typeof payload.model === "string") {
      latestModel = payload.model;
      if (typeof payload.effort === "string") latestEffort = payload.effort;
      continue;
    }

    if (obj.type === "event_msg" && payload.type === "token_count" && payload.info) {
      latestInfo = payload.info;
      latestRateLimits = payload.rate_limits;
    }
  }

  const last = latestInfo?.last_token_usage;
  const maxTokens = Number(latestInfo?.model_context_window ?? 0);
  const inputTokens = Number(last?.input_tokens ?? 0);
  if (!last || inputTokens <= 0 || maxTokens <= 0) return null;

  const cached = Number(last.cached_input_tokens ?? 0);
  const uncached = Math.max(0, inputTokens - cached);
  const categories = [
    ...(cached > 0 ? [{ name: "Cached input", tokens: cached, color: "#89B4FA" }] : []),
    ...(uncached > 0 ? [{ name: "Uncached input", tokens: uncached, color: "#F9E2AF" }] : []),
  ];

  return {
    totalTokens: inputTokens,
    maxTokens,
    ...(latestModel ? { model: latestModel } : {}),
    ...(latestEffort ? { effort: latestEffort } : {}),
    categories,
    source: "codex_rollout",
    lastTokenUsage: {
      input_tokens: inputTokens,
      cached_input_tokens: cached,
      output_tokens: Number(last.output_tokens ?? 0),
      reasoning_output_tokens: Number(last.reasoning_output_tokens ?? 0),
      total_tokens: Number(last.total_tokens ?? 0),
    },
    ...(latestInfo.total_token_usage ? {
      totalTokenUsage: {
        input_tokens: Number(latestInfo.total_token_usage.input_tokens ?? 0),
        cached_input_tokens: Number(latestInfo.total_token_usage.cached_input_tokens ?? 0),
        output_tokens: Number(latestInfo.total_token_usage.output_tokens ?? 0),
        reasoning_output_tokens: Number(latestInfo.total_token_usage.reasoning_output_tokens ?? 0),
        total_tokens: Number(latestInfo.total_token_usage.total_tokens ?? 0),
      },
    } : {}),
    ...(latestRateLimits ? { rateLimits: latestRateLimits } : {}),
  };
}

function cwdLookupCandidates(cwd: string): Set<string> {
  const candidates = new Set<string>();
  const add = (p: string) => {
    if (!p) return;
    candidates.add(path.resolve(p));
    candidates.add(path.resolve(p).replace(/\/+$/, ""));
  };
  add(cwd);
  try { add(fs.realpathSync(cwd)); } catch {}
  try { add(fs.realpathSync.native(cwd)); } catch {}
  return candidates;
}

function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function epochToIso(value: unknown, fallback: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function listCodexSessionsFromStateDb(cwdCandidates: Set<string>, limit: number, trackedMap: Map<string, SessionInfo>): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath) || cwdCandidates.size === 0) return [];

  const cwdList = [...cwdCandidates].map(sqlStringLiteral).join(", ");
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      rollout_path,
      archived,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE archived = 0 AND cwd IN (${cwdList})
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC
    LIMIT ${safeLimit};
  `;

  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }).trim();
    if (!raw) return [];
    const rows = JSON.parse(raw) as any[];
    const results: SdkSessionEntry[] = [];
    for (const row of rows) {
      const sessionId = String(row.id || "");
      if (!sessionId) continue;
      const rolloutPath = findCodexRolloutFile(sessionId);
      if (!rolloutPath) continue;
      const tracked = trackedMap.get(sessionId);
      const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
      const lastActive = tracked?.lastActive || epochToIso(row.updated_at_ms ?? row.updated_at, createdAt);
      const firstMessage =
        tracked?.messagePreview ||
        tracked?.title ||
        String(row.preview || row.first_user_message || row.title || "Codex session");
      results.push({
        sessionId,
        firstMessage,
        createdAt,
        lastActive,
        tracked: !!tracked,
        backend: "codex",
      });
    }
    return results;
  } catch (err: any) {
    console.warn(`[CodexSessions] state DB lookup failed: ${err?.message || String(err)}`);
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * List Codex sessions for a given CWD. Prefer Codex's SQLite thread index
 * (`~/.codex/state_5.sqlite`), which is the modern app-server/CLI source of
 * truth. Fall back to scanning rollout JSONL files for older installs.
 */
export function listCodexSessions(cwd: string, limit = 30): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  const cwdCandidates = cwdLookupCandidates(cwd);

  const store = readStore();
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of store) {
    if (s.backend === "codex" && setsIntersect(cwdLookupCandidates(s.cwd), cwdCandidates)) {
      trackedMap.set(s.id, s);
    }
  }

  const stateDbSessions = listCodexSessionsFromStateDb(cwdCandidates, limit, trackedMap);
  if (stateDbSessions.length > 0) return stateDbSessions;
  if (!fs.existsSync(sessionsDir)) return [];

  // Walk the date-partitioned tree to gather candidate rollout files.
  const candidates: { filePath: string; mtimeMs: number }[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.isDirectory()) {
        walk(p);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        candidates.push({ filePath: p, mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(sessionsDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results: SdkSessionEntry[] = [];
  for (const { filePath, mtimeMs } of candidates) {
    const firstLine = readFirstLineSync(filePath);
    if (!firstLine) continue;

    let meta: any;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    if (meta?.type !== "session_meta" || !meta.payload) continue;
    if (!cwdCandidates.has(path.resolve(String(meta.payload.cwd || "")).replace(/\/+$/, ""))) continue;

    const sessionId = meta.payload.id as string | undefined;
    if (!sessionId) continue;
    const timestamp = (meta.payload.timestamp as string | undefined) || new Date(mtimeMs).toISOString();
    const tracked = trackedMap.get(sessionId);

    let firstMessage = "Codex session";
    if (tracked) {
      firstMessage = tracked.messagePreview || tracked.title || firstMessage;
    }

    results.push({
      sessionId,
      firstMessage,
      createdAt: timestamp,
      lastActive: tracked?.lastActive || new Date(mtimeMs).toISOString(),
      tracked: !!tracked,
      backend: "codex",
    });

    if (results.length >= limit) break;
  }

  return results;
}
