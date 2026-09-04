const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("./test-data-dir");

const {
  ClaudeSession,
  CLAUDE_TASK_TOOLS,
  appendClaudeResourceLinks,
  claudeContinuationPending,
  claudeTurnCorrelation,
  claudeApiRetryDelayMs,
  filterClaudePhoneCommands,
  formatClaudeQueryError,
  isLiveClaudeUserEcho,
} = require("../dist/claude-session");
const {
  CodexSession,
  codexAgentMessagePhase,
  codexThreadGitInfo,
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

test("adopts new Claude SDK correlation, queue, command, and resource metadata", () => {
  assert.deepEqual(claudeTurnCorrelation({
    user_message_uuid: "user-2",
    user_message_uuids: ["user-1", "user-2", "user-2"],
  }), {
    triggerUserMessageUuid: "user-2",
    triggerUserMessageUuids: ["user-1", "user-2"],
  });
  assert.equal(claudeContinuationPending(1, 0), true);
  assert.equal(claudeContinuationPending(0, 1), true);
  assert.equal(claudeContinuationPending(0, 0), false);
  assert.deepEqual(
    filterClaudePhoneCommands(
      [{ name: "context" }, { name: "exit" }, { name: "statusline" }],
      ["/exit", "statusline"],
    ).map((command) => command.name),
    ["context"],
  );
  assert.equal(
    appendClaudeResourceLinks("Created report", [
      { name: "Report", uri: "file:///tmp/report.pdf" },
      { name: "missing-uri" },
    ]),
    "Created report\n\nResources:\n- [Report](file:///tmp/report.pdf)",
  );
});

test("keeps Claude task tools required by the SocketAgent task pane explicit", () => {
  assert.deepEqual(CLAUDE_TASK_TOOLS, [
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "TodoWrite",
  ]);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/claude-session.ts"),
    "utf8",
  );
  assert.match(source, /CLAUDE_CODE_ENABLE_TASKS\"\] = \"1\"/);
  assert.match(source, /CLAUDE_CODE_ENABLE_TODO_TOOLS\"\] = \"1\"/);
  assert.match(source, /\[\"mcp__app__\*\", \.\.\.CLAUDE_TASK_TOOLS\]/);
});

test("hides ambient Claude tasks and preserves foreground task metadata", () => {
  const sent = [];
  const sessionId = `claude-task-flags-${crypto.randomUUID()}`;
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = sessionId;
  saveSession({
    id: sessionId,
    title: "Task flags",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "claude",
  });

  try {
    session._handleSdkTaskStarted({
      task_id: "ambient-1",
      description: "watcher",
      ambient: true,
    });
    assert.equal(sent.length, 0);

    session._handleSdkTaskStarted({
      task_id: "agent-1",
      tool_use_id: "tool-1",
      task_type: "local_agent",
      description: "review",
      is_backgrounded: false,
      spawn_depth: 2,
    });
    const started = sent.find((message) => message.type === "task_started");
    assert.equal(started.isBackgrounded, false);
    assert.equal(started.spawnDepth, 2);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("surfaces Codex async questions and authentication recovery", () => {
  const sent = [];
  const sessionId = `codex-new-events-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = sessionId;
  session.threadId = sessionId;
  saveSession({
    id: sessionId,
    title: "Codex events",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "codex",
  });

  try {
    session.handleAppServerNotification("item/completed", {
      threadId: sessionId,
      item: {
        id: "question-item",
        type: "agentMessage",
        text: "",
        questions: [{ title: "Which target?", options: ["Server", "App"] }],
      },
    });
    session.handleAppServerNotification("modelProvider/authRecoveryStarted", {
      threadId: sessionId,
      provider: "openai",
      message: "Refreshing credentials",
    });
    session.handleAppServerNotification("modelProvider/authRecoveryCompleted", {
      threadId: sessionId,
      provider: "openai",
    });

    const question = sent.find((message) => message.type === "question");
    assert.equal(question.asyncQuestion, true);
    assert.deepEqual(question.questions[0].options, [
      { label: "Server" },
      { label: "App" },
    ]);
    assert.deepEqual(
      sent.filter((message) => message.type === "backend_auth_recovery")
        .map((message) => message.active),
      [true, false],
    );
    assert.equal(
      getHistory(sessionId).find((entry) => entry.role === "question").asyncQuestion,
      true,
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("restores Codex thread model settings and keeps plan updates enabled", () => {
  const sent = [];
  const sessionId = `codex-thread-settings-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  try {
    session.adoptAppServerThread(sessionId, {
      thread: {
        id: sessionId,
        model: "gpt-5.6-codex",
        reasoningEffort: "xhigh",
      },
    });
    assert.equal(session.getAgentSettings().model, "gpt-5.6-codex");
    assert.equal(session.getAgentSettings().effort, "xhigh");
    assert.deepEqual(session.appServerConfig().tools, {
      update_plan: { enabled: true },
    });
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("collects current git metadata for Codex thread attribution", () => {
  const gitInfo = codexThreadGitInfo(path.join(__dirname, "../.."));
  assert.match(gitInfo.sha, /^[0-9a-f]{40}$/);
  assert.equal(gitInfo.branch, "master");
  assert.equal(codexThreadGitInfo(path.join(__dirname, "missing-repository")), null);
});

test("reports useful Claude spawn details without exposing raw arguments", () => {
  const error = Object.assign(new Error("spawn EIO"), {
    code: "EIO",
    errno: -5,
    syscall: "spawn /usr/bin/node",
    path: "/usr/bin/node",
    spawnargs: ["/opt/socketagent/cli.js", "--mcp-config", "private-token"],
  });
  const message = formatClaudeQueryError(
    error,
    "Unknown error starting query",
    "/mnt/c/Users/test/project",
    { path: "/opt/socketagent/cli.js", source: "sdk" },
  );

  assert.match(message, /Claude process failed to start: spawn EIO/);
  assert.match(message, /code=EIO/);
  assert.match(message, /syscall=spawn \/usr\/bin\/node/);
  assert.match(message, /executable=\/usr\/bin\/node/);
  assert.match(message, /claudeCli=\/opt\/socketagent\/cli\.js/);
  assert.match(message, /cwd=\/mnt\/c\/Users\/test\/project/);
  assert.match(message, /argumentCount=3/);
  assert.doesNotMatch(message, /private-token/);
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
