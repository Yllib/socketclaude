const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./test-data-dir");

const {
  CodexSession,
  isCodexAppServerProcessFailure,
  isRecoverableCodexAppServerError,
  summarizeCodexCommandActions,
} = require("../dist/codex-session");
const {
  deleteSessionArtifacts,
  deriveClaudeTasksFromHistoryEntries,
  getHistory,
  normalizeMisclassifiedCodexItemEntries,
  normalizeSocketAgentAppToolEntries,
} = require("../dist/session-store");
const {
  handleReportSubagentAssignmentTool,
} = require("../dist/app-tool-handlers");
const {
  ClaudeSession,
  claudeAgentRunsInBackground,
  isClaudeAgentLaunchOutput,
  isClaudeTaskNotificationResult,
  reduceClaudeTaskTodos,
  replaceClaudeTaskTodos,
  replaceClaudeTodoWriteTodos,
} = require("../dist/claude-session");

function testSocket(sent) {
  return {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test("keeps a Codex turn running through response-stream reconnect notices", () => {
  const sent = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "reconnecting-session";
  session.threadId = session.sessionId;
  session._isRunning = true;
  let rejected = 0;
  session.appServerTurnSettler = {
    resolve: () => {},
    reject: () => { rejected += 1; },
  };
  const reconnect = {
    error: {
      message: "Reconnecting... 5/5",
      codexErrorInfo: {
        responseStreamDisconnected: { httpStatusCode: null },
      },
      additionalDetails:
        "stream disconnected before completion: websocket closed by server before response.completed",
    },
  };

  assert.equal(isRecoverableCodexAppServerError(reconnect), true);
  session.handleAppServerNotification("error", reconnect);
  session.handleAppServerErrorNotification(reconnect);

  assert.equal(rejected, 0);
  assert.equal(session.isRunning, true);
  assert.equal(sent.some((message) => message.type === "error"), false);
  assert.ok(sent.some((message) =>
    message.type === "session_state_changed"
    && message.state === "running"
    && message.sessionId === session.sessionId));
});

test("still rejects a terminal Codex app-server error exactly once", () => {
  const sent = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "terminal-error-session";
  session.threadId = session.sessionId;
  session._isRunning = true;
  let rejected = 0;
  session.appServerTurnSettler = {
    resolve: () => {},
    reject: () => { rejected += 1; },
  };
  const terminal = {
    error: {
      message: "Your usage limit has been reached",
      codexErrorInfo: { usageLimitExceeded: {} },
    },
  };

  assert.equal(isRecoverableCodexAppServerError(terminal), false);
  session.handleAppServerNotification("error", terminal);
  session.handleAppServerErrorNotification(terminal);

  assert.equal(rejected, 1);
  assert.equal(sent.filter((message) => message.type === "error").length, 1);
  assert.ok(sent.some((message) =>
    message.type === "session_state_changed"
    && message.state === "idle"));
});

test("recycles a systemError app-server and surfaces its detailed error once", async () => {
  const sent = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "system-error-session";
  session.threadId = session.sessionId;
  session._isRunning = true;
  let rejected = 0;
  let stopped = 0;
  session.appServerTurnSettler = {
    resolve: () => {},
    reject: () => { rejected += 1; },
  };
  session.appServer = {
    stop: async () => { stopped += 1; },
    removeAllListeners: () => {},
  };
  session.appServerInitialized = true;

  session.handleAppServerNotification("thread/status/changed", {
    threadId: session.threadId,
    status: { type: "systemError" },
  });
  session.handleAppServerNotification("error", {
    error: { message: "spawn EIO" },
  });
  session.handleAppServerErrorNotification({
    error: { message: "spawn EIO" },
  });

  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(isCodexAppServerProcessFailure("spawn EIO"), true);
  assert.equal(rejected, 1);
  assert.equal(stopped, 1);
  assert.equal(session.appServer, null);
  const errors = sent.filter((message) => message.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /spawn EIO/);
});

test("releases the Codex thread writer while keeping the app-server warm", async () => {
  const session = new CodexSession(testSocket([]), process.cwd(), []);
  const released = [];
  const client = {
    unsubscribeThread: async (threadId) => { released.push(threadId); },
  };
  session.threadId = "shared-with-desktop";
  session.appServer = client;
  session.appServerInitialized = true;

  await session.releaseAppServerThreadWriter();

  assert.deepEqual(released, ["shared-with-desktop"]);
  assert.equal(session.appServer, client);
});

test("stops the warm app-server when thread unsubscribe is unavailable", async () => {
  const session = new CodexSession(testSocket([]), process.cwd(), []);
  let stopped = 0;
  let expectedDuringStop = false;
  session.threadId = "legacy-codex-thread";
  session.appServer = {
    unsubscribeThread: async () => { throw new Error("Method not found"); },
    stop: async () => {
      stopped += 1;
      expectedDuringStop = session.appServerStopExpected;
    },
    removeAllListeners: () => {},
  };
  session.appServerInitialized = true;

  await session.releaseAppServerThreadWriter();

  assert.equal(stopped, 1);
  assert.equal(expectedDuringStop, true);
  assert.equal(session.appServer, null);
  assert.equal(session.appServerStopExpected, false);
});

test("raw Codex SDK events are sent only to subscribed sockets", () => {
  const sent = [];
  const socket = testSocket(sent);
  const session = new CodexSession(socket, process.cwd(), []);
  session.sessionId = "raw-subscription-test";
  session.threadId = "raw-subscription-test";

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: session.threadId,
    itemId: "message-1",
    delta: "first",
  });
  assert.equal(sent.some((message) => message.type === "sdk_event"), false);

  socket.supportsRawSdkEvents = true;
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: session.threadId,
    itemId: "message-1",
    delta: " second",
  });
  assert.equal(sent.some((message) =>
    message.type === "sdk_event"
    && message.method === "item/agentMessage/delta"), true);
});

