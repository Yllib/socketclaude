const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./test-data-dir");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-send-file-data-"));
process.env.SOCKET_AGENT_DATA_DIR = testDataDir;

const {
  appendHistory,
  deleteSessionArtifacts,
  getHistory,
  normalizeSendFileHistoryEntries,
} = require("../dist/session-store");
const { handleSendFileTool } = require("../dist/app-tool-handlers");

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("collapses the handler-generated SendFile pair into the canonical pair", () => {
  const normalized = normalizeSendFileHistoryEntries([
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-1",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:00:00.000Z",
    },
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "mcp_SendFile_duplicate",
      toolInput: { file_path: "/tmp/app.apk" },
      fileId: "file-1",
      fileName: "app.apk",
      fileSize: 42,
      timestamp: "2026-07-15T12:00:00.010Z",
    },
    {
      role: "tool_result",
      toolUseId: "mcp_SendFile_duplicate",
      toolOutput: "ready",
    },
    { role: "tool_result", toolUseId: "exec-1", toolOutput: "ready" },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].toolUseId, "exec-1");
  assert.equal(normalized[0].fileId, "file-1");
  assert.equal(normalized[1].toolUseId, "exec-1");
});

test("does not collapse distinct later sends of the same file", () => {
  const normalized = normalizeSendFileHistoryEntries([
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-1",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:00:00.000Z",
    },
    { role: "assistant", content: "later" },
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-2",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:01:00.000Z",
    },
  ]);

  assert.equal(normalized.filter((entry) => entry.role === "tool_call").length, 2);
});

test("repeated sends of an unchanged path receive independent durable delivery IDs", async () => {
  const sessionId = `test-send-file-${randomUUID()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-send-file-"));
  const filePath = path.join(dir, "same-name.txt");
  fs.writeFileSync(filePath, "unchanged content");
  const packets = [];
  const ctx = {
    getSessionId: () => sessionId,
    send: (message) => packets.push(message),
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
  };

  try {
    const firstCall = appendHistory(sessionId, {
      role: "tool_call",
      content: "",
      toolName: "SendFile",
      toolInput: { file_path: filePath },
      toolUseId: "send-call-1",
      timestamp: new Date().toISOString(),
    });
    await handleSendFileTool(ctx, { file_path: filePath });

    // Backend/native history may revise the canonical tool row after the app
    // handler attaches transport metadata. That later revision must not erase
    // the immutable delivery path.
    appendHistory(sessionId, {
      role: "tool_call",
      content: "",
      toolName: "SendFile",
      toolInput: { file_path: filePath },
      toolUseId: "send-call-1",
      timestamp: firstCall.timestamp,
      entryId: firstCall.entryId,
      sessionSeq: firstCall.sessionSeq,
    });

    appendHistory(sessionId, {
      role: "tool_call",
      content: "",
      toolName: "SendFile",
      toolInput: { file_path: filePath },
      toolUseId: "send-call-2",
      timestamp: new Date().toISOString(),
    });
    await handleSendFileTool(ctx, { file_path: filePath });

    assert.equal(packets.length, 2);
    assert.notEqual(packets[0].fileId, packets[1].fileId);
    assert.ok(packets[0].fileVersion);
    assert.ok(packets[1].fileVersion);
    assert.equal(packets[0].filePath, filePath);
    assert.notEqual(packets[0].downloadPath, filePath);
    assert.equal(fs.readFileSync(packets[0].downloadPath, "utf8"), "unchanged content");

    fs.writeFileSync(filePath, "replacement content");
    assert.equal(
      fs.readFileSync(packets[0].downloadPath, "utf8"),
      "unchanged content",
      "a sent delivery must not change when its source path is overwritten",
    );

    const calls = getHistory(sessionId).filter(
      (entry) => entry.role === "tool_call" && entry.toolName === "SendFile",
    );
    assert.deepEqual(
      calls.map((entry) => entry.fileId),
      packets.map((packet) => packet.fileId),
    );
    assert.equal(calls[0].fileVersion, packets[0].fileVersion);
    assert.equal(calls[1].fileVersion, packets[1].fileVersion);
    assert.equal(calls[0].fileDeliveryPath, packets[0].downloadPath);
    assert.equal(calls[1].fileDeliveryPath, packets[1].downloadPath);

    deleteSessionArtifacts(sessionId);
    assert.equal(fs.existsSync(packets[0].downloadPath), false);
    assert.equal(fs.existsSync(packets[1].downloadPath), false);
  } finally {
    deleteSessionArtifacts(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
