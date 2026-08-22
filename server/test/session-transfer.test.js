const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-transfer-"));
process.env.HOME = testHome;
process.env.SOCKET_AGENT_DATA_DIR = path.join(testHome, "data");

const {
  clearSessionPendingHandoffContext,
  deleteSessionArtifacts,
  getHistory,
  getJsonlPath,
  getSdkEvents,
  getSession,
  getTodos,
  remapSession,
  replaceHistory,
  saveSession,
  saveTodos,
  appendSdkEvent,
} = require("../dist/session-store");
const {
  deleteHtmlPlansForSession,
  listHtmlPlanRevisions,
  listHtmlPlans,
  saveHtmlPlan,
} = require("../dist/html-plan-store");
const {
  exportSessionTransfer,
  importSessionTransfer,
} = require("../dist/session-transfer");

test.after(() => fs.rmSync(testHome, { recursive: true, force: true }));

function makeSession(id, backend, cwd, title = "Transfer test") {
  const now = "2026-07-26T12:00:00.000Z";
  return {
    id,
    title,
    cwd,
    createdAt: now,
    lastActive: now,
    messagePreview: "Latest message",
    turnCount: 2,
    running: false,
    backend,
    agentSettings: {
      model: backend === "claude" ? "claude-opus-5" : "gpt-5.6",
      permissionMode: "bypassPermissions",
    },
  };
}

function sampleHistory() {
  return [
    {
      role: "user",
      content: "Continue the migration.",
      timestamp: "2026-07-26T12:00:00.000Z",
    },
    {
      role: "assistant",
      content: "The first stage is complete.",
      timestamp: "2026-07-26T12:01:00.000Z",
    },
  ];
}

test("moves a Claude session with its native thread and durable artifacts", async () => {
  const sessionId = crypto.randomUUID();
  const sourceCwd = path.join(testHome, "source-project");
  const targetCwd = path.join(testHome, "target-project");
  fs.mkdirSync(sourceCwd, { recursive: true });
  fs.mkdirSync(targetCwd, { recursive: true });
  const session = makeSession(sessionId, "claude", sourceCwd);
  saveSession(session);
  replaceHistory(sessionId, sampleHistory());
  saveTodos(sessionId, [{ subject: "Verify production", status: "pending" }]);
  appendSdkEvent(sessionId, {
    ts: "2026-07-26T12:00:30.000Z",
    sdkType: "thinking",
    durationMs: 1234,
  });
  const plan = saveHtmlPlan({
    sessionId,
    title: "Migration plan",
    html: "<h1>Move</h1><p>Original</p>",
  });
  saveHtmlPlan({
    sessionId,
    planId: plan.planId,
    title: "Migration plan",
    html: "<h1>Move</h1><p>Revised</p>",
  });
  const sourceNativePath = getJsonlPath(sessionId, sourceCwd);
  fs.mkdirSync(path.dirname(sourceNativePath), { recursive: true });
  fs.writeFileSync(
    sourceNativePath,
    `${JSON.stringify({ type: "user", message: { content: "Native prompt" } })}\n`,
  );

  const exported = await exportSessionTransfer(sessionId);
  assert.equal(exported.exactNativeAvailable, true);
  assert.equal(fs.existsSync(exported.bundlePath), true);

  deleteSessionArtifacts(sessionId, session);
  deleteHtmlPlansForSession(sessionId);
  const imported = await importSessionTransfer({
    bundlePath: exported.bundlePath,
    expectedSha256: exported.sha256,
    targetCwd,
    targetBackend: "claude",
    mode: "move",
    nativeMode: "exact",
  });

  try {
    assert.equal(imported.exactNativeResume, true);
    assert.equal(imported.session.id, sessionId);
    assert.equal(imported.session.cwd, targetCwd);
    assert.deepEqual(
      getHistory(sessionId).map((entry) => [entry.role, entry.content]),
      sampleHistory().map((entry) => [entry.role, entry.content]),
    );
    assert.deepEqual(getTodos(sessionId), [
      { subject: "Verify production", status: "pending" },
    ]);
    assert.deepEqual(
      getSdkEvents(sessionId).map((event) => event.sdkType),
      ["thinking"],
    );
    assert.equal(listHtmlPlans(sessionId).length, 1);
    assert.equal(listHtmlPlanRevisions(sessionId, plan.planId).length, 2);
    assert.match(
      fs.readFileSync(getJsonlPath(sessionId, targetCwd), "utf8"),
      /Native prompt/,
    );
    assert.equal(fs.existsSync(exported.bundlePath), false);
  } finally {
    deleteSessionArtifacts(sessionId, imported.session);
    deleteHtmlPlansForSession(sessionId);
  }
});