test("keeps Codex subagent threads attached to the root session", () => {
  const sent = [];
  const rootId = `test-root-${crypto.randomUUID()}`;
  const childId = `test-child-${crypto.randomUUID()}`;
  const grandchildId = `test-grandchild-${crypto.randomUUID()}`;
  const childToolUseId = `codex-subagent:${childId}`;
  const grandchildToolUseId = `codex-subagent:${grandchildId}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);

  // Seed the already-adopted root thread, then simulate notifications from a
  // concurrently running child thread.
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("thread/started", {
      thread: { id: childId },
      agentPath: "/root/reviewer",
    });

    assert.equal(session.getSessionId(), rootId);
    assert.ok(sent.some((message) =>
      message.type === "tool_call"
      && message.toolUseId === childToolUseId
      && message.sessionId === rootId));

    session.handleAppServerNotification("item/agentMessage/delta", {
      threadId: childId,
      itemId: "child-message-1",
      delta: "child output",
    });

    const childText = sent.find((message) =>
      message.type === "text" && message.content === "child output");
    assert.equal(childText.parentToolUseId, childToolUseId);
    assert.equal(childText.streamId, "child-message-1");

    session.handleAppServerNotification("item/completed", {
      threadId: childId,
      item: {
        id: "spawn-grandchild",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: [grandchildId],
        prompt: "Inspect nested behavior",
      },
    });

    const grandchildCall = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === grandchildToolUseId);
    assert.equal(grandchildCall.parentToolUseId, childToolUseId);
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("attaches Codex v2 subagent assignments to the live card and durable history", async () => {
  const sent = [];
  const rootId = `test-root-${crypto.randomUUID()}`;
  const childId = `test-child-${crypto.randomUUID()}`;
  const childPath = "/root/history_reviewer";
  const childToolUseId = `codex-subagent:${childId}`;
  const prompt = "Audit transcript ordering and report the exact failure boundary.";
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "spawn-child",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: childId,
        agentPath: childPath,
      },
    });

    const initialCall = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === childToolUseId);
    assert.equal(initialCall.input.prompt, "");

    const result = await handleReportSubagentAssignmentTool(
      session.createAppToolContext(),
      { agent_path: childPath, prompt },
    );
    assert.equal(result.isError, undefined);

    const calls = sent.filter((message) =>
      message.type === "tool_call" && message.toolUseId === childToolUseId);
    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1).input.prompt, prompt);

    const persistedCalls = getHistory(rootId).filter((entry) =>
      entry.role === "tool_call" && entry.toolUseId === childToolUseId);
    assert.equal(persistedCalls.length, 1);
    assert.equal(persistedCalls[0].toolInput.prompt, prompt);
    assert.equal(persistedCalls[0].content, prompt);

    const snapshot = sent.filter((message) =>
      message.type === "active_subagents").at(-1);
    assert.equal(snapshot.tasks[0].prompt, prompt);

    const visibleCount = sent.length;
    session.handleAppServerNotification("item/started", {
      threadId: childId,
      item: {
        id: "report-assignment-call",
        type: "mcpToolCall",
        server: "socketagent_app",
        tool: "ReportSubagentAssignment",
        arguments: { agent_path: childPath, prompt },
      },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: childId,
      item: {
        id: "report-assignment-call",
        type: "mcpToolCall",
        server: "socketagent_app",
        tool: "ReportSubagentAssignment",
        result: { content: [{ type: "text", text: "attached" }] },
      },
    });
    assert.equal(sent.length, visibleCount);
    assert.equal(
      getHistory(rootId).some((entry) => entry.toolName === "ReportSubagentAssignment"),
      false,
    );
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("deduplicates unchanged Codex subagent snapshots but replays one on reconnect", () => {
  const sent = [];
  const rootId = `test-root-${crypto.randomUUID()}`;
  const childId = `test-child-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "spawn-child",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: childId,
        agentPath: "/root/performance_audit",
      },
    });
    session.handleAppServerNotification("thread/status/changed", {
      threadId: childId,
      status: { type: "active" },
    });

    const snapshotsAfterStart = sent.filter(
      (message) => message.type === "active_subagents",
    ).length;

    session.handleAppServerNotification("thread/status/changed", {
      threadId: childId,
      status: { type: "active" },
    });
    session.handleAppServerNotification("turn/started", {
      threadId: childId,
      turn: { id: "child-turn-1" },
    });
    assert.equal(
      sent.filter((message) => message.type === "active_subagents").length,
      snapshotsAfterStart,
    );

    const reconnectMessages = [];
    session.replayLiveState(testSocket(reconnectMessages));
    const reconnectSnapshots = reconnectMessages.filter(
      (message) => message.type === "active_subagents",
    );
    assert.equal(reconnectSnapshots.length, 1);
    assert.equal(reconnectSnapshots[0].tasks[0].status, "running");
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("replays concurrent Claude streams with their original parents", () => {
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "claude-root";

  session._appendLiveStream(
    session._streamingText,
    { parent_tool_use_id: null, uuid: "main-message" },
    "main output",
  );
  session._appendLiveStream(
    session._streamingText,
    { parent_tool_use_id: "agent-tool-1", uuid: "child-message" },
    "child output",
  );
  session._appendLiveStream(
    session._streamingThinking,
    { parent_tool_use_id: "agent-tool-2", uuid: "thinking-message" },
    "child thinking",
  );

  session.replayLiveState();

  const mainText = sent.find((message) =>
    message.type === "text" && message.content === "main output");
  const childText = sent.find((message) =>
    message.type === "text" && message.content === "child output");
  const childThinking = sent.find((message) =>
    message.type === "thinking" && message.content === "child thinking");

  assert.equal(mainText.parentToolUseId, undefined);
  assert.equal(childText.parentToolUseId, "agent-tool-1");
  assert.equal(childText.uuid, "child-message");
  assert.equal(childThinking.parentToolUseId, "agent-tool-2");
  assert.equal(childThinking.uuid, "thinking-message");
});

