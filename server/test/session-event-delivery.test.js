const assert = require("node:assert/strict");
const test = require("node:test");

const { SessionEventDelivery } = require("../dist/session-event-delivery");

test("tool cards retry until acknowledged", async () => {
  const sent = [];
  const delivery = new SessionEventDelivery((message) => sent.push(message), 10);
  const prepared = delivery.prepare({
    type: "tool_call",
    sessionId: "session-1",
    toolUseId: "tool-1",
    tool: "Bash",
  });

  assert.ok(prepared.deliveryId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(sent.length >= 1);
  assert.equal(sent[0].deliveryId, prepared.deliveryId);
  assert.equal(sent[0].replay, true);

  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  const countAfterAck = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sent.length, countAfterAck);
  delivery.dispose();
});

test("automatic retries are bounded while the event remains reconnectable", async () => {
  const sent = [];
  const delivery = new SessionEventDelivery(
    (message) => sent.push(message),
    5,
    100,
    10_000,
    2,
  );
  const prepared = delivery.prepare({
    type: "tool_call",
    sessionId: "background-session",
    toolUseId: "tool-background",
    tool: "Bash",
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.length, 2);
  assert.equal(delivery.pendingCount, 1);

  const replayed = [];
  delivery.replayTo((message) => replayed.push(message));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].deliveryId, prepared.deliveryId);
  delivery.dispose();
});

test("non-card stream deltas are not retried as duplicate deltas", () => {
  const delivery = new SessionEventDelivery(() => {});
  const message = { type: "text", content: "delta", streamId: "message-1" };
  assert.equal(delivery.prepare(message), message);
  assert.equal(delivery.pendingCount, 0);
  delivery.dispose();
});

test("only final cumulative assistant snapshots require acknowledgement", () => {
  const delivery = new SessionEventDelivery(() => {});
  const inProgress = { type: "text", content: "hello", snapshot: true };
  const final = {
    type: "text",
    content: "hello world",
    snapshot: true,
    finalSnapshot: true,
  };

  assert.equal(delivery.prepare(inProgress), inProgress);
  const preparedFinal = delivery.prepare(final);
  assert.ok(preparedFinal.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  delivery.dispose();
});

test("user prompt positions require acknowledgement", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({
    type: "user_message_uuid",
    sessionId: "session-1",
    clientMessageId: "client-message-1",
    uuid: "user-uuid-1",
    entryId: "history-1",
    sessionSeq: 12,
  });
  assert.ok(prepared.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  delivery.dispose();
});

test("pending cards replay immediately to a reattached client", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({ type: "tool_result", toolUseId: "tool-1" });
  const replayed = [];
  delivery.replayTo((message) => replayed.push(message));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].deliveryId, prepared.deliveryId);
  assert.equal(replayed[0].replay, true);
  delivery.dispose();
});

test("HTML plan cards use acknowledged delivery", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({
    type: "html_plan",
    sessionId: "plan-session",
    planId: "plan-1",
    title: "Plan",
  });
  assert.ok(prepared.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  delivery.dispose();
});

test("Work Review cards use acknowledged delivery and stable replay IDs", () => {
  const sent = [];
  const delivery = new SessionEventDelivery((message) => sent.push(message), 10_000);
  const prepared = delivery.prepare({
    type: "work_review_card",
    sessionId: "review-session",
    reviewId: "review-1",
    entryId: "card-1",
    sessionSeq: 7,
    revision: 2,
  });
  assert.ok(prepared.deliveryId);
  const replayed = [];
  delivery.replayTo((message) => replayed.push(message));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].deliveryId, prepared.deliveryId);
  assert.equal(replayed[0].entryId, "card-1");
  delivery.dispose();
});

test("protected browser cards use acknowledged delivery", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({
    type: "browser_session_open",
    sessionId: "browser-session",
    profile: "google-play-rubano",
    entryId: "browser-session:google-play-rubano",
    sessionSeq: 12,
    revision: 4,
  });
  assert.ok(prepared.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  delivery.dispose();
});

test("Monitor output cards use acknowledged delivery", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({
    type: "monitor_output",
    sessionId: "monitor-session",
    taskId: "monitor-1",
    content: "build complete",
    snapshot: true,
    revision: 2,
  });
  assert.ok(prepared.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  delivery.dispose();
});

test("SendFile availability retries until the app registers it", () => {
  const delivery = new SessionEventDelivery(() => {});
  const prepared = delivery.prepare({
    type: "file",
    sessionId: "file-session",
    fileId: "send-delivery-1",
    fileName: "build.apk",
    filePath: "/tmp/build.apk",
    fileSize: 42,
  });
  assert.ok(prepared.deliveryId);
  assert.equal(delivery.pendingCount, 1);
  assert.equal(delivery.acknowledge(prepared.deliveryId), true);
  delivery.dispose();
});
