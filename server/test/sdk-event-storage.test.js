const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
require("./test-data-dir");

const {
  appendSdkEvent,
  deleteSessionArtifacts,
  getSdkEvents,
} = require("../dist/session-store");

test("batched SDK debug events are flushed before history is read", () => {
  const sessionId = `test-sdk-events-${randomUUID()}`;
  try {
    appendSdkEvent(sessionId, { ts: "1", sdkType: "first" });
    appendSdkEvent(sessionId, { ts: "2", sdkType: "second" });

    const events = getSdkEvents(sessionId, 10);
    assert.deepEqual(events.map((event) => event.sdkType), ["first", "second"]);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});