test("uses Claude's current default-background Agent semantics", () => {
  assert.equal(claudeAgentRunsInBackground({}), true);
  assert.equal(claudeAgentRunsInBackground({ prompt: "inspect" }), true);
  assert.equal(
    claudeAgentRunsInBackground({ run_in_background: true }),
    true,
  );
  assert.equal(
    claudeAgentRunsInBackground({ run_in_background: false }),
    false,
  );
});

test("distinguishes SDK background follow-up results from phone turns", () => {
  assert.equal(
    isClaudeTaskNotificationResult({
      type: "result",
      origin: { kind: "task-notification" },
    }),
    true,
  );
  assert.equal(
    isClaudeTaskNotificationResult({
      type: "result",
      origin: { kind: "human" },
    }),
    false,
  );
  assert.equal(isClaudeTaskNotificationResult({ type: "result" }), false);
});

test("recognizes every structured non-terminal Agent launch result", () => {
  assert.equal(isClaudeAgentLaunchOutput({ status: "async_launched" }), true);
  assert.equal(isClaudeAgentLaunchOutput({ status: "remote_launched" }), true);
  assert.equal(isClaudeAgentLaunchOutput({ status: "completed" }), false);
  assert.equal(isClaudeAgentLaunchOutput(null), false);
});

test("keeps native Claude task state separate and durable", () => {
  const legacyTodo = {
    content: "Legacy TodoWrite item",
    status: "pending",
  };
  let todos = reduceClaudeTaskTodos([legacyTodo], {
    taskId: "17",
    subject: "Inspect parser",
    description: "Trace event attribution",
    teammateName: "researcher",
    status: "pending",
  });
  assert.equal(todos.length, 2);
  assert.deepEqual(todos[0], legacyTodo);
  assert.deepEqual(todos[1], {
    id: "17",
    taskId: "17",
    content: "Inspect parser",
    activeForm: "Inspect parser",
    status: "pending",
    source: "claude_tasks",
    description: "Trace event attribution",
    teammateName: "researcher",
  });

  todos = reduceClaudeTaskTodos(todos, {
    taskId: "17",
    status: "in_progress",
  });
  assert.equal(todos[1].status, "in_progress");
  assert.equal(todos[1].teammateName, "researcher");

  todos = replaceClaudeTaskTodos(todos, [{
    id: "17",
    subject: "Inspect parser",
    status: "completed",
    owner: "researcher",
    blockedBy: [],
  }, {
    id: "18",
    subject: "Fix history",
    status: "pending",
    blockedBy: [],
  }]);
  assert.equal(todos.length, 3);
  assert.equal(todos[0].content, "Legacy TodoWrite item");
  assert.equal(todos[1].status, "completed");
  assert.equal(todos[2].content, "Fix history");

  todos = reduceClaudeTaskTodos(todos, {
    taskId: "17",
    status: "deleted",
  });
  assert.equal(todos.some((todo) => todo.taskId === "17"), false);
  assert.equal(todos.some((todo) => todo.content === "Legacy TodoWrite item"), true);
});

