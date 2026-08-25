const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

process.env.SOCKETAGENT_SESSION_STORE_FLUSH_MS = "60000";
const dataDir = require("./test-data-dir");
const {
  flushSessionStore,
  getSession,
  saveSession,
  updateSessionActivity,
  updateSessionContextUsage,
} = require("../dist/session-store");

test("coalesces hot session metadata while keeping memory immediately current", () => {
  const sessionId = "coalesced-session-metadata";
  const storeFile = path.join(dataDir, "sessions.json");
  saveSession({
    id: sessionId,
    title: "Metadata test",
    cwd: process.cwd(),
    createdAt: "2026-08-25T10:00:00.000Z",
    lastActive: "2026-08-25T10:00:00.000Z",
    messagePreview: "before",
  });

  updateSessionActivity(sessionId, "first update");
  updateSessionActivity(sessionId, "latest update");
  updateSessionContextUsage(sessionId, { used: 42 });

  const durableBeforeFlush = JSON.parse(fs.readFileSync(storeFile, "utf8"))[0];
  assert.equal(durableBeforeFlush.messagePreview, "before");
  assert.equal(getSession(sessionId).messagePreview, "latest update");
  assert.deepEqual(getSession(sessionId).lastContextUsage, { used: 42 });

  flushSessionStore();
  const durableAfterFlush = JSON.parse(fs.readFileSync(storeFile, "utf8"))[0];
  assert.equal(durableAfterFlush.messagePreview, "latest update");
  assert.deepEqual(durableAfterFlush.lastContextUsage, { used: 42 });
});
