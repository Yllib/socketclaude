const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
require("./test-data-dir");
const { ClaudeSession } = require("../dist/claude-session");
const { CodexSession } = require("../dist/codex-session");
const { CodexAppServerClient } = require("../dist/codex-app-server-client");
const { claudeTotalUsage } = require("../dist/claude-usage");
const { getHistory, positionSessionMessage } = require("../dist/session-store");

function session(Type) {
  const sent = [];
  const value = new Type({ readyState: 1, send() {} }, process.cwd(), []);
  value.sessionId = `audit-${crypto.randomUUID()}`;
  value.threadId = value.sessionId;
  value.send = message => sent.push(positionSessionMessage(value.sessionId, message));
  return { value, sent };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Claude streamed blocks sharing an API id retain separate durable cards", () => {
  const { value, sent } = session(ClaudeSession);
  const event = (data) => ({ type: "stream_event", parent_tool_use_id: null, uuid: crypto.randomUUID(), event: data });
  value._streamKey(event({ type: "message_start", message: { id: "api-1" } }));
  for (const [index, text] of ["First paragraph", "Second paragraph"].entries()) {
    value._streamKey(event({ type: "content_block_start", index, content_block: { type: "text" } }));
    const streamId = value._appendLiveStream(value._streamingText, event({ type: "content_block_delta", index, delta: { type: "text_delta" } }), text);
    value.send({ type: "text", content: text, streamId, snapshot: true, sessionId: value.sessionId });
    const raw = { type: "assistant", uuid: `block-${index}`, parent_tool_use_id: null, message: { id: "api-1", content: [{ type: "text", text }] } };
    value._publishCompletedClaudeBlocks(raw);
    value._publishCompletedClaudeBlocks(raw); // duplicate delivery is idempotent
    assert.equal(sent.at(-1).streamId, streamId);
  }
  const history = getHistory(value.sessionId).filter(entry => entry.role === "assistant");
  assert.deepEqual(history.map(entry => entry.content), ["First paragraph", "Second paragraph"]);
  assert.notEqual(history[0].entryId, history[1].entryId);
  assert.equal(value._streamingText.size, 0);
});

test("Claude nonstreamed and multiblock snapshots do not collapse sibling blocks", () => {
  const { value } = session(ClaudeSession);
  for (const uuid of ["first", "second"]) value._publishCompletedClaudeBlocks({
    type: "assistant", uuid, message: { id: "shared", content: [{ type: "thinking", thinking: "Thinking" }, { type: "text", text: uuid }] },
  });
  assert.equal(getHistory(value.sessionId).filter(entry => entry.role === "assistant").length, 4);
});

test("Claude preserves hidden-thinking timing without merging it into text", () => {
  const { value, sent } = session(ClaudeSession);
  value._thinkingProgress = { startedAtMs: Date.now() - 1000, estimatedTokens: 12 };
  value._publishCompletedClaudeBlocks({ type: "assistant", uuid: "hidden", message: { id: "hidden-api", content: [{ type: "text", text: "Answer" }] } });
  assert.ok(sent.some(message => message.type === "thinking" && message.thinkingTokens === 12 && message.thinkingDurationMs >= 1000));
  assert.equal(value._thinkingProgress, null);
  assert.equal(getHistory(value.sessionId).filter(entry => entry.role === "assistant").length, 2);
});

test("Claude usage reads snake-case fallback and cumulative whole-tree model totals", () => {
  const result = { usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 }, total_cost_usd: 0.25, modelUsage: {} };
  assert.deepEqual(claudeTotalUsage(result), { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheCreateTokens: 5, costUsd: 0.25 });
  result.modelUsage = { main: { inputTokens: 20, outputTokens: 4 }, child: { inputTokens: 10, outputTokens: 2 } };
  assert.equal(claudeTotalUsage(result).inputTokens, 30);
  assert.equal(claudeTotalUsage(result).outputTokens, 6);
  assert.equal(claudeTotalUsage(result).inputTokens, 30); // reading another result does not add totals again
});

test("Claude callbacks require explicit approval, even for SDK asks in bypass mode", async () => {
  for (const mode of ["default", "plan", "bypassPermissions"]) {
    const { value, sent } = session(ClaudeSession);
    value._permissionMode = mode;
    const waiting = value._requestClaudeToolApproval("Write", { file_path: "/tmp/example" });
    await tick();
    const question = sent.find(message => message.type === "question");
    assert.ok(question);
    value.resolveQuestion(question.questionId, { [question.questions[0].question]: "Decline" });
    assert.equal((await waiting).behavior, "deny");
  }
});