test("TodoWrite replaces only its own rows and preserves every modern task source", () => {
  const current = [
    {
      content: "Old TodoWrite row",
      status: "completed",
    },
    {
      content: "Current TodoWrite row",
      status: "pending",
      source: "claude_todos",
    },
    {
      id: "native-14",
      taskId: "native-14",
      content: "Native Claude task",
      status: "in_progress",
      source: "claude_tasks",
    },
    {
      id: "sa-14",
      taskId: "sa-14",
      content: "SocketAgent batch task",
      status: "pending",
      source: "socketagent_tasks",
    },
  ];

  const replaced = replaceClaudeTodoWriteTodos(current, [{
    content: "One new TodoWrite row",
    activeForm: "Writing one new row",
    status: "in_progress",
  }]);

  assert.equal(replaced.length, 3);
  assert.equal(replaced.some((task) => task.content === "Old TodoWrite row"), false);
  assert.equal(replaced.some((task) => task.content === "Current TodoWrite row"), false);
  assert.equal(replaced.some((task) => task.content === "Native Claude task"), true);
  assert.equal(replaced.some((task) => task.content === "SocketAgent batch task"), true);
  assert.deepEqual(replaced[2], {
    content: "One new TodoWrite row",
    activeForm: "Writing one new row",
    status: "in_progress",
    source: "claude_todos",
  });
});

test("recovers pre-fix Claude task state from durable tool history", () => {
  const tasks = deriveClaudeTasksFromHistoryEntries([
    {
      role: "tool_call",
      content: "",
      toolName: "TaskCreate",
      toolUseId: "create-1",
      toolInput: {
        subject: "Trace lifecycle",
        description: "Inspect every event",
      },
      timestamp: "2026-07-25T00:00:00.000Z",
    },
    {
      role: "tool_result",
      content: "",
      toolUseId: "create-1",
      toolOutput: "Task #17 created successfully: Trace lifecycle",
      timestamp: "2026-07-25T00:00:01.000Z",
    },
    {
      role: "tool_call",
      content: "",
      toolName: "TaskUpdate",
      toolUseId: "update-1",
      toolInput: { taskId: "17", status: "in_progress" },
      timestamp: "2026-07-25T00:00:02.000Z",
    },
    {
      role: "tool_call",
      content: "",
      toolName: "TaskCreate",
      toolUseId: "create-2",
      toolInput: { subject: "Discarded task" },
      timestamp: "2026-07-25T00:00:03.000Z",
    },
    {
      role: "tool_result",
      content: "",
      toolUseId: "create-2",
      toolOutput: "Task #18 created successfully: Discarded task",
      timestamp: "2026-07-25T00:00:04.000Z",
    },
    {
      role: "tool_call",
      content: "",
      toolName: "TaskUpdate",
      toolUseId: "update-2",
      toolInput: { taskId: "18", status: "deleted" },
      timestamp: "2026-07-25T00:00:05.000Z",
    },
  ]);

  assert.deepEqual(tasks, [{
    id: "17",
    taskId: "17",
    content: "Trace lifecycle",
    activeForm: "Trace lifecycle",
    status: "in_progress",
    source: "claude_tasks",
    description: "Inspect every event",
  }]);
});

test("reduces Claude task lifecycle events by task and tool identity", () => {
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);

  session._activeSubagents.set("agent-tool-1", {
    toolUseId: "agent-tool-1",
    description: "Inspect lifecycle",
    subagentType: "general-purpose",
    startedAt: "2026-07-25T12:00:00.000Z",
    isBackgrounded: true,
    status: "running",
  });

  session._handleSdkTaskStarted({
    task_id: "agent-1",
    tool_use_id: "agent-tool-1",
    task_type: "local_agent",
    subagent_type: "general-purpose",
    description: "Inspect lifecycle",
    prompt: "Audit the task lifecycle",
  });
  session._handleSdkTaskProgress({
    task_id: "agent-1",
    tool_use_id: "agent-tool-1",
    subagent_type: "general-purpose",
    description: "Inspect lifecycle",
    summary: "Checking task events",
    last_tool_name: "Read",
    usage: {
      total_tokens: 640,
      tool_uses: 3,
      duration_ms: 12_000,
    },
  });

  const started = sent.find((message) => message.type === "task_started");
  assert.equal(started.taskId, "agent-1");
  assert.equal(started.toolUseId, "agent-tool-1");
  assert.equal(started.subagentType, "general-purpose");

  const progress = sent.find((message) => message.type === "bg_task_progress");
  assert.deepEqual(progress.usage, {
    totalTokens: 640,
    toolUses: 3,
    durationMs: 12_000,
  });
  assert.equal(progress.summary, "Checking task events");
  assert.equal(session.isBusy, true);

  session._handleSdkBackgroundTasksChanged({
    tasks: [],
  });

  const level = sent.filter(
    (message) => message.type === "background_tasks_changed",
  ).at(-1);
  assert.deepEqual(level.tasks, []);
  const active = sent.filter(
    (message) => message.type === "active_subagents",
  ).at(-1);
  assert.equal(active.tasks[0].toolUseId, "agent-tool-1");
  assert.equal(active.tasks[0].status, "completed");
  assert.equal(session.isBusy, false);
});

