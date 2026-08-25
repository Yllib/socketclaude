const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
require("./test-data-dir");

const {
  ClaudeSession,
  claudeApiRetryDelayMs,
  isLiveClaudeUserEcho,
} = require("../dist/claude-session");
const {
  CodexSession,
  codexAgentMessagePhase,
} = require("../dist/codex-session");
const {
  appendHistory,
  deleteSessionArtifacts,
  getHistory,
  getSession,
  saveSession,
} = require("../dist/session-store");

function testSocket(sent) {
  return {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test("ignores replayed Claude user echoes and uses the SDK retry delay", () => {
  assert.equal(isLiveClaudeUserEcho({ type: "user", uuid: "live" }), true);
  assert.equal(isLiveClaudeUserEcho({ type: "user", uuid: "old", isReplay: true }), false);
  assert.equal(isLiveClaudeUserEcho({ type: "user", isSynthetic: true }), false);
  assert.equal(claudeApiRetryDelayMs({ retry_delay_ms: 2750 }), 2750);
  assert.equal(claudeApiRetryDelayMs({ delay_ms: 9999 }), 0);
});

test("retracts superseded Claude messages from durable and live history", () => {
  const sent = [];
  const sessionId = `claude-retraction-${crypto.randomUUID()}`;
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = sessionId;
  saveSession({
    id: sessionId,
    title: "Retraction test",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "claude",
  });
  appendHistory(sessionId, {
    role: "assistant",
    content: "refused partial",
    uuid: "retracted-uuid",
    timestamp: new Date().toISOString(),
  });
  appendHistory(sessionId, {
    role: "assistant",
    content: "keep me",
    uuid: "kept-uuid",
    timestamp: new Date().toISOString(),
  });

  try {
    session._retractClaudeMessages(["retracted-uuid"]);
    assert.deepEqual(getHistory(sessionId).map((entry) => entry.uuid), ["kept-uuid"]);
    assert.ok(sent.some((message) =>
      message.type === "history_retracted"
      && message.sessionId === sessionId
      && message.uuids[0] === "retracted-uuid"));
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("remaps a Claude conversation reset without losing session metadata", () => {
  const sent = [];
  const oldId = `claude-reset-old-${crypto.randomUUID()}`;
  const newId = `claude-reset-new-${crypto.randomUUID()}`;
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = oldId;
  let remapped;
  session.onSessionIdChanged = (previous, next) => { remapped = [previous, next]; };
  saveSession({
    id: oldId,
    title: "Pinned development session",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "claude",
  });
  appendHistory(oldId, {
    role: "user",
    content: "before reset",
    uuid: "before-reset",
    timestamp: new Date().toISOString(),
  });

  try {
    session._handleClaudeConversationReset({
      type: "conversation_reset",
      session_id: oldId,
      new_conversation_id: newId,
    });
    assert.equal(getSession(oldId), undefined);
    assert.equal(getSession(newId).title, "Pinned development session");
    assert.equal(getHistory(newId)[0].uuid, "before-reset");
    assert.deepEqual(remapped, [oldId, newId]);
    assert.ok(sent.some((message) =>
      message.type === "session_created"
      && message.sessionId === newId
      && message.replacesSessionId === oldId));
  } finally {
    deleteSessionArtifacts(newId);
  }
});

test("preserves Codex agent message phase and resolves cleared questions", () => {
  const sent = [];
  const sessionId = `codex-phase-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = sessionId;
  session.threadId = sessionId;
  saveSession({
    id: sessionId,
    title: "Codex phase test",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "codex",
  });

  try {
    session.handleAppServerNotification("item/started", {
      threadId: sessionId,
      item: { id: "message-1", type: "agentMessage", text: "", phase: "commentary" },
    });
    session.handleAppServerNotification("item/agentMessage/delta", {
      threadId: sessionId,
      itemId: "message-1",
      delta: "Checking",
    });
    session.handleAppServerNotification("item/completed", {
      threadId: sessionId,
      item: { id: "message-1", type: "agentMessage", text: "Checking", phase: "commentary" },
    });
    assert.equal(codexAgentMessagePhase("commentary"), "commentary");
    assert.equal(codexAgentMessagePhase("final"), undefined);
    assert.ok(sent.some((message) =>
      message.type === "text" && message.messagePhase === "commentary"));
    assert.equal(getHistory(sessionId).find((entry) => entry.streamId === "message-1").messagePhase, "commentary");

    let resolved = false;
    session.pendingQuestions.set("question-1", {
      questionId: "question-1",
      resolve: () => { resolved = true; },
    });
    session.appServerQuestionByRequestId.set("42", "question-1");
    session.handleAppServerNotification("serverRequest/resolved", {
      threadId: sessionId,
      requestId: 42,
    });
    assert.equal(resolved, true);
    assert.equal(session.pendingQuestions.has("question-1"), false);
    assert.ok(sent.some((message) =>
      message.type === "question_answered" && message.questionId === "question-1"));
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});
