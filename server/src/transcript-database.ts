import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import type { HistoryEntry } from "./protocol";
import { socketAgentDataPath } from "./socket-agent-paths";

export interface TranscriptSummary {
  sessionId: string;
  entryCount: number;
  userPromptCount: number;
  latestTimestamp?: string;
  messagePreview?: string;
  latestConversationSeq?: number;
  legacyPath?: string;
  legacySize?: number;
  legacyMtimeMs?: number;
  migratedAt?: string;
  updatedAt: string;
}

export interface TranscriptLegacyFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface TranscriptSearchOptions {
  query: string;
  roles?: string[];
  toolName?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface TranscriptSearchHit {
  sessionSeq: number;
  entryId: string;
  revision: number;
  role: string;
  timestamp?: string;
  toolName?: string;
  preview: string;
  rank: number;
}

interface StoredTranscriptRow {
  session_seq: number;
  entry_id: string;
  revision: number;
  role: string;
  timestamp: string | null;
  tool_name: string | null;
  position_key: string | null;
  entry_json: string;
}

interface StoredSummaryRow {
  session_id: string;
  entry_count: number;
  user_prompt_count: number;
  latest_timestamp: string | null;
  message_preview: string | null;
  latest_conversation_seq: number | null;
  legacy_path: string | null;
  legacy_size: number | null;
  legacy_mtime_ms: number | null;
  migrated_at: string | null;
  updated_at: string;
}

function cleanPreview(value: unknown, limit = 200): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function searchableText(entry: HistoryEntry): string {
  const parts: string[] = [];
  if (entry.content) parts.push(String(entry.content));
  if (entry.toolName) parts.push(String(entry.toolName));
  if (entry.toolInput) parts.push(JSON.stringify(entry.toolInput));
  if (entry.toolOutputPreview) parts.push(String(entry.toolOutputPreview));
  else if (entry.toolOutput) parts.push(String(entry.toolOutput));
  if (entry.progressSummary) parts.push(String(entry.progressSummary));
  const limit = entry.role === "user" || entry.role === "assistant"
    ? 64 * 1024
    : entry.role === "tool_result"
      ? 4 * 1024
      : 16 * 1024;
  return parts.join("\n").slice(0, limit);
}

function searchTokens(query: string): string[] {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_@./:-]+/gu)
    ?.map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 24) || [];
  if (tokens.length === 0) throw new Error("Remember search requires at least one searchable word");
  return tokens;
}