test("uses the stable Claude API message id across partial stream event UUIDs", () => {
  const session = new ClaudeSession(testSocket([]), process.cwd(), []);

  const started = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-1",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "api-message-1" } },
  });
  const firstDelta = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
  });
  const secondDelta = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0 },
  });
  const completed = session._streamIdentity.completedKeys({
    type: "assistant",
    uuid: "assistant-transcript-uuid",
    parent_tool_use_id: null,
    message: { id: "api-message-1", content: [{ type: "text", text: "hello" }] },
  })[0];

  assert.equal(started, "main:api-message-1");
  assert.equal(firstDelta, `${started}:block:0`);
  assert.equal(secondDelta, firstDelta);
  assert.equal(completed, firstDelta);
});

test("keeps interleaved Claude subagent message streams in separate lanes", () => {
  const session = new ClaudeSession(testSocket([]), process.cwd(), []);

  session._streamKey({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "main-api-message" } },
  });
  session._streamKey({
    type: "stream_event",
    parent_tool_use_id: "agent-tool-1",
    event: { type: "message_start", message: { id: "child-api-message" } },
  });

  assert.equal(
    session._streamKey({
      type: "stream_event",
      uuid: "new-main-frame",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0 },
    }),
    "main:main-api-message:block:0",
  );
  assert.equal(
    session._streamKey({
      type: "stream_event",
      uuid: "new-child-frame",
      parent_tool_use_id: "agent-tool-1",
      event: { type: "content_block_delta", index: 0 },
    }),
    "agent-tool-1:child-api-message:block:0",
  );
});

test("replays the active Claude tool card for a late-joining client", () => {
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "claude-tool-root";
  session._activeToolUseId = "claude-tool-1";
  session._activeToolName = "Bash";

  session.replayLiveState();

  assert.ok(sent.some((message) =>
    message.type === "tool_call"
    && message.toolUseId === "claude-tool-1"
    && message.tool === "Bash"
    && message.replay === true));
});

test("replays an active Codex tool call after reconnect and retires it on completion", () => {
  const sent = [];
  const replayed = [];
  const rootId = `test-tool-replay-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("turn/started", {
      threadId: rootId,
      turn: { id: "turn-1" },
    });
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
        cwd: "/workspace/socketagent",
        source: "agent",
        commandActions: [
          {
            type: "search",
            command: "rg -n test server",
            query: "test",
            path: "server",
          },
        ],
      },
    });

    const liveCall = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === "command-1");
    assert.equal(liveCall.input.description, "Search server for test");
    assert.equal(liveCall.input.cwd, "/workspace/socketagent");
    assert.equal(liveCall.input._codexItemType, "commandExecution");
    assert.equal(liveCall.input.commandActions[0].type, "search");

    assert.deepEqual(session.getActiveToolCall(), {
      toolUseId: "command-1",
      name: "Bash",
    });

    session.replayLiveState(testSocket(replayed));
    assert.ok(replayed.some((message) =>
      message.type === "tool_call"
      && message.toolUseId === "command-1"
      && message.tool === "Bash"
      && message.sessionId === rootId));

    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
        aggregatedOutput: "passed",
        exitCode: 0,
      },
    });

    assert.equal(session.getActiveToolCall(), null);
    replayed.length = 0;
    session.replayLiveState(testSocket(replayed));
    assert.equal(
      replayed.some((message) => message.toolUseId === "command-1"),
      false,
    );
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("idle Codex replay settles orphaned tools instead of moving them to the tail", () => {
  const sent = [];
  const replayed = [];
  const rootId = `test-idle-tool-replay-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;
  session.appServerActiveToolCalls.set("orphan-command", {
    tool: "Bash",
    input: { command: "npm test" },
  });

  try {
    session.replayLiveState(testSocket(replayed));

    assert.equal(
      replayed.some((message) =>
        message.type === "tool_call"
        && message.toolUseId === "orphan-command"),
      false,
    );
    assert.ok(sent.some((message) =>
      message.type === "tool_result"
      && message.toolUseId === "orphan-command"));
    assert.equal(session.getActiveToolCall(), null);
    assert.ok(getHistory(rootId).some((entry) =>
      entry.role === "tool_result"
      && entry.toolUseId === "orphan-command"));
  } finally {
    deleteSessionArtifacts(rootId);
  }
});

