const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDir = fs.mkdtempSync(
  path.join(os.tmpdir(), `socketagent-rate-limit-cache-${crypto.randomUUID()}-`),
);
process.env.SOCKET_AGENT_DATA_DIR = testDir;

const {
  getCachedRateLimitEvents,
  recordRateLimitEvent,
  resetRateLimitCacheForTests,
} = require("../dist/rate-limit-cache");

test.after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("fresh harness events replace the exact backend window", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  recordRateLimitEvent({
    type: "rate_limit_event",
    backend: "claude",
    status: "allowed_warning",
    rateLimitType: "five_hour",
    utilizationPercent: 87,
    resetsAt: "2026-07-28T13:00:00.000Z",
    sessionId: "session-1",
  }, now);
  recordRateLimitEvent({
    type: "rate_limit_event",
    backend: "claude",
    status: "rejected",
    rateLimitType: "five_hour",
    utilizationPercent: 100,
    resetsAt: "2026-07-28T14:00:00.000Z",
    sessionId: "session-2",
  }, now);
  recordRateLimitEvent({
    type: "rate_limit_event",
    backend: "codex",
    status: "allowed_warning",
    rateLimitType: "seven_day",
    utilizationPercent: 91,
    resetsAt: "2026-08-02T12:00:00.000Z",
    sessionId: "session-3",
  }, now);

  assert.deepEqual(
    getCachedRateLimitEvents("claude", "joined-session", now),
    [{
      type: "rate_limit_event",
      backend: "claude",
      status: "rejected",
      rateLimitType: "five_hour",
      utilizationPercent: 100,
      resetsAt: "2026-07-28T14:00:00.000Z",
      sessionId: "joined-session",
    }],
  );
  assert.equal(getCachedRateLimitEvents(undefined, "", now).length, 2);
});

test("allowed updates and reset expiration invalidate cached windows", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  recordRateLimitEvent({
    type: "rate_limit_event",
    backend: "claude",
    status: "allowed",
    rateLimitType: "five_hour",
    utilizationPercent: 20,
    resetsAt: "2026-07-28T14:00:00.000Z",
    sessionId: "session-4",
  }, now);
  assert.deepEqual(getCachedRateLimitEvents("claude", "", now), []);
  assert.equal(
    getCachedRateLimitEvents(
      "codex",
      "",
      Date.parse("2026-08-03T12:00:00.000Z"),
    ).length,
    0,
  );
});

test("cache survives a server process reload", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  recordRateLimitEvent({
    type: "rate_limit_event",
    backend: "claude",
    status: "rejected",
    rateLimitType: "seven_day_opus",
    utilizationPercent: 100,
    resetsAt: "2026-08-02T12:00:00.000Z",
    sessionId: "session-5",
  }, now);
  resetRateLimitCacheForTests();

  const restored = getCachedRateLimitEvents("claude", "session-6", now);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sessionId, "session-6");
  assert.equal(restored[0].rateLimitType, "seven_day_opus");
});

test("legacy cache is discarded after harness percentage normalization changed", () => {
  fs.writeFileSync(path.join(testDir, "rate-limits.json"), JSON.stringify({
    schemaVersion: 2,
    backends: {
      claude: {
        five_hour: {
          type: "rate_limit_event",
          backend: "claude",
          status: "rejected",
          rateLimitType: "five_hour",
          utilizationPercent: 100,
          resetsAt: "2026-08-10T11:41:48.000Z",
          sessionId: "",
        },
      },
    },
  }));
  resetRateLimitCacheForTests();

  assert.deepEqual(
    getCachedRateLimitEvents("claude", "session-after-upgrade", Date.parse("2026-08-03T12:00:00.000Z")),
    [],
  );
});
