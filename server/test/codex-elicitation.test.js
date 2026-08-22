const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
require("./test-data-dir");

const {
  prepareCodexMcpElicitation,
  resolveCodexMcpElicitation,
} = require("../dist/codex-elicitation");
const { CodexSession } = require("../dist/codex-session");
const {
  deleteSession,
  deleteSessionArtifacts,
  getSession,
  saveSession,
} = require("../dist/session-store");

test("maps current Codex form elicitations to typed MCP content", () => {
  const prepared = prepareCodexMcpElicitation({
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "codex_apps",
    mode: "form",
    message: "Send this Gmail message?",
    requestedSchema: {
      type: "object",
      properties: {
        confirmation: {
          type: "string",
          title: "Confirmation",
          description: "Choose whether to send the message.",
          oneOf: [
            { const: "send", title: "Send" },
            { const: "cancel", title: "Cancel" },
          ],
        },
        notify: { type: "boolean", title: "Notify recipient" },
      },
      required: ["confirmation"],
    },
  });

  assert.equal(prepared.serverName, "codex_apps");
  assert.equal(prepared.questions.length, 2);
  assert.deepEqual(prepared.questions[0].options.map((option) => option.label), ["Send", "Cancel"]);

  const response = resolveCodexMcpElicitation(prepared, {
    [prepared.questions[0].question]: "Send",
    [prepared.questions[1].question]: "Yes",
  });
  assert.deepEqual(response, {
    action: "accept",
    content: { confirmation: "send", notify: true },
    _meta: null,
  });
});

test("supports legacy nested elicitation payloads", () => {
  const prepared = prepareCodexMcpElicitation({
    serverName: "legacy-mcp",
    request: {
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Authenticate",
        url: "https://example.com/auth",
        elicitationId: "elicit-1",
      },
    },
  });
  assert.equal(prepared.mode, "url");
  assert.equal(prepared.url, "https://example.com/auth");
  assert.equal(prepared.elicitationId, "elicit-1");
});

test("uses an explicit approval question when an openai form has no properties", () => {
  const prepared = prepareCodexMcpElicitation({
    serverName: "codex_apps",
    mode: "openai/form",
    message: "Allow Gmail to send this draft?",
    requestedSchema: {},
  });
  assert.equal(prepared.fallbackApproval, true);
  assert.deepEqual(prepared.questions[0].options.map((option) => option.label), ["Approve", "Decline"]);
  assert.equal(resolveCodexMcpElicitation(prepared, {
    [prepared.questions[0].question]: "Approve",
  }).action, "accept");
  assert.equal(resolveCodexMcpElicitation(prepared, {
    [prepared.questions[0].question]: "Decline",
  }).action, "decline");
});

test("holds an app-server elicitation until the routed SocketAgent answer arrives", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  let response;
  const pending = session.handleMcpServerElicitation({
    threadId: "",
    turnId: "turn-1",
    serverName: "codex_apps",
    mode: "openai/form",
    message: "Allow Gmail to send this draft?",
    requestedSchema: {},
    _meta: { codex_approval_kind: "mcp_tool_call" },
  }, (value) => {
    response = value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  const question = sent.find((message) => message.type === "question");
  assert.ok(question, "approval question was sent to the app");
  assert.equal(question.sessionId, "");
  assert.equal(session.isBusy, true);
  assert.equal(session.resolveQuestion(question.questionId, {
    [question.questions[0].question]: "Approve",
  }), true);

  await pending;
  assert.deepEqual(response, {
    result: { action: "accept", content: {}, _meta: null },
  });
  assert.equal(session.isBusy, false);
  assert.equal(session.resolveQuestion(question.questionId, {}), false);
});

test("routes native Codex request_user_input questions and restores question ids", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  let response;
  const pending = session.handleAppServerRequest({
    method: "item/tool/requestUserInput",
    params: {
      threadId: "",
      turnId: "turn-1",
      itemId: "item-1",
      autoResolutionMs: null,
      questions: [{
        id: "delivery",
        header: "Delivery",
        question: "How should I deliver it?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Attach", description: "Attach it here." },
          { label: "Link", description: "Send a link." },
        ],
      }],
    },
  }, (value) => {
    response = value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  const question = sent.find((message) => message.type === "question");
  assert.ok(question);
  assert.equal(session.resolveQuestion(question.questionId, {
    "How should I deliver it?": "Attach",
  }), true);
  await pending;
  assert.deepEqual(response, {
    result: { answers: { delivery: { answers: ["Attach"] } } },
  });
});

