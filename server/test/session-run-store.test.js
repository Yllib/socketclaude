const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  hasOutstandingDelegatedRuns,
  inferStaleRunCompletion,
} = require("../dist/session-run-store");

test("stale runs close at their last transcript activity", () => {
  const completion = inferStaleRunCompletion([
    { role: "user", timestamp: "2026-08-21T17:39:20.000Z" },
    { role: "assistant", timestamp: "2026-08-21T17:40:45.000Z" },
    { role: "notification", timestamp: "2026-08-21T17:40:46.000Z" },
  ], "2026-08-21T17:39:20.000Z");

  assert.deepEqual(completion, {
    finishedAt: "2026-08-21T17:40:46.000Z",
    outcome: "completed",
  });
});

test("logical runs persist exact aggregate durations and transcript boundaries", () => {
  const sessionId = `test-session-runs-${randomUUID()}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-run-stats-"));
  try {
    const output = execFileSync(process.execPath, ["-e", `
      const { saveSession, getHistory } = require('./dist/session-store');
      const { beginSessionRun, finishSessionRun, getSessionRunStats } = require('./dist/session-run-store');
      const sessionId = ${JSON.stringify(sessionId)};
      saveSession({ id: sessionId, title: 'Run timing test', cwd: process.cwd(), createdAt: '2026-08-04T10:00:00.000Z', lastActive: '2026-08-04T10:00:00.000Z', messagePreview: '' });
      beginSessionRun(sessionId, '2026-08-04T10:00:00.000Z', 'run-1');
      beginSessionRun(sessionId, '2026-08-04T10:00:30.000Z', 'ignored');
      finishSessionRun(sessionId, 'completed', '2026-08-04T10:02:00.000Z');
      beginSessionRun(sessionId, '2026-08-04T11:00:00.000Z', 'run-2');
      finishSessionRun(sessionId, 'stopped', '2026-08-04T11:01:00.000Z');
      process.stdout.write(JSON.stringify({
        stats: getSessionRunStats(sessionId),
        boundaries: getHistory(sessionId).filter((entry) => entry.role === 'run_boundary'),
      }));
    `], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, SOCKET_AGENT_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    const { stats, boundaries } = JSON.parse(output);
    assert.equal(stats.current, undefined);
    assert.equal(stats.completedCount, 2);
    assert.equal(stats.totalDurationMs, 180_000);
    assert.equal(stats.averageDurationMs, 90_000);
    assert.equal(stats.longestDurationMs, 120_000);
    assert.equal(stats.shortestDurationMs, 60_000);
    assert.deepEqual(stats.recentRuns.map((run) => [run.runNumber, run.runId]), [[1, "run-1"], [2, "run-2"]]);

    assert.deepEqual(
      boundaries.map((entry) => [entry.runId, entry.runDurationMs, entry.runOutcome]),
      [
        ["run-1", 120_000, "completed"],
        ["run-2", 60_000, "stopped"],
      ],
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("delegated work keeps a logical run open through result delivery", () => {
  const startedAt = "2026-08-04T10:00:00.000Z";
  const record = {
    delegationId: "delegation-1",
    supervisorSessionId: "supervisor-1",
    backend: "codex",
    cwd: process.cwd(),
    label: "test",
    status: "running",
    createdAt: startedAt,
    updatedAt: startedAt,
    runs: [{
      runId: "child-run-1",
      runNumber: 1,
      promptPreview: "test",
      startedAt: "2026-08-04T10:00:10.000Z",
      status: "running",
    }],
  };

  assert.equal(hasOutstandingDelegatedRuns([record], startedAt), true);
  record.runs[0].status = "completed";
  record.runs[0].reportStatus = "pending";
  assert.equal(hasOutstandingDelegatedRuns([record], startedAt), true);
  record.runs[0].reportStatus = "delivered";
  assert.equal(hasOutstandingDelegatedRuns([record], startedAt), false);
  assert.equal(hasOutstandingDelegatedRuns([record], startedAt, true), true);
});

test("historical run backfill is durable, versioned, and idempotent", () => {
  const sessionId = `test-session-run-backfill-${randomUUID()}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-run-backfill-"));
  try {
    const output = execFileSync(process.execPath, ["-e", `
      const { appendHistory, appendSdkEvent, getSession, saveSession } = require('./dist/session-store');
      const { backfillSessionRunStats } = require('./dist/session-run-store');
      const sessionId = ${JSON.stringify(sessionId)};
      saveSession({ id: sessionId, title: 'Backfill test', cwd: process.cwd(), createdAt: '2026-08-04T10:00:00.000Z', lastActive: '2026-08-04T11:00:20.000Z', messagePreview: '' });
      appendHistory(sessionId, { role: 'user', content: 'First run', timestamp: '2026-08-04T10:00:00.000Z' });
      appendHistory(sessionId, { role: 'assistant', content: 'First done', timestamp: '2026-08-04T10:00:20.000Z' });
      appendHistory(sessionId, { role: 'user', content: 'Second run', timestamp: '2026-08-04T11:00:00.000Z' });
      appendHistory(sessionId, { role: 'assistant', content: 'Second done', timestamp: '2026-08-04T11:00:20.000Z' });
      appendSdkEvent(sessionId, { sdkType: 'result', ts: '2026-08-04T10:00:20.000Z', durationMs: 20000 });
      appendSdkEvent(sessionId, { sdkType: 'result', ts: '2026-08-04T11:00:20.000Z', durationMs: 20000 });
      const first = backfillSessionRunStats(sessionId);
      const second = backfillSessionRunStats(sessionId);
      const forced = backfillSessionRunStats(sessionId, [], true);
      process.stdout.write(JSON.stringify({ first, second, forced, stored: getSession(sessionId).runStats }));
    `], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, SOCKET_AGENT_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    for (const stats of [result.first, result.second, result.forced, result.stored]) {
      assert.equal(stats.backfillVersion, 1);
      assert.equal(stats.completedCount, 2);
      assert.equal(stats.totalDurationMs, 40_000);
      assert.deepEqual(stats.recentRuns.map((run) => run.source), [
        "sdk_backfill",
        "sdk_backfill",
      ]);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
