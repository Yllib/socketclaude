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

  test(`deletes SDK-retracted UUIDs without rewriting the transcript${disableFts ? " without FTS5" : ""}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-retraction-"));
    const database = new TranscriptDatabase(
      path.join(dir, "transcripts.sqlite"),
      { disableFts },
    );
    try {
      database.replace("session", [
        {
          entry: {
            entryId: "entry-1",
            sessionSeq: 1,
            revision: 1,
            role: "assistant",
            content: "refused partial",
            uuid: "remove-me",
          },
          positionKey: "assistant:1",
        },
        {
          entry: {
            entryId: "entry-2",
            sessionSeq: 2,
            revision: 1,
            role: "assistant",
            content: "replacement",
            uuid: "keep-me",
          },
          positionKey: "assistant:2",
        },
      ]);

      assert.equal(database.deleteByUuids("session", ["remove-me"]), 1);
      assert.equal(database.count("session"), 1);
      assert.equal(database.getBySessionSeq("session", 1), undefined);
      assert.equal(database.getBySessionSeq("session", 2).uuid, "keep-me");
      assert.equal(database.search("session", { query: "refused" }).length, 0);
      assert.equal(database.search("session", { query: "replacement" }).length, 1);
    } finally {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("serves resume recovery data through targeted transcript indexes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-indexed-resume-"));
  const database = new TranscriptDatabase(path.join(dir, "transcripts.sqlite"));
  const sessionId = "indexed-resume";
  try {
    database.replace(sessionId, [
      {
        entry: {
          entryId: "user-missing",
          sessionSeq: 1,
          revision: 1,
          role: "user",
          content: "old prompt",
          timestamp: "2026-08-24T10:00:00.000Z",
        },
        positionKey: "user:1",
      },
      {
        entry: {
          entryId: "user-current",
          sessionSeq: 2,
          revision: 1,
          role: "user",
          content: "new prompt",
          uuid: "known-uuid",
          timestamp: "2026-08-24T10:01:00.000Z",
        },
        positionKey: "user:2",
      },
      {
        entry: {
          entryId: "task-create",
          sessionSeq: 3,
          revision: 1,
          role: "tool_call",
          toolName: "TaskCreate",
          toolUseId: "task-tool-1",
          timestamp: "2026-08-24T10:02:00.000Z",
        },
        positionKey: "tool:task-tool-1",
      },
      {
        entry: {
          entryId: "task-result",
          sessionSeq: 4,
          revision: 1,
          role: "tool_result",
          toolUseId: "task-tool-1",
          content: "Task #1 created successfully: Test task",
          timestamp: "2026-08-24T10:02:01.000Z",
        },
        positionKey: "result:task-tool-1",
      },
      {
        entry: {
          entryId: "suggestion",
          sessionSeq: 5,
          revision: 1,
          role: "prompt_suggestion",
          content: "Run the tests",
          timestamp: "2026-08-24T10:03:00.000Z",
        },
        positionKey: "suggestion:1",
      },
      {
        entry: {
          entryId: "boundary",
          sessionSeq: 6,
          revision: 1,
          role: "run_boundary",
          runId: "run-1",
          timestamp: "2026-08-24T10:04:00.000Z",
        },
        positionKey: "run:1",
      },
    ]);

    assert.deepEqual(database.getUsersMissingUuid(sessionId).map((entry) => entry.entryId), ["user-missing"]);
    assert.deepEqual(database.getUserUuids(sessionId), ["known-uuid"]);
    assert.equal(database.getByToolNames(sessionId, ["TaskCreate"])[0].entryId, "task-create");
    assert.equal(database.getToolResultsByUseIds(sessionId, ["task-tool-1"])[0].entryId, "task-result");
    assert.equal(database.getByToolUseId(sessionId, "tool_result", "task-tool-1").entryId, "task-result");
    assert.equal(database.getLatestByRole(sessionId, "prompt_suggestion").content, "Run the tests");
    assert.equal(database.getSinceTimestamp(sessionId, "2026-08-24T10:03:00.000Z").length, 2);
    assert.equal(database.getRunBoundary(sessionId, "run-1").entryId, "boundary");

    database.upsert(sessionId, {
      entryId: "review",
      sessionSeq: 7,
      revision: 1,
      role: "work_review",
      reviewId: "review-1",
      content: "Review ready",
    }, "review:1");
    database.upsert(sessionId, {
      entryId: "delegated-report",
      sessionSeq: 8,
      revision: 1,
      role: "user",
      content: '<socketagent_delegation_report delegation_id="delegation-1">result',
    }, "user:delegated-report");
    assert.equal(database.getWorkReview(sessionId, "review-1").entryId, "review");
    assert.equal(
      database.hasUserContentPrefix(
        sessionId,
        '<socketagent_delegation_report delegation_id="delegation-1">',
      ),
      true,
    );
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maintains transcript summaries incrementally across appends and revisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-summary-"));
  const database = new TranscriptDatabase(path.join(dir, "transcripts.sqlite"));
  const sessionId = "incremental-summary";
  const user = {
    entryId: "user-1",
    sessionSeq: 1,
    revision: 1,
    role: "user",
    content: "first prompt",
    uuid: "prompt-uuid",
    timestamp: "2026-08-25T10:00:00.000Z",
  };
  const assistant = {
    entryId: "assistant-1",
    sessionSeq: 2,
    revision: 1,
    role: "assistant",
    content: "first answer",
    timestamp: "2026-08-25T10:01:00.000Z",
  };
  try {
    database.upsert(sessionId, user, "user:1");
    database.upsert(sessionId, assistant, "assistant:1");
    assert.deepEqual(database.summary(sessionId), {
      sessionId,
      entryCount: 2,
      userPromptCount: 1,
      latestTimestamp: "2026-08-25T10:01:00.000Z",
      messagePreview: "first answer",
      latestConversationSeq: 2,
      updatedAt: database.summary(sessionId).updatedAt,
    });
    assert.equal(database.hasUserUuid(sessionId, "prompt-uuid"), true);

    database.upsert(sessionId, {
      ...assistant,
      revision: 2,
      content: "revised answer",
    }, "assistant:1");
    assert.equal(database.summary(sessionId).entryCount, 2);
    assert.equal(database.summary(sessionId).messagePreview, "revised answer");

    database.upsert(sessionId, {
      ...assistant,
      revision: 3,
      role: "tool_result",
      content: "tool output",
      timestamp: "2026-08-25T09:59:00.000Z",
    }, "assistant:1");
    assert.deepEqual(
      {
        entryCount: database.summary(sessionId).entryCount,
        userPromptCount: database.summary(sessionId).userPromptCount,
        latestTimestamp: database.summary(sessionId).latestTimestamp,
        messagePreview: database.summary(sessionId).messagePreview,
        latestConversationSeq: database.summary(sessionId).latestConversationSeq,
      },
      {
        entryCount: 2,
        userPromptCount: 1,
        latestTimestamp: "2026-08-25T10:00:00.000Z",
        messagePreview: "first prompt",
        latestConversationSeq: 1,
      },
    );

    database.upsertMany(sessionId, [
      {
        entry: {
          entryId: "user-2",
          sessionSeq: 3,
          revision: 1,
          role: "user",
          content: "second prompt",
          timestamp: "2026-08-25T10:02:00.000Z",
        },
        positionKey: "user:2",
      },
      {
        entry: {
          entryId: "assistant-2",
          sessionSeq: 4,
          revision: 1,
          role: "assistant",
          content: "second answer",
          timestamp: "2026-08-25T10:03:00.000Z",
        },
        positionKey: "assistant:2",
      },
    ]);
    assert.equal(database.summary(sessionId).entryCount, 4);
    assert.equal(database.summary(sessionId).userPromptCount, 2);
    assert.equal(database.summary(sessionId).messagePreview, "second answer");
    assert.equal(
      database.getLatestByRoleSince(sessionId, "assistant", "2026-08-25T10:02:30.000Z").entryId,
      "assistant-2",
    );
    assert.equal(
      database.getLatestByRoleSince(sessionId, "assistant", "2026-08-25T10:04:00.000Z"),
      undefined,
    );

    database.upsertMany(sessionId, [
      {
        entry: {
          entryId: "batch-revision",
          sessionSeq: 5,
          revision: 1,
          role: "user",
          content: "temporary role",
          timestamp: "2026-08-25T10:04:00.000Z",
        },
        positionKey: "batch:revision",
      },
      {
        entry: {
          entryId: "batch-revision",
          sessionSeq: 5,
          revision: 2,
          role: "assistant",
          content: "final batch revision",
          timestamp: "2026-08-25T10:04:00.000Z",
        },
        positionKey: "batch:revision",
      },
    ]);
    assert.equal(database.summary(sessionId).entryCount, 5);
    assert.equal(database.summary(sessionId).userPromptCount, 2);
    assert.equal(database.summary(sessionId).messagePreview, "final batch revision");
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
