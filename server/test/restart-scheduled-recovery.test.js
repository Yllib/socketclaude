const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-recovered-task-test-"));
process.env.SOCKET_AGENT_DATA_DIR = dir;
process.env.SOCKETAGENT_DATA_DIR = dir;
process.env.SOCKET_AGENT_HOME = dir;
const { saveScheduledTask, getScheduledTask, reconcileInterruptedScheduledTasks, finishRecoveredScheduledTask } = require("../dist/scheduled-task-store");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function task(id, extra = {}) {
  return {
    id, prompt: "Test only", cwd: dir, status: "running", sessionId: id,
    scheduledTime: "2026-09-05T12:00:00.000Z", createdAt: "2026-09-05T00:00:00.000Z",
    runCount: 0, runs: [{ sessionId: id, status: "running", startedAt: "2026-09-05T12:00:00.000Z", trigger: "scheduled" }],
    ...extra,
  };
}

test("durably resumable task is not failed or scheduled a second time at startup", () => {
  saveScheduledTask(task("resume"));
  saveScheduledTask(task("legacy"));
  const changed = reconcileInterruptedScheduledTasks(new Date("2026-09-05T12:01:00Z"), new Set(["resume"]));
  assert.deepEqual(changed.map(t => t.id), ["legacy"]);
  assert.equal(getScheduledTask("resume").status, "running");
  assert.equal(getScheduledTask("resume").runs.length, 1);
  const completed = finishRecoveredScheduledTask("resume", "completed", "Done");
  assert.equal(completed.status, "completed");
  assert.equal(completed.runCount, 1);
  assert.equal(completed.runs.length, 1);
  assert.equal(finishRecoveredScheduledTask("resume", "completed", "Duplicate"), undefined);
});

test("recovered recurring task completes the original run and schedules its next occurrence", () => {
  saveScheduledTask(task("daily", { recurrence: { type: "daily" } }));
  const completed = finishRecoveredScheduledTask("daily", "completed", "Done", new Date("2026-09-05T12:05:00Z"));
  assert.equal(completed.status, "pending");
  assert.equal(completed.scheduledTime, "2026-09-06T12:00:00.000Z");
  assert.equal(completed.runs[0].status, "completed");
});

test("failed recovered manual run restores its prior schedule status", () => {
  const manual = task("manual");
  manual.runs[0].trigger = "manual";
  manual.runs[0].resumeTaskStatus = "pending";
  saveScheduledTask(manual);
  const failed = finishRecoveredScheduledTask("manual", "failed", "Backend unavailable");
  assert.equal(failed.status, "pending");
  assert.equal(failed.runs[0].status, "failed");
  assert.equal(failed.runs[0].error, "Backend unavailable");
});