function safeFtsQuery(query: string): string {
  return searchTokens(query)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function parseEntry(row: StoredTranscriptRow): HistoryEntry {
  return JSON.parse(row.entry_json) as HistoryEntry;
}

function summaryFromRow(row: StoredSummaryRow): TranscriptSummary {
  return {
    sessionId: row.session_id,
    entryCount: Number(row.entry_count),
    userPromptCount: Number(row.user_prompt_count),
    ...(row.latest_timestamp ? { latestTimestamp: row.latest_timestamp } : {}),
    ...(row.message_preview ? { messagePreview: row.message_preview } : {}),
    ...(row.latest_conversation_seq !== null
      ? { latestConversationSeq: Number(row.latest_conversation_seq) }
      : {}),
    ...(row.legacy_path ? { legacyPath: row.legacy_path } : {}),
    ...(row.legacy_size !== null ? { legacySize: Number(row.legacy_size) } : {}),
    ...(row.legacy_mtime_ms !== null ? { legacyMtimeMs: Number(row.legacy_mtime_ms) } : {}),
    ...(row.migrated_at ? { migratedAt: row.migrated_at } : {}),
    updatedAt: row.updated_at,
  };
}

/**
 * Durable transcript storage. SQLite WAL makes ordinary history writes a
 * single-row transaction instead of rewriting a session-sized JSON array.
 */
export class TranscriptDatabase {
  readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly insertEntry: StatementSync;
  private readonly entryRowId: StatementSync;
  private readonly deleteSearchEntry: StatementSync;
  private readonly insertSearchEntry: StatementSync;
  private readonly deleteSearchSession: StatementSync;
  private readonly ftsEnabled: boolean;
  private readonly searchTable: "transcript_fts" | "transcript_search";

  constructor(
    filePath = socketAgentDataPath("history", "transcripts.sqlite"),
    options: { disableFts?: boolean } = {},
  ) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL");
    try { fs.chmodSync(filePath, 0o600); } catch {}
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA wal_autocheckpoint=1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_sessions (
        session_id TEXT PRIMARY KEY,
        entry_count INTEGER NOT NULL DEFAULT 0,
        user_prompt_count INTEGER NOT NULL DEFAULT 0,
        latest_timestamp TEXT,
        message_preview TEXT,
        latest_conversation_seq INTEGER,
        legacy_path TEXT,
        legacy_size INTEGER,
        legacy_mtime_ms REAL,
        migrated_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transcript_entries (
        session_id TEXT NOT NULL,
        session_seq INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        position_key TEXT,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (session_id, session_seq),
        UNIQUE (session_id, entry_id),
        FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transcript_entries_entry_id
        ON transcript_entries(session_id, entry_id);
      CREATE INDEX IF NOT EXISTS transcript_entries_position_key
        ON transcript_entries(session_id, position_key) WHERE position_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS transcript_entries_role_seq
        ON transcript_entries(session_id, role, session_seq);
      CREATE INDEX IF NOT EXISTS transcript_entries_timestamp
        ON transcript_entries(session_id, timestamp);
    `);
    const schemaVersion = Number((this.db.prepare("PRAGMA user_version").get() as unknown as {
      user_version: number;
    }).user_version);
    const hadFtsTable = !!this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_fts'",
    ).get();
    let ftsEnabled = false;
    if (!options.disableFts) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
            session_id UNINDEXED,
            session_seq UNINDEXED,
            entry_id UNINDEXED,
            role UNINDEXED,
            tool_name UNINDEXED,
            body,
            tokenize='unicode61 remove_diacritics 2'
          )
        `);
        ftsEnabled = true;
      } catch (error) {
        if (!String(error).toLowerCase().includes("fts5")) throw error;
        console.warn("[History] SQLite FTS5 is unavailable; using the portable transcript search index");
      }
    }
    if (ftsEnabled && (!hadFtsTable || schemaVersion < 2)) {
      console.error(`[History] Rebuilding transcript FTS rowid index (schema ${schemaVersion} -> 2)`);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("DROP TABLE IF EXISTS transcript_fts");
        this.db.exec(`
          CREATE VIRTUAL TABLE transcript_fts USING fts5(
            session_id UNINDEXED,
            session_seq UNINDEXED,
            entry_id UNINDEXED,
            role UNINDEXED,
            tool_name UNINDEXED,
            body,
            tokenize='unicode61 remove_diacritics 2'
          );
          INSERT INTO transcript_fts(rowid, session_id, session_seq, entry_id, role, tool_name, body)
          SELECT rowid, session_id, session_seq, entry_id,
            CASE WHEN json_extract(entry_json, '$.thinking') THEN 'thinking' ELSE role END,
            COALESCE(tool_name, ''),
            CASE
              WHEN role IN ('user', 'assistant') THEN substr(
                COALESCE(json_extract(entry_json, '$.content'), ''), 1, 65536)
              WHEN role = 'tool_result' THEN substr(
                COALESCE(json_extract(entry_json, '$.toolOutputPreview'),
                  json_extract(entry_json, '$.content'), ''), 1, 4096)
              ELSE substr(
                COALESCE(json_extract(entry_json, '$.content'), '') || char(10) ||
                COALESCE(json_extract(entry_json, '$.toolName'), '') || char(10) ||
                COALESCE(json_extract(entry_json, '$.toolInput'), ''), 1, 16384)
            END
          FROM transcript_entries;
          PRAGMA user_version=2;
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (!ftsEnabled) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcript_search (
          session_id TEXT NOT NULL,
          session_seq INTEGER NOT NULL,
          entry_id TEXT NOT NULL,
          role TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          body TEXT NOT NULL,
          PRIMARY KEY (session_id, entry_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS transcript_search_session_seq
          ON transcript_search(session_id, session_seq);
        CREATE INDEX IF NOT EXISTS transcript_search_role
          ON transcript_search(session_id, role);
      `);
      if (schemaVersion < 2) this.db.exec("PRAGMA user_version=2");
    }
    this.ftsEnabled = ftsEnabled;
    this.searchTable = ftsEnabled ? "transcript_fts" : "transcript_search";
    const entryColumns = this.db.prepare("PRAGMA table_info(transcript_entries)")
      .all() as unknown as Array<{ name: string }>;
    if (!entryColumns.some((column) => column.name === "tool_use_id")) {
      this.db.exec("ALTER TABLE transcript_entries ADD COLUMN tool_use_id TEXT");
      this.db.exec(`UPDATE transcript_entries
        SET tool_use_id = json_extract(entry_json, '$.toolUseId')
        WHERE tool_use_id IS NULL`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS transcript_entries_tool_use
      ON transcript_entries(session_id, tool_use_id, role) WHERE tool_use_id IS NOT NULL`);
    this.insertEntry = this.db.prepare(`
      INSERT INTO transcript_entries (
        session_id, session_seq, entry_id, revision, role, timestamp,
        tool_name, tool_use_id, position_key, entry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, entry_id) DO UPDATE SET
        session_seq=excluded.session_seq,
        revision=excluded.revision,
        role=excluded.role,
        timestamp=excluded.timestamp,
        tool_name=excluded.tool_name,
        tool_use_id=excluded.tool_use_id,
        position_key=excluded.position_key,
        entry_json=excluded.entry_json
    `);
    this.entryRowId = this.db.prepare(
      "SELECT rowid FROM transcript_entries WHERE session_id = ? AND entry_id = ?",
    );
    this.deleteSearchEntry = this.ftsEnabled
      ? this.db.prepare("DELETE FROM transcript_fts WHERE rowid = ?")
      : this.db.prepare("DELETE FROM transcript_search WHERE session_id = ? AND entry_id = ?");
    this.insertSearchEntry = this.ftsEnabled
      ? this.db.prepare(`
          INSERT INTO transcript_fts(rowid, session_id, session_seq, entry_id, role, tool_name, body)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
      : this.db.prepare(`
          INSERT INTO transcript_search(session_id, session_seq, entry_id, role, tool_name, body)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
    this.deleteSearchSession = this.ftsEnabled
      ? this.db.prepare(`
          DELETE FROM transcript_fts WHERE rowid IN (
            SELECT rowid FROM transcript_entries WHERE session_id = ?
          )
        `)
      : this.db.prepare("DELETE FROM transcript_search WHERE session_id = ?");
  }

  close(): void {
    this.db.close();
  }

  hasSession(sessionId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM transcript_sessions WHERE session_id = ?",
    ).get(sessionId);
  }

  listSessionIds(): string[] {
    return (this.db.prepare(
      "SELECT session_id FROM transcript_sessions ORDER BY updated_at DESC",
    ).all() as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  summary(sessionId: string): TranscriptSummary | undefined {
    const row = this.db.prepare(
      "SELECT * FROM transcript_sessions WHERE session_id = ?",
    ).get(sessionId) as unknown as StoredSummaryRow | undefined;
    return row ? summaryFromRow(row) : undefined;
  }

  legacyMatches(sessionId: string, fingerprint: TranscriptLegacyFingerprint): boolean {
    const summary = this.summary(sessionId);
    return !!summary
      && summary.legacyPath === fingerprint.path
      && summary.legacySize === fingerprint.size
      && Math.abs((summary.legacyMtimeMs ?? -1) - fingerprint.mtimeMs) < 1;
  }

  maxSessionSeq(sessionId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(session_seq), 0) AS value FROM transcript_entries WHERE session_id = ?",
    ).get(sessionId) as unknown as { value: number };
    return Number(row.value);
  }

  findPosition(
    sessionId: string,
    entryId?: string,
    positionKey?: string | null,
  ): { entryId: string; sessionSeq: number; revision: number } | undefined {
    const row = entryId
      ? this.db.prepare(`
          SELECT entry_id, session_seq, revision FROM transcript_entries
          WHERE session_id = ? AND entry_id = ?
        `).get(sessionId, entryId)
      : positionKey
        ? this.db.prepare(`
            SELECT entry_id, session_seq, revision FROM transcript_entries
            WHERE session_id = ? AND position_key = ? ORDER BY session_seq DESC LIMIT 1
          `).get(sessionId, positionKey)
        : undefined;
    if (!row) return undefined;
    const typed = row as unknown as { entry_id: string; session_seq: number; revision: number };
    return {
      entryId: typed.entry_id,
      sessionSeq: Number(typed.session_seq),
      revision: Number(typed.revision),
    };
  }

  getByEntryId(sessionId: string, entryId: string): HistoryEntry | undefined {
    const row = this.db.prepare(`
      SELECT * FROM transcript_entries WHERE session_id = ? AND entry_id = ?
    `).get(sessionId, entryId) as unknown as StoredTranscriptRow | undefined;
    return row ? parseEntry(row) : undefined;
  }

  getBySessionSeq(sessionId: string, sessionSeq: number): HistoryEntry | undefined {
    const row = this.db.prepare(`
      SELECT * FROM transcript_entries WHERE session_id = ? AND session_seq = ?
    `).get(sessionId, sessionSeq) as unknown as StoredTranscriptRow | undefined;
    return row ? parseEntry(row) : undefined;
  }

  getAll(sessionId: string): HistoryEntry[] {
    return (this.db.prepare(`
      SELECT * FROM transcript_entries WHERE session_id = ? ORDER BY session_seq
    `).all(sessionId) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }

  count(sessionId: string): number {
    return this.summary(sessionId)?.entryCount ?? 0;
  }

  countCompactionBoundaries(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS value
      FROM transcript_entries
      WHERE session_id = ?
        AND role = 'assistant'
        AND json_extract(entry_json, '$.content') LIKE '[compact_boundary:%'
    `).get(sessionId) as unknown as { value: number };
    return Number(row.value);
  }

  getPage(sessionId: string, offset: number, limit: number): HistoryEntry[] {
    return (this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? ORDER BY session_seq LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }

  getTail(sessionId: string, limit: number): HistoryEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? ORDER BY session_seq DESC LIMIT ?
    `).all(sessionId, limit) as unknown as StoredTranscriptRow[];
    return rows.reverse().map(parseEntry);
  }

  list(
    sessionId: string,
    limit: number,
    cursor?: number,
    direction: "before" | "after" = "before",
  ): HistoryEntry[] {
    const boundedLimit = Math.max(1, Math.min(50, limit));
    if (cursor === undefined) return this.getTail(sessionId, boundedLimit);
    if (direction === "after") return this.getAfter(sessionId, cursor, boundedLimit);
    const rows = this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? AND session_seq < ?
      ORDER BY session_seq DESC LIMIT ?
    `).all(sessionId, cursor, boundedLimit) as unknown as StoredTranscriptRow[];
    return rows.reverse().map(parseEntry);
  }

  getAfter(sessionId: string, sessionSeq: number, limit: number): HistoryEntry[] {
    return (this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? AND session_seq > ? ORDER BY session_seq LIMIT ?
    `).all(sessionId, sessionSeq, limit) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }

  getByRole(sessionId: string, role: string): HistoryEntry[] {
    return (this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? AND role = ? ORDER BY session_seq
    `).all(sessionId, role) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }

  countThroughSessionSeq(sessionId: string, sessionSeq: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS value FROM transcript_entries
      WHERE session_id = ? AND session_seq <= ?
    `).get(sessionId, sessionSeq) as unknown as { value: number };
    return Number(row.value);
  }

  offsetForSessionSeq(sessionId: string, sessionSeq: number): number | undefined {
    if (!this.getBySessionSeq(sessionId, sessionSeq)) return undefined;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS value FROM transcript_entries
      WHERE session_id = ? AND session_seq < ?
    `).get(sessionId, sessionSeq) as unknown as { value: number };
    return Number(row.value);
  }

  recentUserPromptOffset(sessionId: string, promptCount: number): number | undefined {
    if (promptCount <= 0) return undefined;
    const row = this.db.prepare(`
      SELECT session_seq FROM transcript_entries
      WHERE session_id = ? AND role = 'user'
      ORDER BY session_seq DESC LIMIT 1 OFFSET ?
    `).get(sessionId, promptCount - 1) as unknown as { session_seq: number } | undefined;
    return row ? this.offsetForSessionSeq(sessionId, Number(row.session_seq)) : undefined;
  }

  private ensureSessionRow(sessionId: string): void {
    this.db.prepare(`
      INSERT INTO transcript_sessions(session_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, new Date().toISOString());
  }

  private writeEntry(
    sessionId: string,
    entry: HistoryEntry,
    positionKey: string | null,
    indexSearch = true,
  ): void {
    const sessionSeq = Number(entry.sessionSeq);
    const entryId = String(entry.entryId || "");
    if (!Number.isSafeInteger(sessionSeq) || sessionSeq <= 0 || !entryId) {
      throw new Error(`Transcript entry lacks a durable position for ${sessionId}`);
    }
    const body = searchableText(entry);
    this.insertEntry.run(
      sessionId,
      sessionSeq,
      entryId,
      Number(entry.revision || 1),
      String(entry.role || "unknown"),
      entry.timestamp || null,
      entry.toolName || null,
      entry.toolUseId || null,
      positionKey,
      JSON.stringify(entry),
    );
    const rowId = this.ftsEnabled
      ? Number((this.entryRowId.get(sessionId, entryId) as unknown as { rowid: number }).rowid)
      : 0;
    if (indexSearch) {
      if (this.ftsEnabled) this.deleteSearchEntry.run(rowId);
      else this.deleteSearchEntry.run(sessionId, entryId);
    }
    if (indexSearch && body) {
      const searchValues = [
        sessionId,
        sessionSeq,
        entryId,
        entry.thinking ? "thinking" : String(entry.role || "unknown"),
        entry.toolName || "",
        body,
      ];
      if (this.ftsEnabled) this.insertSearchEntry.run(rowId, ...searchValues);
      else this.insertSearchEntry.run(...searchValues);
    }
  }

  private recomputeSummary(sessionId: string): void {
    const aggregate = this.db.prepare(`
      SELECT COUNT(*) AS entry_count,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_prompt_count,
        MAX(timestamp) AS latest_timestamp
      FROM transcript_entries WHERE session_id = ?
    `).get(sessionId) as unknown as {
      entry_count: number;
      user_prompt_count: number | null;
      latest_timestamp: string | null;
    };
    const conversation = this.db.prepare(`
      SELECT session_seq, entry_json FROM transcript_entries
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY session_seq DESC LIMIT 1
    `).get(sessionId) as unknown as { session_seq: number; entry_json: string } | undefined;
    const preview = conversation
      ? cleanPreview((JSON.parse(conversation.entry_json) as HistoryEntry).content)
      : "";
    this.db.prepare(`
      UPDATE transcript_sessions SET
        entry_count = ?, user_prompt_count = ?, latest_timestamp = ?,
        message_preview = ?, latest_conversation_seq = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      Number(aggregate.entry_count),
      Number(aggregate.user_prompt_count || 0),
      aggregate.latest_timestamp,
      preview || null,
      conversation ? Number(conversation.session_seq) : null,
      new Date().toISOString(),
      sessionId,
    );
  }

  upsert(sessionId: string, entry: HistoryEntry, positionKey: string | null): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureSessionRow(sessionId);
      this.writeEntry(sessionId, entry, positionKey);
      this.recomputeSummary(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertMany(
    sessionId: string,
    entries: Array<{ entry: HistoryEntry; positionKey: string | null }>,
  ): void {
    if (entries.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureSessionRow(sessionId);
      for (const item of entries) this.writeEntry(sessionId, item.entry, item.positionKey);
      this.recomputeSummary(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replace(
    sessionId: string,
    entries: Array<{ entry: HistoryEntry; positionKey: string | null }>,
    legacy?: TranscriptLegacyFingerprint,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureSessionRow(sessionId);
      this.deleteSearchSession.run(sessionId);
      this.db.prepare("DELETE FROM transcript_entries WHERE session_id = ?").run(sessionId);
      for (const item of entries) {
        this.writeEntry(sessionId, item.entry, item.positionKey, !this.ftsEnabled);
      }
      if (this.ftsEnabled) {
        this.db.prepare(`
          INSERT INTO transcript_fts(rowid, session_id, session_seq, entry_id, role, tool_name, body)
          SELECT rowid, session_id, session_seq, entry_id,
            CASE WHEN json_extract(entry_json, '$.thinking') THEN 'thinking' ELSE role END,
            COALESCE(tool_name, ''),
            CASE
              WHEN role IN ('user', 'assistant') THEN substr(
                COALESCE(json_extract(entry_json, '$.content'), ''), 1, 65536
              )
              WHEN role = 'tool_result' THEN substr(
                COALESCE(json_extract(entry_json, '$.toolOutputPreview'),
                  json_extract(entry_json, '$.content'), ''), 1, 4096
              )
              ELSE substr(
                COALESCE(json_extract(entry_json, '$.content'), '') || char(10) ||
                COALESCE(json_extract(entry_json, '$.toolName'), '') || char(10) ||
                COALESCE(json_extract(entry_json, '$.toolInput'), ''), 1, 16384
              )
            END
          FROM transcript_entries WHERE session_id = ?
        `).run(sessionId);
      }
      this.recomputeSummary(sessionId);
      if (legacy) {
        this.db.prepare(`
          UPDATE transcript_sessions SET legacy_path = ?, legacy_size = ?,
            legacy_mtime_ms = ?, migrated_at = ?, updated_at = ?
          WHERE session_id = ?
        `).run(
          legacy.path,
          legacy.size,
          legacy.mtimeMs,
          new Date().toISOString(),
          new Date().toISOString(),
          sessionId,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteSearchSession.run(sessionId);
      this.db.prepare("DELETE FROM transcript_sessions WHERE session_id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(sessionId: string, options: TranscriptSearchOptions): TranscriptSearchHit[] {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    if (!this.ftsEnabled) return this.searchWithoutFts(sessionId, options, limit, offset);
    const where = ["transcript_fts MATCH ?", "f.session_id = ?"];
    const params: Array<string | number> = [safeFtsQuery(options.query), sessionId];
    if (options.roles?.length) {
      where.push(`f.role IN (${options.roles.map(() => "?").join(",")})`);
      params.push(...options.roles);
    }
    if (options.toolName) {
      where.push("f.tool_name = ?");
      params.push(options.toolName);
    }
    if (options.since) {
      where.push("e.timestamp >= ?");
      params.push(options.since);
    }
    if (options.until) {
      where.push("e.timestamp <= ?");
      params.push(options.until);
    }
    params.push(limit, offset);
    const rows = this.db.prepare(`
      SELECT e.session_seq, e.entry_id, e.revision, f.role, e.timestamp,
        e.tool_name,
        snippet(transcript_fts, 5, '[', ']', '…', 24) AS preview,
        bm25(transcript_fts) AS rank
      FROM transcript_fts AS f
      JOIN transcript_entries AS e
        ON e.session_id = f.session_id AND e.entry_id = f.entry_id
      WHERE ${where.join(" AND ")}
      ORDER BY rank, e.session_seq DESC
      LIMIT ? OFFSET ?
    `).all(...params) as unknown as Array<{
      session_seq: number;
      entry_id: string;
      revision: number;
      role: string;
      timestamp: string | null;
      tool_name: string | null;
      preview: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      sessionSeq: Number(row.session_seq),
      entryId: row.entry_id,
      revision: Number(row.revision),
      role: row.role,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      preview: row.preview,
      rank: Number(row.rank),
    }));
  }

  private searchWithoutFts(
    sessionId: string,
    options: TranscriptSearchOptions,
    limit: number,
    offset: number,
  ): TranscriptSearchHit[] {
    const tokens = searchTokens(options.query);
    const where = ["s.session_id = ?", ...tokens.map(() => "instr(lower(s.body), lower(?)) > 0")];
    const params: Array<string | number> = [sessionId, ...tokens];
    if (options.roles?.length) {
      where.push(`s.role IN (${options.roles.map(() => "?").join(",")})`);
      params.push(...options.roles);
    }
    if (options.toolName) {
      where.push("s.tool_name = ?");
      params.push(options.toolName);
    }
    if (options.since) {
      where.push("e.timestamp >= ?");
      params.push(options.since);
    }
    if (options.until) {
      where.push("e.timestamp <= ?");
      params.push(options.until);
    }
    params.push(limit, offset);
    const rows = this.db.prepare(`
      SELECT e.session_seq, e.entry_id, e.revision, s.role, e.timestamp,
        e.tool_name, substr(s.body, 1, 240) AS preview
      FROM transcript_search AS s
      JOIN transcript_entries AS e
        ON e.session_id = s.session_id AND e.entry_id = s.entry_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.session_seq DESC
      LIMIT ? OFFSET ?
    `).all(...params) as unknown as Array<{
      session_seq: number;
      entry_id: string;
      revision: number;
      role: string;
      timestamp: string | null;
      tool_name: string | null;
      preview: string;
    }>;
    return rows.map((row) => ({
      sessionSeq: Number(row.session_seq),
      entryId: row.entry_id,
      revision: Number(row.revision),
      role: row.role,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      preview: cleanPreview(row.preview),
      rank: 0,
    }));
  }

  context(sessionId: string, sessionSeq: number, before: number, after: number): HistoryEntry[] {
    const lower = Math.max(1, sessionSeq - Math.max(0, before));
    const upper = sessionSeq + Math.max(0, after);
    return (this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? AND session_seq BETWEEN ? AND ?
      ORDER BY session_seq
    `).all(sessionId, lower, upper) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }

  recentRuns(sessionId: string, limit: number): Array<{
    prompt: HistoryEntry;
    boundary?: HistoryEntry;
  }> {
    const prompts = (this.db.prepare(`
      SELECT * FROM transcript_entries
      WHERE session_id = ? AND role = 'user'
      ORDER BY session_seq DESC LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(50, limit))) as unknown as StoredTranscriptRow[])
      .map(parseEntry);
    return prompts.map((prompt) => {
      const boundaryRow = this.db.prepare(`
        SELECT * FROM transcript_entries
        WHERE session_id = ? AND role = 'run_boundary' AND session_seq > ?
        ORDER BY session_seq LIMIT 1
      `).get(sessionId, prompt.sessionSeq!) as unknown as StoredTranscriptRow | undefined;
      return { prompt, ...(boundaryRow ? { boundary: parseEntry(boundaryRow) } : {}) };
    });
  }

  pendingToolCalls(sessionId: string): HistoryEntry[] {
    return (this.db.prepare(`
      SELECT call.* FROM transcript_entries AS call
      WHERE call.session_id = ? AND call.role = 'tool_call' AND call.tool_use_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transcript_entries AS result
          WHERE result.session_id = call.session_id
            AND result.role = 'tool_result'
            AND result.tool_use_id = call.tool_use_id
        )
      ORDER BY call.session_seq
    `).all(sessionId) as unknown as StoredTranscriptRow[]).map(parseEntry);
  }
}

let sharedDatabase: TranscriptDatabase | undefined;

export function transcriptDatabase(): TranscriptDatabase {
  sharedDatabase ??= new TranscriptDatabase(
    path.join(socketAgentDataPath("history"), "transcripts.sqlite"),
  );
  return sharedDatabase;
}
