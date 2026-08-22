const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-session-memory-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  deleteSessionMemoryEntry,
  getSessionMemoryListSummary,
  getSessionMemoryState,
  recordSessionMemoryCompaction,
  remapSessionMemory,
  requestSessionMemoryRollover,
  shouldRolloverSessionMemory,
  updateSessionMemorySettings,
  upsertSessionMemoryEntry,
} = require("../dist/session-memory-store");
const { handleSessionMemoryTool } = require("../dist/app-tool-handlers");
const { appendHistory } = require("../dist/session-store");

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("only a manual request queues rollover and memory survives the new epoch", () => {
  const oldSessionId = "memory-thread-one";
  let state = getSessionMemoryState(oldSessionId);
  assert.equal(state.settings.autoRollover, false);
  assert.equal(state.settings.maxCompactions, 10);
  assert.equal(state.epochs.length, 1);

  state = upsertSessionMemoryEntry(oldSessionId, {
    kind: "decision",
    text: "Keep full visible history while rotating native Codex threads.",
    pinned: true,
    sourceSessionSeq: 42,
  });
  const memoryId = state.entries[0].id;
  updateSessionMemorySettings(oldSessionId, {
    autoRollover: true,
    maxCompactions: 2,
    recentRuns: 4,
  });
  recordSessionMemoryCompaction(oldSessionId, 180000);
  assert.equal(shouldRolloverSessionMemory(oldSessionId), false);
  recordSessionMemoryCompaction(oldSessionId, 175000);
  assert.equal(shouldRolloverSessionMemory(oldSessionId), false);
  state = requestSessionMemoryRollover(oldSessionId, "user requested fresh thread");
  assert.equal(shouldRolloverSessionMemory(oldSessionId), true);
  assert.equal(state.rolloverTrigger, "manual");
  assert.equal(state.settings.autoRollover, false);

  state = remapSessionMemory(oldSessionId, "memory-thread-two");
  assert.equal(state.sessionId, "memory-thread-two");
  assert.equal(state.rolloverPending, false);
  assert.equal(state.rolloverTrigger, undefined);
  assert.equal(state.compactionsSinceRollover, 0);
  assert.equal(state.epochs.length, 2);
  assert.equal(state.epochs[0].nativeSessionId, oldSessionId);
  assert.equal(state.epochs[0].compactions, 2);
  assert.equal(state.epochs[1].nativeSessionId, "memory-thread-two");
  assert.equal(state.entries[0].id, memoryId);
  assert.equal(state.entries[0].pinned, true);
  assert.equal(fs.existsSync(path.join(dataDir, "session-memory", `${oldSessionId}.json`)), false);
});

test("existing oversized histories are recommended but never queued automatically", () => {
  const sessionId = "historically-large-thread";
  for (let index = 0; index < 4; index += 1) {
    appendHistory(sessionId, {
      role: "assistant",
      content: `[compact_boundary:${150000 + index}:auto]`,
      timestamp: new Date().toISOString(),
    });
  }

  const state = getSessionMemoryState(sessionId);
  assert.equal(state.compactionsSinceRollover, 4);
  assert.equal(state.epochs[0].compactions, 4);
  assert.equal(state.rolloverPending, false);
  assert.equal(state.rolloverReason, undefined);
});

test("drops a rollover that an older build queued automatically", () => {
  const sessionId = "legacy-auto-rollover";
  const memoryDir = path.join(dataDir, "session-memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, `${sessionId}.json`), JSON.stringify({
    version: 1,
    sessionId,
    entries: [],
    settings: {
      autoRollover: true,
      maxCompactions: 3,
      maxPostCompactionTokens: 90000,
      recentRuns: 3,
    },
    epochs: [{
      number: 1,
      nativeSessionId: sessionId,
      startedAt: new Date().toISOString(),
      compactions: 12,
    }],
    currentTokens: 0,
    contextWindow: 0,
    compactionsSinceRollover: 12,
    awaitingPostCompactionMeasurement: false,
    rolloverPending: true,
    rolloverReason: "12 compactions reached the configured limit",
    historicalCompactionsSeeded: true,
    updatedAt: new Date().toISOString(),
  }));

  const state = getSessionMemoryState(sessionId);
  assert.equal(state.settings.autoRollover, false);
  assert.equal(state.rolloverPending, false);
  assert.equal(shouldRolloverSessionMemory(sessionId), false);
});

test("reads session-list lineage without initializing transcript history", () => {
  const sessionId = "list-summary-current";
  const memoryDir = path.join(dataDir, "session-memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, `${sessionId}.json`), JSON.stringify({
    compactionsSinceRollover: 11,
    epochs: [
      { nativeSessionId: "list-summary-old" },
      { nativeSessionId: sessionId },
    ],
  }));

  assert.deepEqual(getSessionMemoryListSummary(sessionId), {
    compactionsSinceRollover: 11,
    replacedSessionIds: ["list-summary-old"],
    freshThreadPending: false,
  });
  assert.deepEqual(getSessionMemoryListSummary("missing-summary"), {
    compactionsSinceRollover: 0,
    replacedSessionIds: [],
    freshThreadPending: false,
  });
});

test("session-list summary exposes a manually queued fresh thread", () => {
  const sessionId = "list-summary-pending";
  requestSessionMemoryRollover(sessionId);
  assert.equal(getSessionMemoryListSummary(sessionId).freshThreadPending, true);
});

test("SessionMemory tool validates and edits the durable set", async () => {
  const sessionId = "memory-tool-session";
  const packets = [];
  const ctx = {
    getSessionId: () => sessionId,
    send: (message) => packets.push(message),
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
  };

  const created = await handleSessionMemoryTool(ctx, {
    action: "upsert",
    kind: "constraint",
    text: "Never publish an app build unless the user asks.",
  });
  assert.equal(created.isError, undefined);
  assert.equal(packets.at(-1).type, "session_memory_state");
  let state = getSessionMemoryState(sessionId);
  assert.equal(state.entries.length, 1);

  const invalid = await handleSessionMemoryTool(ctx, {
    action: "upsert",
    kind: "not-a-kind",
    text: "bad",
  });
  assert.equal(invalid.isError, true);

  requestSessionMemoryRollover(sessionId, "test request");
  assert.equal(shouldRolloverSessionMemory(sessionId), true);
  state = deleteSessionMemoryEntry(sessionId, state.entries[0].id);
  assert.equal(state.entries.length, 0);
});
