const assert = require("node:assert/strict");
const test = require("node:test");

const { handleSpeakTool } = require("../dist/app-tool-handlers");
const { normalizeSpeakHistoryEntries } = require("../dist/session-store");

test("collapses the handler-generated Speak pair into the canonical pair", () => {
  const normalized = normalizeSpeakHistoryEntries([
    {
      role: "tool_call",
      toolName: "Speak",
      toolUseId: "exec-1",
      toolInput: { text: "The fix is ready." },
      timestamp: "2026-08-22T20:00:00.000Z",
    },
    {
      role: "tool_call",
      toolName: "Speak",
      toolUseId: "mcp_Speak_duplicate",
      toolInput: { text: "The fix is ready." },
      timestamp: "2026-08-22T20:00:00.010Z",
    },
    {
      role: "tool_result",
      toolUseId: "mcp_Speak_duplicate",
      toolOutput: "Speaking to user.",
    },
    {
      role: "tool_result",
      toolUseId: "exec-1",
      toolOutput: "Speaking to user.",
    },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].toolUseId, "exec-1");
  assert.equal(normalized[1].toolUseId, "exec-1");
});

test("preserves later Speak calls with the same text", () => {
  const normalized = normalizeSpeakHistoryEntries([
    {
      role: "tool_call",
      toolName: "Speak",
      toolUseId: "exec-1",
      toolInput: { text: "Done." },
      timestamp: "2026-08-22T20:00:00.000Z",
    },
    {
      role: "tool_call",
      toolName: "Speak",
      toolUseId: "exec-2",
      toolInput: { text: "Done." },
      timestamp: "2026-08-22T20:01:00.000Z",
    },
  ]);

  assert.equal(normalized.length, 2);
});

test("Speak emits audio delivery without writing synthetic history", async () => {
  const packets = [];
  const history = [];
  const result = await handleSpeakTool({
    getSessionId: () => "session-1",
    send: (message) => packets.push(message),
    appendHistory: (entry) => history.push(entry),
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
  }, { text: "One card only." });

  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, "speak");
  assert.equal(history.length, 0);
  assert.equal(result.content[0].text, "Speaking to user.");
});
