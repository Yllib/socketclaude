const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { TranscriptDatabase } = require("../dist/transcript-database");

test("FTS updates use the transcript rowid and replace stale search text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-search-fts-"));
  const dbPath = path.join(dir, "transcripts.sqlite");
  const db = new TranscriptDatabase(dbPath);
  try {
    db.replace("session-1", [
      {
        entry: {
          entryId: "entry-1",
          sessionSeq: 1,
          revision: 1,
          role: "user",
          content: "original lighthouse wording",
          timestamp: "2026-08-01T10:00:00.000Z",
        },
        positionKey: "user-1",
      },
      {
        entry: {
          entryId: "entry-2",
          sessionSeq: 2,
          revision: 1,
          role: "assistant",
          content: "unchanged harbor wording",
          timestamp: "2026-08-01T10:00:01.000Z",
        },
        positionKey: "assistant-1",
      },
    ]);

    db.upsert("session-1", {
      entryId: "entry-1",
      sessionSeq: 1,
      revision: 2,
      role: "user",
      content: "revised marina wording",
      timestamp: "2026-08-01T10:00:02.000Z",
    }, "user-1");

    assert.equal(db.search("session-1", { query: "lighthouse" }).length, 0);
    assert.deepEqual(
      db.search("session-1", { query: "marina" }).map((hit) => hit.entryId),
      ["entry-1"],
    );
  } finally {
    db.close();
  }

  const mismatchQuery = `
    SELECT COUNT(*) AS value
    FROM transcript_fts AS f
    JOIN transcript_entries AS e ON e.session_id = f.session_id AND e.entry_id = f.entry_id
    WHERE f.rowid != e.rowid
  `;
  const raw = new DatabaseSync(dbPath);
  try {
    assert.equal(raw.prepare(mismatchQuery).get().value, 0);
    const plan = raw.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM transcript_fts WHERE rowid = ?",
    ).all(1).map((row) => row.detail).join("\n");
    assert.match(plan, /VIRTUAL TABLE INDEX [0-9]+:=/);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 2);
    raw.exec("UPDATE transcript_fts SET rowid = rowid + 1000; PRAGMA user_version=1");
    assert.equal(raw.prepare(mismatchQuery).get().value, 2);
  } finally {
    raw.close();
  }

  const migrated = new TranscriptDatabase(dbPath);
  migrated.close();
  const verified = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(verified.prepare(mismatchQuery).get().value, 0);
    assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 2);
  } finally {
    verified.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