test("summarizes structured Codex command actions with a bounded command fallback", () => {
  assert.equal(
    summarizeCodexCommandActions(
      [
        { type: "read", name: "protocol.ts", path: "/repo/protocol.ts" },
        { type: "listFiles", path: "/repo/server" },
        { type: "search", query: "ThreadItem", path: "/repo/server" },
      ],
      "ignored",
    ),
    "Read protocol.ts · List files in /repo/server · +1 more",
  );
  assert.equal(
    summarizeCodexCommandActions([], "npm test && npm run build"),
    "npm test",
  );
});

test("translates every user-visible Codex item family into durable tailored cards", () => {
  const sent = [];
  const rootId = `test-codex-items-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      turnId: "turn-agent",
      item: { id: "agent-1", type: "agentMessage", text: "", phase: "commentary" },
    });
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      turnId: "turn-plan",
      item: { id: "plan-1", type: "plan", text: "" },
    });
    session.handleAppServerNotification("item/plan/delta", {
      threadId: rootId,
      turnId: "turn-plan",
      itemId: "plan-1",
      delta: "Inspect the protocol",
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      turnId: "turn-plan",
      item: { id: "plan-1", type: "plan", text: "Inspect, map, and test." },
    });

    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: { id: "sleep-1", type: "sleep", durationMs: 2500 },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: { id: "sleep-1", type: "sleep", durationMs: 2500 },
    });

    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "hook-prompt-1",
        type: "hookPrompt",
        fragments: [{ hookRunId: "hook-1", text: "Run the focused test." }],
      },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "review-1",
        type: "exitedReviewMode",
        review: "No blocking findings.",
      },
    });
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: { id: "future-1", type: "futureProtocolItem", value: 7 },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: { id: "future-1", type: "futureProtocolItem", value: 7 },
    });

    const calls = new Map(
      sent
        .filter((message) => message.type === "tool_call")
        .map((message) => [message.toolUseId, message]),
    );
    assert.equal(calls.get("sleep-1").input._codexItemType, "sleep");
    assert.equal(calls.get("hook-prompt-1").input._codexItemType, "hookPrompt");
    assert.equal(calls.get("review-1").input._codexItemType, "reviewMode");
    assert.equal(calls.get("future-1").input._codexItemType, "unrecognized");
    assert.equal(calls.has("agent-1"), false);
    assert.equal(calls.has("plan-1"), false);
    assert.ok(sent.some((message) =>
      message.type === "codex_plan"
      && message.turnId === "turn-plan"
      && message.explanation === "Inspect, map, and test."));

    const history = getHistory(rootId);
    for (const toolUseId of [
      "sleep-1",
      "hook-prompt-1",
      "review-1",
      "future-1",
    ]) {
      assert.ok(history.some((entry) =>
        entry.role === "tool_call" && entry.toolUseId === toolUseId));
      assert.ok(history.some((entry) =>
        entry.role === "tool_result" && entry.toolUseId === toolUseId));
    }
    assert.ok(history.some((entry) =>
      entry.role === "codex_plan" && entry.toolUseId === "turn-plan"));
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("filters the 1.0.198 known-item diagnostics without hiding future items", () => {
  const normalized = normalizeMisclassifiedCodexItemEntries([
    {
      role: "tool_call",
      toolName: "CodexItem",
      toolUseId: "agent-1",
      toolInput: {
        _codexItemType: "unrecognized",
        itemType: "agentMessage",
      },
    },
    {
      role: "tool_result",
      toolUseId: "agent-1",
      toolOutput: "unexpected",
    },
    {
      role: "tool_call",
      toolName: "CodexItem",
      toolUseId: "future-1",
      toolInput: {
        _codexItemType: "unrecognized",
        itemType: "futureProtocolItem",
      },
    },
  ]);

  assert.equal(normalized.some((entry) => entry.toolUseId === "agent-1"), false);
  assert.equal(normalized.some((entry) => entry.toolUseId === "future-1"), true);
});

test("keeps SocketAgent app tools on their native card path", () => {
  const sent = [];
  const rootId = `test-codex-native-tool-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "send-file-1",
        type: "mcpToolCall",
        server: "socketagent_app",
        tool: "SendFile",
        arguments: { file_path: "/tmp/app.apk" },
      },
    });

    const call = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === "send-file-1");
    assert.equal(call.tool, "SendFile");
    assert.deepEqual(call.input, { file_path: "/tmp/app.apk" });

    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "notify-1",
        type: "mcpToolCall",
        server: "socketagent_app",
        tool: "NotifyUser",
        arguments: { title: "Alert", body: "Details" },
      },
    });
    assert.equal(sent.some((message) => message.toolUseId === "notify-1"), false);

    const repaired = normalizeSocketAgentAppToolEntries([
      {
        role: "tool_call",
        toolName: "SendFile",
        toolUseId: "legacy-send",
        toolInput: {
          file_path: "/tmp/app.apk",
          _codexItemType: "mcpToolCall",
          _codexServer: "socketagent_app",
          _codexTool: "SendFile",
        },
      },
      {
        role: "tool_call",
        toolName: "NotifyUser",
        toolUseId: "legacy-notify",
        toolInput: { title: "Alert", body: "Details" },
      },
      {
        role: "tool_result",
        toolUseId: "legacy-notify",
        toolOutput: "Notification sent",
      },
      {
        role: "notification",
        status: "manual",
        content: "Alert\nDetails",
      },
    ]);
    assert.deepEqual(repaired[0].toolInput, { file_path: "/tmp/app.apk" });
    assert.equal(repaired.some((entry) => entry.toolUseId === "legacy-notify"), false);
    assert.equal(repaired.some((entry) => entry.role === "notification"), true);
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("preserves structured Codex web results for the tailored search card", () => {
  const sent = [];
  const rootId = `test-codex-web-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "web-1",
        type: "webSearch",
        query: "Codex app-server",
        action: { type: "search", query: "Codex app-server" },
      },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "web-1",
        type: "webSearch",
        query: "Codex app-server",
        results: [
          {
            title: "Codex App Server",
            url: "https://developers.openai.com/codex/app-server",
            snippet: "Build rich Codex clients.",
          },
        ],
      },
    });

    const call = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === "web-1");
    const result = sent.find((message) =>
      message.type === "tool_result" && message.toolUseId === "web-1");
    assert.equal(call.input._codexItemType, "webSearch");
    assert.deepEqual(JSON.parse(result.output)[0], {
      title: "Codex App Server",
      url: "https://developers.openai.com/codex/app-server",
      snippet: "Build rich Codex clients.",
    });
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("preserves Codex reroutes, reasoning sections, and structured warnings", () => {
  const sent = [];
  const rootId = `test-codex-metadata-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/reasoning/summaryTextDelta", {
      threadId: rootId,
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "First section.",
    });
    session.handleAppServerNotification("item/reasoning/summaryPartAdded", {
      threadId: rootId,
      itemId: "reasoning-1",
      summaryIndex: 1,
    });
    session.handleAppServerNotification("item/reasoning/summaryTextDelta", {
      threadId: rootId,
      itemId: "reasoning-1",
      summaryIndex: 1,
      delta: "Second section.",
    });
    session.handleAppServerNotification("model/rerouted", {
      threadId: rootId,
      turnId: "turn-1",
      fromModel: "gpt-5.6-codex",
      toModel: "gpt-5.6",
      reason: "highRiskCyberActivity",
    });
    session.handleAppServerNotification("configWarning", {
      summary: "Invalid config option",
      details: "Remove the obsolete setting.",
      path: "/tmp/config.toml",
    });

    const thinking = sent.filter((message) =>
      message.type === "thinking" && message.streamId === "reasoning-1").at(-1);
    assert.equal(thinking.content, "First section.\n\nSecond section.");

    const reroute = sent.find((message) =>
      message.type === "tool_call"
      && message.toolUseId === "codex-reroute:turn-1");
    assert.equal(reroute.input._codexItemType, "modelRerouted");
    assert.equal(reroute.input.reason, "highRiskCyberActivity");
    assert.ok(getHistory(rootId).some((entry) =>
      entry.role === "tool_call"
      && entry.toolUseId === "codex-reroute:turn-1"));

    const warning = sent.find((message) =>
      message.type === "error"
      && message.message.includes("Invalid config option"));
    assert.match(warning.message, /Remove the obsolete setting/);
    assert.match(warning.message, /Config: \/tmp\/config\.toml/);
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("renders dynamic exec results as readable output instead of content-item JSON", () => {
  const sent = [];
  const rootId = `test-dynamic-exec-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "dynamic-exec-1",
        type: "dynamicToolCall",
        tool: "exec",
        arguments: { task: "inspect changes" },
      },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "dynamic-exec-1",
        type: "dynamicToolCall",
        tool: "exec",
        success: true,
        contentItems: [
          {
            type: "input_text",
            text: "Script completed\nWall time 0.4 seconds\nOutput:\n",
          },
          {
            type: "input_text",
            text: JSON.stringify({
              chunk_id: "77b278",
              wall_time_seconds: 0.4,
              exit_code: 0,
              output: "15 files changed, 291 insertions(+), 75 deletions(-)",
            }),
          },
        ],
      },
    });

    const call = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === "dynamic-exec-1");
    const result = sent.find((message) =>
      message.type === "tool_result" && message.toolUseId === "dynamic-exec-1");
    assert.equal(call.tool, "Exec");
    assert.equal(
      result.output,
      "Script completed\nWall time 0.4 seconds\nOutput:\n15 files changed, 291 insertions(+), 75 deletions(-)",
    );
    assert.equal(result.output.includes('"type": "input_text"'), false);
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("late-joining Codex clients receive the complete cached prefix before new deltas", () => {
  const initial = [];
  const replayed = [];
  const rootId = `test-text-replay-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(initial), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "first half, ",
  });
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "second half",
  });

  session.replayLiveState(testSocket(replayed));

  const snapshot = replayed.find((message) =>
    message.type === "text" && message.streamId === "message-1");
  assert.equal(snapshot.content, "first half, second half");
  assert.equal(snapshot.replay, true);
  assert.equal(snapshot.sessionId, rootId);
});

