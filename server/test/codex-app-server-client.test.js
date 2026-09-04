const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  CodexAppServerClient,
  CodexAppServerRequestTimeoutError,
} = require("../dist/codex-app-server-client");
const { isTimedOutCodexThreadResume } = require("../dist/codex-session");

const echoServer = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: { method: request.method, params: request.params },
    }) + "\n");
  }
});
`;

function waitForEvent(emitter, name) {
  return Promise.race([
    new Promise((resolve) => emitter.once(name, resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out waiting for ${name}`)),
      3000,
    )),
  ]);
}

test("completes the app-server initialize handshake before other requests", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mock-codex-app-server.js")],
  });

  try {
    const initialized = waitForEvent(client, "test/initialized_seen");
    await client.initialize({ clientInfo: { name: "socketagent" } });
    const event = await initialized;
    assert.deepEqual(event.methods, ["initialize", "initialized"]);

    const metadata = await client.updateThreadMetadata({
      threadId: "thread-1",
      gitInfo: { branch: "master", sha: "abc123" },
    });
    assert.deepEqual(metadata, {
      threadId: "thread-1",
      gitInfo: { branch: "master", sha: "abc123" },
    });
  } finally {
    await client.stop();
  }
});

test("thread resume excludes the native turn transcript by default", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", echoServer],
    requestTimeoutMs: 1000,
  });
  try {
    const result = await client.resumeThread({ threadId: "large-thread" });
    assert.equal(result.method, "thread/resume");
    assert.equal(result.params.threadId, "large-thread");
    assert.equal(result.params.excludeTurns, true);

    const explicit = await client.resumeThread({
      threadId: "history-client",
      excludeTurns: false,
    });
    assert.equal(explicit.params.excludeTurns, false);

    const unsubscribe = await client.unsubscribeThread("large-thread");
    assert.equal(unsubscribe.method, "thread/unsubscribe");
    assert.equal(unsubscribe.params.threadId, "large-thread");
  } finally {
    await client.stop();
  }
});

test("sends stable client user message IDs on turns and steers", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", echoServer],
    requestTimeoutMs: 1000,
  });
  try {
    const turn = await client.startTurn({
      threadId: "thread-1",
      clientUserMessageId: "phone-message-1",
      input: [{ type: "text", text: "hello" }],
      model: "test-model",
    });
    assert.equal(turn.params.clientUserMessageId, "phone-message-1");

    const steer = await client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "phone-message-2",
      input: [{ type: "text", text: "more context" }],
    });
    assert.equal(steer.params.clientUserMessageId, "phone-message-2");
  } finally {
    await client.stop();
  }
});

test("request timeouts retain the RPC method for poisoned-client cleanup", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    requestTimeoutMs: 20,
  });
  try {
    await assert.rejects(
      client.resumeThread({ threadId: "stuck-thread" }),
      (error) => {
        assert.ok(error instanceof CodexAppServerRequestTimeoutError);
        assert.equal(error.method, "thread/resume");
        assert.equal(error.timeoutMs, 20);
        assert.equal(isTimedOutCodexThreadResume(error), true);
        return true;
      },
    );
  } finally {
    await client.stop();
  }
});

test("non-resume timeouts do not trigger thread-writer cleanup", () => {
  const error = new CodexAppServerRequestTimeoutError("model/list", 20);
  assert.equal(isTimedOutCodexThreadResume(error), false);
});
