const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./test-data-dir");

const {
  appendHistory,
  deleteSessionArtifacts,
  getBoundedHistoryDelta,
  getBoundedHistoryTail,
  getHistory,
  getResumeHistoryPage,
  positionSessionMessage,
} = require("../dist/session-store");

test("corrupt retained JSON cannot roll durable SQLite history backward", () => {
  const sessionId = `test-history-recovery-${randomUUID()}`;
  const historyPath = path.join(
    process.env.SOCKET_AGENT_DATA_DIR || path.join(os.homedir(), ".socket-agent"),
    "history",
    `${sessionId}.json`,
  );
  try {
    appendHistory(sessionId, {
      role: "user",
      content: "known-good",
      timestamp: new Date().toISOString(),
    });
    appendHistory(sessionId, {
      role: "assistant",
      content: "newer-current-entry",
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    // Model the observed crash: a present snapshot replaced by NUL bytes.
    fs.writeFileSync(historyPath, Buffer.alloc(97));

    const recovered = getHistory(sessionId);
    assert.deepEqual(recovered.map((entry) => entry.content), ["known-good", "newer-current-entry"]);

    appendHistory(sessionId, {
      role: "assistant",
      content: "works-after-recovery",
      timestamp: new Date(Date.now() + 2).toISOString(),
    });
    assert.deepEqual(
      getHistory(sessionId).map((entry) => entry.content),
      ["known-good", "newer-current-entry", "works-after-recovery"],
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("live revisions and persisted history share one transcript position", () => {
  const sessionId = `test-transcript-position-${randomUUID()}`;
  try {
    const firstFrame = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "assistant-stream-1",
      content: "hello",
    });
    const finalFrame = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "assistant-stream-1",
      content: "hello world",
      finalSnapshot: true,
    });
    const persistedText = appendHistory(sessionId, {
      role: "assistant",
      content: "hello world",
      streamId: "assistant-stream-1",
      timestamp: new Date().toISOString(),
    });

    assert.equal(finalFrame.entryId, firstFrame.entryId);
    assert.equal(finalFrame.sessionSeq, firstFrame.sessionSeq);
    assert.ok(finalFrame.revision > firstFrame.revision);
    assert.equal(persistedText.entryId, firstFrame.entryId);
    assert.equal(persistedText.sessionSeq, firstFrame.sessionSeq);
    assert.equal(persistedText.revision, finalFrame.revision);

    const liveTool = positionSessionMessage(sessionId, {
      type: "tool_call",
      sessionId,
      toolUseId: "tool-1",
      tool: "Bash",
      input: { command: "pwd" },
    });
    const persistedTool = appendHistory(sessionId, {
      role: "tool_call",
      content: "pwd",
      toolName: "Bash",
      toolUseId: "tool-1",
      toolInput: { command: "pwd" },
      timestamp: new Date().toISOString(),
    });

    assert.equal(persistedTool.entryId, liveTool.entryId);
    assert.equal(persistedTool.sessionSeq, liveTool.sessionSeq);
    assert.ok(liveTool.sessionSeq > firstFrame.sessionSeq);

    const history = getHistory(sessionId);
    assert.deepEqual(
      history.map((entry) => entry.sessionSeq),
      [firstFrame.sessionSeq, liveTool.sessionSeq],
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("bounded history resumes with only entries newer than the cached sequence", () => {
  const sessionId = `test-transcript-delta-${randomUUID()}`;
  try {
    const entries = [];
    for (let index = 0; index < 8; index++) {
      entries.push(appendHistory(sessionId, {
        role: index === 0 ? "user" : "assistant",
        content: `message-${index}`,
        timestamp: new Date(Date.now() + index).toISOString(),
      }));
    }

    const delta = getBoundedHistoryDelta(sessionId, entries[4].sessionSeq);
    assert.ok(delta);
    assert.deepEqual(
      delta.entries.map((entry) => entry.content),
      ["message-5", "message-6", "message-7"],
    );
    assert.equal(delta.offset, 5);
    assert.equal(delta.total, 8);

    const tail = getBoundedHistoryTail(sessionId, 3, 1024);
    assert.deepEqual(
      tail.entries.map((entry) => entry.content),
      ["message-5", "message-6", "message-7"],
    );
    assert.equal(tail.offset, 5);
    assert.equal(tail.total, 8);
    assert.equal(tail.deferredContextAvailable, true);
    assert.equal(tail.totalUserPrompts, 1);
    assert.equal(delta.totalUserPrompts, 1);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("oversized or incompatible deltas fail back to a bounded snapshot", () => {
  const sessionId = `test-transcript-delta-fallback-${randomUUID()}`;
  try {
    const first = appendHistory(sessionId, {
      role: "user",
      content: "start",
      timestamp: new Date().toISOString(),
    });
    for (let index = 0; index < 4; index++) {
      appendHistory(sessionId, {
        role: "assistant",
        content: `answer-${index}`,
        timestamp: new Date(Date.now() + index + 1).toISOString(),
      });
    }

    assert.equal(getBoundedHistoryDelta(sessionId, 999999), null);
    assert.equal(getBoundedHistoryDelta(sessionId, first.sessionSeq, 2), null);
    assert.equal(
      getBoundedHistoryDelta(sessionId, first.sessionSeq, 100, 256 * 1024, 0, 2),
      null,
    );
    assert.ok(
      getBoundedHistoryDelta(sessionId, first.sessionSeq, 100, 256 * 1024, 0, 1),
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("default delta budget retains a large active-turn transcript", () => {
  const sessionId = `test-transcript-large-delta-${randomUUID()}`;
  try {
    const first = appendHistory(sessionId, {
      role: "user",
      content: "start",
      timestamp: new Date().toISOString(),
    });
    for (let index = 0; index < 300; index++) {
      appendHistory(sessionId, {
        role: "assistant",
        content: `answer-${index}-${"x".repeat(1024)}`,
        timestamp: new Date(Date.now() + index + 1).toISOString(),
      });
    }

    const delta = getBoundedHistoryDelta(sessionId, first.sessionSeq);
    assert.ok(delta);
    assert.equal(delta.entries.length, 300);
    assert.equal(delta.offset, 1);
    assert.equal(delta.total, 301);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("resume history returns the complete recent prompt window in one page", () => {
  const sessionId = `test-transcript-resume-window-${randomUUID()}`;
  try {
    const entries = [];
    const userIndexes = new Set([5, 40, 80, 115]);
    for (let index = 0; index < 120; index++) {
      entries.push(appendHistory(sessionId, {
        role: userIndexes.has(index) ? "user" : "assistant",
        content: `message-${index}`,
        timestamp: new Date(Date.now() + index).toISOString(),
      }));
    }

    const initial = getResumeHistoryPage(sessionId);
    assert.equal(initial.historyKind, "initial");
    assert.equal(initial.offset, 40);
    assert.equal(initial.entries[0].content, "message-40");
    assert.equal(initial.entries.at(-1).content, "message-119");
    assert.equal(
      initial.entries.filter((entry) => entry.role === "user").length,
      3,
    );

    const contiguousTailCache = getResumeHistoryPage(sessionId, {
      knownSessionSeq: entries[109].sessionSeq,
      knownHistoryOffset: 70,
      knownHistoryEntryCount: 40,
    });
    assert.equal(contiguousTailCache.historyKind, "delta");
    assert.equal(contiguousTailCache.offset, 110);

    const completeCache = getResumeHistoryPage(sessionId, {
      knownSessionSeq: entries[109].sessionSeq,
      knownHistoryOffset: 40,
      knownHistoryEntryCount: 70,
    });
    assert.equal(completeCache.historyKind, "delta");
    assert.equal(completeCache.offset, 110);
    assert.deepEqual(
      completeCache.entries.map((entry) => entry.content),
      Array.from({ length: 10 }, (_, index) => `message-${index + 110}`),
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("resume history hard-bounds a tool-heavy initial window", () => {
  const sessionId = `test-transcript-resume-budget-${randomUUID()}`;
  try {
    appendHistory(sessionId, {
      role: "user",
      content: "start",
      timestamp: new Date().toISOString(),
    });
    for (let index = 0; index < 80; index++) {
      appendHistory(sessionId, {
        role: "assistant",
        content: `${index}:${"x".repeat(16_000)}`,
        timestamp: new Date(Date.now() + index + 1).toISOString(),
      });
    }

    const page = getResumeHistoryPage(sessionId, {
      maxInitialEntries: 20,
      maxInitialBytes: 100_000,
    });
    assert.equal(page.historyKind, "initial");
    assert.ok(page.entries.length <= 20);
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries), "utf8") <= 100_000);
    assert.equal(page.deferredContextAvailable, true);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("history keeps first-live order when streams finish out of order", () => {
  const sessionId = `test-transcript-concurrency-${randomUUID()}`;
  try {
    const earlier = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "earlier-stream",
      content: "started first",
    });
    const later = positionSessionMessage(sessionId, {
      type: "tool_call",
      sessionId,
      toolUseId: "later-tool",
      tool: "Bash",
      input: { command: "pwd" },
    });

    // The later card completes and is persisted before the earlier stream.
    appendHistory(sessionId, {
      role: "tool_call",
      content: "pwd",
      toolName: "Bash",
      toolUseId: "later-tool",
      toolInput: { command: "pwd" },
      timestamp: new Date().toISOString(),
    });
    appendHistory(sessionId, {
      role: "assistant",
      content: "started first and finished last",
      streamId: "earlier-stream",
      timestamp: new Date().toISOString(),
    });

    const history = getHistory(sessionId);
    assert.deepEqual(
      history.map((entry) => entry.sessionSeq),
      [earlier.sessionSeq, later.sessionSeq],
    );
    assert.deepEqual(
      history.map((entry) => entry.entryId),
      [earlier.entryId, later.entryId],
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("persisting another revision replaces the existing transcript row", () => {
  const sessionId = `test-transcript-upsert-${randomUUID()}`;
  try {
    const first = appendHistory(sessionId, {
      role: "secure_input",
      content: "Need token",
      questionId: "secure-test",
      status: "pending",
      answered: false,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: new Date().toISOString(),
    });
    const saved = appendHistory(sessionId, {
      role: "secure_input",
      content: "Need token",
      questionId: "secure-test",
      status: "saved",
      answered: true,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    const history = getHistory(sessionId);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "saved");
    assert.equal(saved.entryId, first.entryId);
    assert.equal(saved.sessionSeq, first.sessionSeq);
    assert.ok(saved.revision > first.revision);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("task lifecycle progress revises one durable history row", () => {
  const sessionId = `test-task-state-upsert-${randomUUID()}`;
  try {
    const started = appendHistory(sessionId, {
      role: "task_state",
      content: "Inspect event stream",
      taskId: "agent-42",
      taskKind: "subagent",
      status: "running",
      originToolUseId: "tool-agent-42",
      progressSummary: "Starting",
      timestamp: new Date().toISOString(),
    });
    const completed = appendHistory(sessionId, {
      role: "task_state",
      content: "Audit complete",
      taskId: "agent-42",
      taskKind: "subagent",
      status: "completed",
      originToolUseId: "tool-agent-42",
      progressSummary: "All events accounted for",
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    const history = getHistory(sessionId);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "completed");
    assert.equal(history[0].progressSummary, "All events accounted for");
    assert.equal(completed.entryId, started.entryId);
    assert.equal(completed.sessionSeq, started.sessionSeq);
    assert.ok(completed.revision > started.revision);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});
