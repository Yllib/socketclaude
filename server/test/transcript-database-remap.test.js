const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TranscriptDatabase } = require("../dist/transcript-database");

for (const disableFts of [false, true]) {
  test(`re-keys transcript rows and artifact paths${disableFts ? " without FTS5" : ""}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-remap-"));
    const database = new TranscriptDatabase(
      path.join(dir, "transcripts.sqlite"),
      { disableFts },
    );
    const oldId = "old-session";
    const newId = "new-session";

    try {
      database.replace(oldId, [
        {
          entry: {
            entryId: "entry-1",
            sessionSeq: 1,
            revision: 1,
            role: "tool_result",
            content: "migration completed",
            filePath: "/images/old-session/result.png",
            toolOutputRef: "old-session/output.txt.gz",
          },
          positionKey: "tool:1",
        },
        {
          entry: {
            entryId: "entry-2",
            sessionSeq: 2,
            revision: 1,
            role: "assistant",
            content: "The migration is complete.",
          },
          positionKey: "assistant:2",
        },
      ]);

      assert.equal(database.remapSession(oldId, newId, {
        filePathPrefix: {
          from: "/images/old-session/",
          to: "/images/new-session/",
        },
        toolOutputRefPrefix: {
          from: "old-session/",
          to: "new-session/",
        },
      }), true);

      assert.equal(database.hasSession(oldId), false);
      assert.equal(database.count(newId), 2);
      assert.equal(database.getBySessionSeq(newId, 1).filePath, "/images/new-session/result.png");
      assert.equal(database.getBySessionSeq(newId, 1).toolOutputRef, "new-session/output.txt.gz");
      assert.equal(database.search(newId, { query: "migration" }).length, 2);
      assert.equal(database.search(oldId, { query: "migration" }).length, 0);
    } finally {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