test("Claude cancellation resolves and persists questions, including session abort", async () => {
  const { value, sent } = session(ClaudeSession);
  const controller = new AbortController();
  const waiting = value._requestClaudeToolApproval("Write", {}, controller.signal);
  controller.abort();
  assert.equal((await waiting).behavior, "deny");
  assert.equal(value.pendingQuestions.size, 0);
  assert.ok(sent.some(message => message.type === "question_answered"));
  const again = value._requestClaudeToolApproval("Read", {});
  await value.abort();
  assert.equal((await again).behavior, "deny");
  assert.equal(value.pendingQuestions.size, 0);
  assert.ok(getHistory(value.sessionId).filter(entry => entry.role === "question").every(entry => entry.answered));
});

test("Claude form answers bind question text to typed schema properties", async () => {
  const { value, sent } = session(ClaudeSession);
  const waiting = value._handleClaudeElicitation({ serverName: "test", mode: "form", message: "Details", requestedSchema: {
    type: "object", properties: { count: { type: "integer", description: "How many?", minimum: 1 }, enabled: { type: "boolean" } }, required: ["count", "enabled"],
  } });
  const question = sent.find(message => message.type === "question");
  value.resolveQuestion(question.questionId, { [question.questions[0].question]: "7", [question.questions[1].question]: "No" });
  assert.deepEqual(await waiting, { action: "accept", content: { count: 7, enabled: false } });
});

test("Claude rejects invalid or missing required form answers and cancels URL waits", async () => {
  const { value, sent } = session(ClaudeSession);
  for (const answer of ["1.5", ""]) {
    const waiting = value._handleClaudeElicitation({ serverName: "test", mode: "form", requestedSchema: {
      type: "object", properties: { count: { type: "integer" } }, required: ["count"],
    } });
    const question = sent.filter(message => message.type === "question").at(-1);
    value.resolveQuestion(question.questionId, { [question.questions[0].question]: answer });
    assert.equal((await waiting).action, "decline");
  }
  const controller = new AbortController();
  const waiting = value._handleClaudeElicitation({ serverName: "test", mode: "url", url: "https://example.com", message: "Sign in" }, controller.signal);
  controller.abort();
  assert.equal((await waiting).action, "cancel");
});

test("Codex accepts string request ids and returns integer protocol errors", () => {
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  const responses = [];
  client.writeResponse = response => responses.push(response);
  client.handleStdout(JSON.stringify({ id: "future-1", method: "future/request", params: {} }) + "\n");
  assert.equal(responses[0].id, "future-1");
  assert.equal(responses[0].error.code, -32601);
  client.on("serverRequest", (request, respond) => respond({ result: { accepted: request.id } }));
  client.handleStdout(JSON.stringify({ id: "input-1", method: "item/tool/requestUserInput", params: {} }) + "\n");
  assert.deepEqual(responses[1], { id: "input-1", result: { accepted: "input-1" } });
});

test("Codex restrictive approval waits for an answer and resolves cancellation", async () => {
  const { value, sent } = session(CodexSession);
  value._permissionMode = "default";
  let result;
  const waiting = value.handleAppServerRequest({ id: "approval", method: "item/commandExecution/requestApproval", params: { command: "example" } }, response => { result = response; });
  await tick();
  assert.equal(result, undefined);
  const question = sent.find(message => message.type === "question");
  value.resolveQuestion(question.questionId, { [question.questions[0].question]: "Approve" });
  await waiting;
  assert.deepEqual(result, { result: { decision: "accept" } });
  const cancelled = value.handleAppServerRequest({ id: "cancelled", method: "item/commandExecution/requestApproval", params: { command: "example" } }, response => { result = response; });
  await tick();
  value.resolveAppServerRequest("cancelled");
  await cancelled;
  assert.deepEqual(result, { result: { decision: "decline" } });
  assert.equal(value.pendingQuestions.size, 0);
});

test("Codex structured write paths reach policy checks and unknown paths fail closed", async () => {
  const { value } = session(CodexSession);
  const checked = [];
  value._plugins = [{ canUseToolInterceptor: async (name, input) => { checked.push(input.file_path); return { behavior: "deny" }; } }];
  assert.equal(await value.canApprovePermissionRequest({ fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/protected/file" } }] } }), false);
  assert.deepEqual(checked, ["/protected/file"]);
  assert.equal(await value.canApprovePermissionRequest({ fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }] } }), false);
});

