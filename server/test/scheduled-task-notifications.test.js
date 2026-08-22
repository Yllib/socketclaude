const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  reconcileInterruptedScheduledTask,
  scheduledTaskDisplayName,
  scheduledTaskPriorRunContext,
  scheduledTaskRevisionForPath,
  scheduledTaskUsesAutomaticNotifications,
  scheduledTaskCanArchive,
  setScheduledTaskArchiveState,
  setScheduledTaskReadState,
} = require("../dist/scheduled-task-store");

function scheduledTask(overrides = {}) {
  return {
    id: "task-1",
    name: "Health check",
    prompt: "Inspect health",
    cwd: "/tmp",
    scheduledTime: "2026-08-01T01:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "running",
    recurrence: { type: "daily" },
    runCount: 8,
    sessionId: "session-1",
    runs: [],
    ...overrides,
  };
}

test("scheduled task labels are preferred over prompt text", () => {
  assert.equal(
    scheduledTaskDisplayName({
      name: "  Nightly   backup check  ",
      prompt: "Inspect every backup and report any failures.",
    }),
    "Nightly backup check",
  );
});

test("legacy scheduled tasks derive a bounded label from the first prompt line", () => {
  assert.equal(
    scheduledTaskDisplayName({
      prompt: "Check the NAS health\nThen inspect the backup logs.",
    }),
    "Check the NAS health",
  );
});

test("quiet scheduled tasks disable every automatic notification path", () => {
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({ notificationMode: "quiet" }),
    false,
  );
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({ notificationMode: "completion" }),
    true,
  );
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({}),
    true,
  );
});

test("recurring task continuity includes only the two most recent finished runs", () => {
  const context = scheduledTaskPriorRunContext(scheduledTask({
    reuseSession: true,
    runs: [
      {
        sessionId: "session-old",
        startedAt: "2026-07-29T01:00:00.000Z",
        completedAt: "2026-07-29T01:05:00.000Z",
        status: "completed",
        resultSummary: "Old result that should be dropped",
      },
      {
        sessionId: "session-recent",
        startedAt: "2026-07-30T01:00:00.000Z",
        completedAt: "2026-07-30T01:05:00.000Z",
        status: "completed",
        resultSummary: "Restarted the unhealthy service",
      },
      {
        sessionId: "session-failed",
        startedAt: "2026-07-31T01:00:00.000Z",
        completedAt: "2026-07-31T01:01:00.000Z",
        status: "failed",
        error: "Health endpoint timed out",
      },
      {
        sessionId: "session-current",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "running",
      },
    ],
  }));

  assert.ok(context);
  assert.doesNotMatch(context, /Old result that should be dropped/);
  assert.match(context, /Restarted the unhealthy service/);
  assert.match(context, /Health endpoint timed out/);
  assert.doesNotMatch(context, /session-current/);
});

test("recurring task continuity is disabled when reuseSession is false", () => {
  const context = scheduledTaskPriorRunContext(scheduledTask({
    reuseSession: false,
    runs: [{
      sessionId: "session-1",
      startedAt: "2026-07-31T01:00:00.000Z",
      completedAt: "2026-07-31T01:05:00.000Z",
      status: "completed",
      resultSummary: "This must not be carried forward",
    }],
  }));

  assert.equal(context, undefined);
});

test("recurring task continuity bounds unusually large run summaries", () => {
  const context = scheduledTaskPriorRunContext(scheduledTask({
    reuseSession: true,
    runs: [{
      sessionId: "session-1",
      startedAt: "2026-07-31T01:00:00.000Z",
      completedAt: "2026-07-31T01:05:00.000Z",
      status: "completed",
      resultSummary: `start-${"x".repeat(12_000)}-end`,
    }],
  }));

  assert.ok(context);
  assert.match(context, /start-/);
  assert.match(context, /prior run summary truncated/);
  assert.match(context, /-end/);
  assert.ok(context.length < 9_000);
});

test("scheduled task result read state is durable and reversible", () => {
  const task = scheduledTask({ lastReadAt: undefined });
  const read = setScheduledTaskReadState(
    task,
    true,
    new Date("2026-08-01T18:00:00.000Z"),
  );
  assert.equal(read.lastReadAt, "2026-08-01T18:00:00.000Z");
  assert.equal(task.lastReadAt, undefined);

  const unread = setScheduledTaskReadState(read, false);
  assert.equal(unread.lastReadAt, undefined);
});

