const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ControlMessageScheduler,
  controlMessageQueueScope,
} = require("../dist/control-message-scheduler");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("classifies priority, concurrent, per-session, and lifecycle messages", () => {
  assert.deepEqual(controlMessageQueueScope({ type: "abort", sessionId: "a" }), {
    kind: "priority",
  });
  assert.deepEqual(controlMessageQueueScope({ type: "list_sessions" }), {
    kind: "concurrent",
  });
  assert.deepEqual(controlMessageQueueScope({ type: "rename_session", sessionId: " a " }), {
    kind: "session",
    sessionId: "a",
  });
  assert.deepEqual(controlMessageQueueScope({ type: "prompt", sessionId: "a" }), {
    kind: "connection",
    sessionId: "a",
  });
  assert.deepEqual(controlMessageQueueScope({ type: "set_tts" }), {
    kind: "connection",
  });
});

test("serializes one session while allowing another session to proceed", async () => {
  const scheduler = new ControlMessageScheduler();
  const gate = deferred();
  const events = [];

  const firstA = scheduler.run(
    { type: "rename_session", sessionId: "a" },
    async () => {
      events.push("a1:start");
      await gate.promise;
      events.push("a1:end");
    },
  );
  const secondA = scheduler.run(
    { type: "delete_session", sessionId: "a" },
    async () => {
      events.push("a2");
    },
  );
  const sessionB = scheduler.run(
    { type: "rename_session", sessionId: "b" },
    async () => {
      events.push("b");
    },
  );

  await nextTurn();
  assert.deepEqual(events, ["a1:start", "b"]);

  gate.resolve();
  await Promise.all([firstA, secondA, sessionB]);
  assert.deepEqual(events, ["a1:start", "b", "a1:end", "a2"]);
});

test("cached reads bypass a blocked connection lifecycle operation", async () => {
  const scheduler = new ControlMessageScheduler();
  const gate = deferred();
  const events = [];

  const prompt = scheduler.run(
    { type: "prompt", sessionId: "a" },
    async () => {
      events.push("prompt:start");
      await gate.promise;
      events.push("prompt:end");
    },
  );
  const list = scheduler.run({ type: "list_sessions" }, async () => {
    events.push("list");
  });

  await list;
  assert.deepEqual(events, ["prompt:start", "list"]);

  gate.resolve();
  await prompt;
  assert.deepEqual(events, ["prompt:start", "list", "prompt:end"]);
});

test("keeps active-runner lifecycle changes in connection order", async () => {
  const scheduler = new ControlMessageScheduler();
  const gate = deferred();
  const events = [];

  const prompt = scheduler.run(
    { type: "prompt", sessionId: "a" },
    async () => {
      events.push("prompt:start");
      await gate.promise;
      events.push("prompt:end");
    },
  );
  const resume = scheduler.run(
    { type: "resume_session", sessionId: "b" },
    async () => {
      events.push("resume");
    },
  );

  await nextTurn();
  assert.deepEqual(events, ["prompt:start"]);

  gate.resolve();
  await Promise.all([prompt, resume]);
  assert.deepEqual(events, ["prompt:start", "prompt:end", "resume"]);
});

test("lifecycle work also preserves ordering within its target session", async () => {
  const scheduler = new ControlMessageScheduler();
  const gate = deferred();
  const events = [];

  const prompt = scheduler.run(
    { type: "prompt", sessionId: "a" },
    async () => {
      events.push("prompt:start");
      await gate.promise;
      events.push("prompt:end");
    },
  );
  const sameSession = scheduler.run(
    { type: "clear_context", sessionId: "a" },
    async () => {
      events.push("clear:a");
    },
  );
  const otherSession = scheduler.run(
    { type: "rename_session", sessionId: "b" },
    async () => {
      events.push("rename:b");
    },
  );

  await nextTurn();
  assert.deepEqual(events, ["prompt:start", "rename:b"]);

  gate.resolve();
  await Promise.all([prompt, sameSession, otherSession]);
  assert.deepEqual(events, ["prompt:start", "rename:b", "prompt:end", "clear:a"]);
});

test("a rejected operation does not poison its session queue", async () => {
  const scheduler = new ControlMessageScheduler();
  const expected = new Error("expected failure");
  const failed = scheduler.run(
    { type: "rename_session", sessionId: "a" },
    async () => {
      throw expected;
    },
  );
  const recovered = scheduler.run(
    { type: "delete_session", sessionId: "a" },
    async () => "continued",
  );

  await assert.rejects(failed, expected);
  assert.equal(await recovered, "continued");
});