test("Codex failed completion preserves the backend error and does not emit success", async () => {
  const { value, sent } = session(CodexSession);
  let rejected;
  value.appServerTurnSettler = { resolve() { assert.fail("failed turn resolved"); }, reject(error) { rejected = error; } };
  value.handleAppServerNotification("turn/completed", { threadId: value.threadId, turn: { id: "failed", status: "failed", error: { message: "Backend failure" } } });
  assert.match(rejected.message, /Backend failure/);
  assert.ok(sent.some(message => message.type === "error" && message.message.includes("Backend failure")));
  assert.equal(sent.some(message => message.type === "result"), false);
  assert.equal(value._isRunning, false);
});

test("Codex root completion leaves background requests to their resolved events", () => {
  const { value } = session(CodexSession);
  value.pendingQuestions.set("child-question", { questionId: "child-question", resolve() { assert.fail("background question cancelled by root completion"); } });
  value.handleAppServerNotification("turn/completed", { threadId: value.threadId, turn: { id: "root", status: "completed" } });
  assert.equal(value.pendingQuestions.size, 1);
  value.cancelPendingAppServerTurnCompletion();
});

test("Codex interrupted outcomes stay distinct from success", async () => {
  const { value, sent } = session(CodexSession);
  value.handleAppServerNotification("turn/completed", { threadId: value.threadId, turn: { id: "stopped", status: "interrupted" } });
  await new Promise(resolve => setTimeout(resolve, 650));
  const result = sent.find(message => message.type === "result");
  assert.equal(result.resultSubtype, "interrupted");
  assert.equal(result.stopReason, "interrupted");
});

test("Codex compaction waits after acknowledgement and cleans up listeners", async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  client.compactThread = async () => ({});
  let finished = false;
  const waiting = client.compactThreadAndWait("thread", 1000).then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  client.emit("notification", { method: "item/completed", params: { threadId: "other", item: { type: "contextCompaction" } } });
  assert.equal(finished, false);
  client.emit("notification", { method: "item/completed", params: { threadId: "thread", item: { type: "contextCompaction" } } });
  await waiting;
  assert.equal(client.listenerCount("notification"), 0);
});

test("Codex compaction rejects failure, process exit, and timeout", async () => {
  for (const cause of ["failure", "exit", "timeout"]) {
    const client = new CodexAppServerClient({ cwd: process.cwd() });
    client.compactThread = async () => ({});
    const waiting = client.compactThreadAndWait("thread", 20);
    if (cause === "failure") client.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { status: "failed", error: { message: "Failed compact" } } } });
    if (cause === "exit") client.emit("exit", 1);
    await assert.rejects(waiting);
    assert.equal(client.listenerCount("notification"), 0);
  }
});

test("Codex compaction keeps its process until the enclosing turn completes", async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  client.compactThread = async () => ({});
  let finished = false;
  const waiting = client.compactThreadAndWait("thread", 1000).then(() => { finished = true; });
  client.emit("notification", { method: "turn/started", params: { threadId: "thread", turn: { id: "compact-turn" } } });
  client.emit("notification", { method: "item/completed", params: { threadId: "thread", item: { type: "contextCompaction" } } });
  await tick();
  assert.equal(finished, false);
  client.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { id: "compact-turn", status: "completed" } } });
  await waiting;
  assert.equal(finished, true);
});

test("Codex manual compaction does not emit an old assistant response as a new result", () => {
  const { value, sent } = session(CodexSession);
  value._manualCompactionPending = true;
  value.handleAppServerNotification("turn/started", { threadId: value.threadId, turn: { id: "compact" } });
  value.handleAppServerNotification("turn/completed", { threadId: value.threadId, turn: { id: "compact", status: "completed" } });
  assert.equal(value.pendingAppServerTurnCompletion, null);
  assert.equal(sent.some(message => message.type === "result"), false);
});

test("Claude retires warm queries before applying changed query-only settings", async () => {
  const { value } = session(ClaudeSession);
  let closed = 0;
  value.activeQuery = { close() { closed++; } };
  value.activeInputQueue = { close() {} };
  value._queryConsumer = Promise.resolve();
  value.setDisallowedTools(["Bash"]);
  assert.equal(value._querySettingsDirty, true);
  await value._prepareQuerySettings();
  assert.equal(closed, 1);
  assert.equal(value.activeQuery, null);
});

test("Codex refuses to claim live permission changes before the turn stops", async () => {
  const { value, sent } = session(CodexSession);
  value._isRunning = true;
  const previous = value.permissionMode;
  await assert.rejects(value.setPermissionMode("plan"), /Stop the current Codex run/);
  assert.equal(value.permissionMode, previous);
  assert.equal(sent.at(-1).permissionMode, previous);
});