test("Codex live text frames are cumulative snapshots with a durable final frame", async () => {
  const sent = [];
  const rootId = `test-text-snapshot-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "first ",
  });
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "second",
  });
  session.handleAppServerNotification("item/completed", {
    threadId: rootId,
    item: {
      type: "agentMessage",
      id: "message-1",
      text: "first second",
    },
  });

  const frames = sent.filter((message) => message.type === "text");
  assert.deepEqual(frames.map((message) => message.content), [
    "first ",
    "first second",
  ]);
  assert.ok(frames.every((message) => message.streamId === "message-1"));
  assert.ok(frames.every((message) => message.snapshot === true));
  assert.equal(frames.at(-1).finalSnapshot, true);
  assert.equal(session.lastPreview, "first second");

  session.handleAppServerNotification("turn/completed", {
    threadId: rootId,
  });
  await new Promise((resolve) => setTimeout(resolve, 550));
  const result = sent.find((message) => message.type === "result");
  assert.equal(result.content, "first second");
});

test("Codex immediate goal continuation preserves one running lifecycle", async () => {
  const sent = [];
  const rootId = `test-goal-continuation-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;
  session._isRunning = true;
  let settled = 0;
  session.appServerTurnSettler = {
    resolve: () => { settled += 1; },
    reject: () => {},
  };

  session.handleAppServerNotification("turn/completed", {
    threadId: rootId,
    turn: { id: "turn-1" },
  });
  assert.equal(session.isBusy, true);
  assert.equal(session.isRunning, true);
  assert.equal(sent.some((message) => message.type === "result"), false);
  session.handleAppServerNotification("thread/status/changed", {
    threadId: rootId,
    status: { type: "idle" },
  });
  assert.equal(sent.some((message) =>
    message.type === "session_state_changed" && message.state === "idle"), false);

  await new Promise((resolve) => setTimeout(resolve, 50));
  session.handleAppServerNotification("turn/started", {
    threadId: rootId,
    turn: { id: "turn-2" },
  });
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(session.isBusy, true);
  assert.equal(session.isRunning, true);
  assert.equal(settled, 0);
  assert.equal(sent.some((message) => message.type === "result"), false);
  assert.ok(sent.some((message) =>
    message.type === "session_state_changed"
    && message.state === "running"
    && message.sessionId === rootId));

  session.handleAppServerNotification("turn/completed", {
    threadId: rootId,
    turn: { id: "turn-2" },
  });
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(settled, 1);
  assert.equal(session.isBusy, false);
  assert.equal(session.isRunning, false);
  assert.equal(sent.filter((message) => message.type === "result").length, 1);
});