test("cross-harness clone keeps history and remaps it to the first native thread", async () => {
  const sourceId = crypto.randomUUID();
  const sourceCwd = path.join(testHome, "codex-source");
  const targetCwd = path.join(testHome, "claude-target");
  fs.mkdirSync(sourceCwd, { recursive: true });
  fs.mkdirSync(targetCwd, { recursive: true });
  const source = makeSession(sourceId, "codex", sourceCwd, "Cross harness");
  saveSession(source);
  replaceHistory(sourceId, sampleHistory());
  saveTodos(sourceId, [{ subject: "Finish handoff", status: "in_progress" }]);
  appendSdkEvent(sourceId, {
    ts: "2026-07-26T12:00:30.000Z",
    sdkType: "reasoning",
  });
  const plan = saveHtmlPlan({
    sessionId: sourceId,
    title: "Handoff plan",
    html: "<h1>Handoff</h1>",
  });

  const exported = await exportSessionTransfer(sourceId);
  const imported = await importSessionTransfer({
    bundlePath: exported.bundlePath,
    expectedSha256: exported.sha256,
    targetCwd,
    targetBackend: "claude",
    mode: "clone",
    nativeMode: "handoff",
  });
  const placeholderId = imported.session.id;
  const nativeId = crypto.randomUUID();

  try {
    assert.notEqual(placeholderId, sourceId);
    assert.equal(imported.exactNativeResume, false);
    assert.match(imported.session.title, /\(clone\)$/);
    assert.equal(imported.session.backend, "claude");
    assert.ok(imported.session.contextClearedAt);
    assert.match(imported.session.pendingHandoffContext, /Recent transcript/);
    assert.match(imported.session.pendingHandoffContext, /Finish handoff/);
    assert.equal(imported.session.agentSettings.model, undefined);
    assert.equal(listHtmlPlans(placeholderId)[0].planId, plan.planId);

    remapSession(placeholderId, nativeId);
    assert.equal(getSession(placeholderId), undefined);
    assert.match(getSession(nativeId).pendingHandoffContext, /Recent transcript/);
    assert.deepEqual(getSession(nativeId).replacedSessionIds, [placeholderId]);
    assert.deepEqual(
      getHistory(nativeId).map((entry) => [entry.role, entry.content]),
      sampleHistory().map((entry) => [entry.role, entry.content]),
    );
    assert.deepEqual(getTodos(nativeId), [
      { subject: "Finish handoff", status: "in_progress" },
    ]);
    assert.deepEqual(
      getSdkEvents(nativeId).map((event) => event.sdkType),
      ["reasoning"],
    );
    assert.equal(listHtmlPlans(nativeId)[0].planId, plan.planId);
    clearSessionPendingHandoffContext(nativeId);
    assert.equal(getSession(nativeId).pendingHandoffContext, undefined);
  } finally {
    deleteSessionArtifacts(sourceId, source);
    deleteHtmlPlansForSession(sourceId);
    deleteSessionArtifacts(nativeId, getSession(nativeId));
    deleteHtmlPlansForSession(nativeId);
    deleteSessionArtifacts(placeholderId, getSession(placeholderId));
    deleteHtmlPlansForSession(placeholderId);
  }
});

test("session remap preserves cached images and large tool output", () => {
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  const cwd = path.join(testHome, "artifact-remap");
  const imageDir = path.join(
    process.env.SOCKET_AGENT_DATA_DIR,
    "tool-images",
    oldId,
  );
  const imagePath = path.join(imageDir, "result.png");
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(imagePath, "image-data");
  saveSession(makeSession(oldId, "codex", cwd));
  const fullOutput = "tool output ".repeat(2_000);
  replaceHistory(oldId, [
    {
      role: "tool_result",
      toolUseId: "tool-1",
      content: fullOutput,
      toolOutput: fullOutput,
      filePath: imagePath,
      timestamp: "2026-07-26T12:01:00.000Z",
    },
  ]);

  try {
    remapSession(oldId, newId);
    const [entry] = getHistory(newId);
    assert.equal(entry.toolOutput, fullOutput);
    assert.equal(entry.filePath, path.join(
      process.env.SOCKET_AGENT_DATA_DIR,
      "tool-images",
      newId,
      "result.png",
    ));
    assert.equal(fs.readFileSync(entry.filePath, "utf8"), "image-data");
  } finally {
    deleteSessionArtifacts(newId, getSession(newId));
    deleteSessionArtifacts(oldId, getSession(oldId));
  }
});