function githubApprovalRequest() {
  return {
    method: "item/tool/requestUserInput",
    params: {
      threadId: "",
      turnId: "turn-1",
      itemId: "item-github",
      questions: [{
        id: "approval",
        header: "Approval",
        question: 'Allow GitHub to run tool "github.merge_pull_request"?',
        isSecret: false,
        options: [{ label: "Approve" }, { label: "Decline" }],
      }],
    },
  };
}

test("offers and remembers connected-app approval for the SocketAgent session", async () => {
  const sessionId = `test-connected-app-${crypto.randomUUID()}`;
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  saveSession({
    id: sessionId,
    title: "Connected app approval",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "codex",
  });
  try {
  let firstResponse;
  const first = session.handleAppServerRequest(githubApprovalRequest(), (value) => {
    firstResponse = value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const question = sent.find((message) => message.type === "question");
  assert.ok(question);
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["Approve", "Decline", "Allow GitHub for this session"],
  );
  // Attach the durable session after rendering so this unit test does not
  // dispatch a real attention push through the configured relay.
  session._resumeSessionId = sessionId;
  session.resolveQuestion(question.questionId, {
    [question.questions[0].question]: "Allow GitHub for this session",
  });
  await first;
  assert.deepEqual(firstResponse, {
    result: { answers: { approval: { answers: ["Approve"] } } },
  });
  assert.deepEqual(getSession(sessionId).agentSettings.connectedAppApprovals, ["github"]);

  let secondResponse;
  const questionCount = sent.filter((message) => message.type === "question").length;
  const resumed = new CodexSession(socket, process.cwd(), []);
  resumed._resumeSessionId = sessionId;
  await resumed.handleAppServerRequest(githubApprovalRequest(), (value) => {
    secondResponse = value;
  });
  assert.deepEqual(secondResponse, {
    result: { answers: { approval: { answers: ["Approve"] } } },
  });
  assert.equal(sent.filter((message) => message.type === "question").length, questionCount);
  } finally {
    deleteSessionArtifacts(sessionId, getSession(sessionId));
    deleteSession(sessionId);
  }
});

test("Super Yolo auto-accepts GitHub connected-app confirmations", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  await session.setPermissionMode("superYolo", { recordHistory: false });
  let response;
  await session.handleAppServerRequest(githubApprovalRequest(), (value) => {
    response = value;
  });
  assert.deepEqual(response, {
    result: { answers: { approval: { answers: ["Approve"] } } },
  });
  assert.equal(sent.some((message) => message.type === "question"), false);
});

test("switching to Super Yolo accepts an already pending GitHub confirmation", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  let response;
  const pending = session.handleAppServerRequest(githubApprovalRequest(), (value) => {
    response = value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.find((message) => message.type === "question"));
  await session.setPermissionMode("superYolo", { recordHistory: false });
  await pending;
  assert.deepEqual(response, {
    result: { answers: { approval: { answers: ["Approve"] } } },
  });
  assert.ok(sent.find((message) => message.type === "question_answered"));
});

test("Super Yolo also auto-accepts GitHub MCP elicitation confirmations", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const session = new CodexSession(socket, process.cwd(), []);
  await session.setPermissionMode("superYolo", { recordHistory: false });
  let response;
  await session.handleMcpServerElicitation({
    threadId: "",
    turnId: "turn-github",
    serverName: "codex_apps",
    mode: "openai/form",
    message: 'Allow GitHub to run tool "github.merge_pull_request"?',
    requestedSchema: {},
  }, (value) => {
    response = value;
  });
  assert.deepEqual(response, {
    result: { action: "accept", content: {}, _meta: null },
  });
  assert.equal(sent.some((message) => message.type === "question"), false);
});