test("only terminal one-off tasks can be archived", () => {
  assert.equal(scheduledTaskCanArchive(scheduledTask({ status: "completed", recurrence: undefined })), true);
  assert.equal(scheduledTaskCanArchive(scheduledTask({ status: "failed", recurrence: undefined })), true);
  assert.equal(scheduledTaskCanArchive(scheduledTask({ status: "cancelled", recurrence: undefined })), true);
  assert.equal(scheduledTaskCanArchive(scheduledTask({ status: "pending", recurrence: undefined })), false);
  assert.equal(scheduledTaskCanArchive(scheduledTask({ status: "completed" })), false);
});

test("archiving acknowledges a task and restoring preserves its history", () => {
  const task = scheduledTask({ status: "completed", recurrence: undefined });
  const archived = setScheduledTaskArchiveState(
    task,
    true,
    new Date("2026-08-01T19:00:00.000Z"),
  );
  assert.equal(archived.archivedAt, "2026-08-01T19:00:00.000Z");
  assert.equal(archived.lastReadAt, "2026-08-01T19:00:00.000Z");
  assert.equal(archived.runs, task.runs);

  const restored = setScheduledTaskArchiveState(archived, false);
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.lastReadAt, archived.lastReadAt);
});

test("scheduled task revisions change whenever the authoritative file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-task-revision-"));
  const file = path.join(dir, "scheduled-tasks.json");
  try {
    assert.equal(scheduledTaskRevisionForPath(file), "missing");
    fs.writeFileSync(file, "[]");
    const emptyRevision = scheduledTaskRevisionForPath(file);
    fs.writeFileSync(file, '[{"id":"task-1"}]');
    assert.notEqual(scheduledTaskRevisionForPath(file), emptyRevision);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startup recovery closes an orphaned run and advances a recurring task", () => {
  const recovered = reconcileInterruptedScheduledTask(
    scheduledTask(),
    new Date("2026-08-01T17:00:00.000Z"),
  );

  assert.ok(recovered);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.scheduledTime, "2026-08-02T01:00:00.000Z");
  assert.equal(recovered.runCount, 9);
  assert.equal(recovered.runs.length, 1);
  assert.equal(recovered.runs[0].status, "failed");
  assert.equal(recovered.runs[0].sessionId, "session-1");
  assert.equal(recovered.runs[0].startedAt, "2026-08-01T01:00:00.000Z");
  assert.equal(recovered.runs[0].completedAt, "2026-08-01T17:00:00.000Z");
  assert.match(recovered.runs[0].error, /server restart/);
});

test("startup recovery finalizes the durable running record without duplicating it", () => {
  const recovered = reconcileInterruptedScheduledTask(
    scheduledTask({
      runs: [{
        sessionId: "session-1",
        startedAt: "2026-08-01T01:00:04.000Z",
        status: "running",
        trigger: "scheduled",
      }],
    }),
    new Date("2026-08-01T01:05:00.000Z"),
  );

  assert.ok(recovered);
  assert.equal(recovered.runs.length, 1);
  assert.equal(recovered.runs[0].status, "failed");
  assert.equal(recovered.runs[0].startedAt, "2026-08-01T01:00:04.000Z");
});

test("startup recovery restores the prior state of an interrupted manual run", () => {
  const recovered = reconcileInterruptedScheduledTask(
    scheduledTask({
      status: "running",
      scheduledTime: "2026-08-03T01:00:00.000Z",
      runs: [{
        sessionId: "session-1",
        startedAt: "2026-08-01T16:00:00.000Z",
        status: "running",
        trigger: "manual",
        resumeTaskStatus: "pending",
      }],
    }),
    new Date("2026-08-01T17:00:00.000Z"),
  );

  assert.ok(recovered);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.scheduledTime, "2026-08-03T01:00:00.000Z");
});

test("startup recovery leaves non-running tasks untouched", () => {
  assert.equal(
    reconcileInterruptedScheduledTask(scheduledTask({ status: "pending" })),
    null,
  );
});
