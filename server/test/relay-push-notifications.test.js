const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  getPushDeliveryCapabilities,
  isPushConfigured,
  sendPushNotification,
  shouldSendForwardedPush,
} = require("../dist/push-notifications");

const pushEnvironmentKeys = [
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "RELAY_URL",
  "PAIRING_TOKEN",
];

function withCleanPushEnvironment(run) {
  const previous = Object.fromEntries(
    pushEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of pushEnvironmentKeys) delete process.env[key];
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("headless forwarding never duplicates an FCM dispatch owned by NotifyUser", () => {
  assert.equal(shouldSendForwardedPush({
    type: "scheduled_task_notification",
    fcmDispatched: true,
  }), false);
  assert.equal(shouldSendForwardedPush({
    type: "scheduled_task_notification",
  }), true);
});

test("reports missing, invalid, and valid direct Firebase setup separately", async () => {
  await withCleanPushEnvironment(async () => {
    assert.deepEqual(getPushDeliveryCapabilities(), {
      directFcmConfigured: false,
      directFcmIssue: "missing",
      relayConfigured: false,
    });

    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "not-json";
    assert.equal(getPushDeliveryCapabilities().directFcmIssue, "invalid");

    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "socketagent-test",
      client_email: "firebase@example.test",
      private_key: "test-key",
    });
    assert.deepEqual(getPushDeliveryCapabilities(), {
      directFcmConfigured: true,
      relayConfigured: false,
    });
  });
});

test("reports unreadable Firebase credential files and relay availability", async () => {
  await withCleanPushEnvironment(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-push-"));
    try {
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(directory, "missing.json");
      process.env.RELAY_URL = "wss://relay.example.test";
      process.env.PAIRING_TOKEN = "pairing-secret";
      assert.deepEqual(getPushDeliveryCapabilities(), {
        directFcmConfigured: false,
        directFcmIssue: "unreadable",
        relayConfigured: true,
      });
      assert.equal(isPushConfigured(), true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("routes authoritative FCM payloads through the configured relay", async () => {
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, sent: 1, attempted: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const oldRelay = process.env.RELAY_URL;
  const oldPairing = process.env.PAIRING_TOKEN;
  process.env.RELAY_URL = `ws://127.0.0.1:${address.port}`;
  process.env.PAIRING_TOKEN = "pairing-secret";

  try {
    assert.equal(isPushConfigured(), true);
    const result = await sendPushNotification({
      title: "Finished",
      body: "Final response text",
      sessionId: "session-1",
      status: "completed",
      kind: "session_finished",
      showNotification: false,
      data: {
        finishedAt: "2026-07-18T13:00:00.000Z",
        navigationTarget: "scheduled_tasks",
        scheduledTaskId: "task-1",
      },
    });
    assert.deepEqual(result, { sent: 1, attempted: 1 });
    assert.equal(received.pairingToken, "pairing-secret");
    assert.equal(received.kind, "session_finished");
    assert.equal(received.showNotification, false);
    assert.equal(received.data.finishedAt, "2026-07-18T13:00:00.000Z");
    assert.equal(received.data.navigationTarget, "scheduled_tasks");
    assert.equal(received.data.scheduledTaskId, "task-1");
  } finally {
    if (oldRelay === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = oldRelay;
    if (oldPairing === undefined) delete process.env.PAIRING_TOKEN;
    else process.env.PAIRING_TOKEN = oldPairing;
    await new Promise((resolve) => server.close(resolve));
  }
});