test("Codex injection retries immediately with the authoritative active turn id", async () => {
  const sent = [];
  const rootId = `test-steer-recovery-${crypto.randomUUID()}`;
  const staleTurnId = "019fce7c-abc4-7c81-b004-9d0888edb621";
  const activeTurnId = "38a59137-3940-4f02-a974-79d121dd6e7e";
  const attemptedTurnIds = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;
  session._isRunning = true;
  session.activeAppServerTurnId = staleTurnId;
  session.appServerInitialized = true;
  session.appServer = {
    async steerTurn({ expectedTurnId }) {
      attemptedTurnIds.push(expectedTurnId);
      if (expectedTurnId === staleTurnId) {
        throw new Error(
          `turn/steer: {"code":-32600,"message":"expected active turn id \`${staleTurnId}\` but found \`${activeTurnId}\`"}`,
        );
      }
      return {};
    },
  };

  try {
    await session.injectMessage("Use the newly supplied context", "next", "message-1");
    assert.deepEqual(attemptedTurnIds, [staleTurnId, activeTurnId]);
    assert.equal(session.activeAppServerTurnId, activeTurnId);
    assert.equal(session._pendingAppServerSteers.length, 0);
    assert.equal(session._queuedPrompts.length, 0);
    assert.ok(sent.some((message) =>
      message.type === "user_message_uuid"
      && message.clientMessageId === "message-1"
      && message.sessionId === rootId));
  } finally {
    session.appServer = null;
    deleteSessionArtifacts(rootId);
  }
});
