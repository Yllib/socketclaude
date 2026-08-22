const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGENT_SESSION_TOOL_DESCRIPTION,
  buildSocketAgentIntegrationInstructions,
} = require("../dist/socketagent-instructions");
const { normalizeSystemPrompt } = require("../dist/server-settings");

test("AgentSession prefers SocketAgent delegation over built-in subagent tools", () => {
  assert.match(
    AGENT_SESSION_TOOL_DESCRIPTION,
    /^Start or manage a full independent Claude\/Codex SocketAgent session\. Prefer this over your own built-in subagent tool if one exists\./,
  );
});

test("builds compact SocketAgent routing instructions without losing safety rules", () => {
  const prompt = buildSocketAgentIntegrationInstructions({
    mcpServerName: "socketagent_app",
    toolNames: ["HtmlPlan", "SendFile", "RequestSecureInput", "TaskBatch", "Remember", "SessionMemory"],
    secureInventory: "<secret_inventory>\n[]\n</secret_inventory>",
    discoverMissingTools: true,
  });

  assert.match(prompt, /MCP server: socketagent_app/);
  assert.match(prompt, /Use HtmlPlan only when the user explicitly asks/);
  assert.match(prompt, /Never invoke it merely because a task is large/);
  assert.match(prompt, /Use your native plan\/task tool or normal chat for all other planning/);
  assert.match(prompt, /preserves and displays it exactly/);
  assert.match(prompt, /Inline assets and HTTPS resources are supported/);
  assert.match(prompt, /JavaScript is not executed by the viewer/);
  assert.match(prompt, /Never request secrets in normal chat/);
  assert.match(prompt, /absolute file_path/);
  assert.match(prompt, /discover tools for socketagent_app/);
  assert.match(prompt, /Independent delegated work.*AgentSession/);
  assert.match(prompt, /Two or more working-task mutations -> TaskBatch/);
  assert.match(prompt, /instead of looping single-task tools/);
  assert.match(prompt, /TaskBatch preserves native Claude tasks/);
  assert.match(prompt, /automatically continues the supervising session with its result/);
  assert.match(prompt, /even if your current turn has already ended/);
  assert.match(prompt, /do not need to keep the turn open, poll status, or repeatedly call tail/);
  assert.match(prompt, /action=tail with its next_session_seq cursor only when you actually need interim progress/);
  assert.match(prompt, /Messages sent to a running child are injected at its next safe boundary/);
  assert.match(prompt, /Prior session context may have been compacted.*Remember/);
  assert.match(prompt, /Search first, then retrieve only the relevant entry or surrounding context/);
  assert.match(prompt, /Confirmed facts that must survive a native context rollover -> SessionMemory/);
  assert.match(prompt, /instead of accumulating a second transcript/);
  assert.match(prompt, /socketagent:\/\/file\/download/);
  assert.match(prompt, /<secret_inventory>\n\[\]\n<\/secret_inventory>/);
});

test("migrates the stale server prompt that automatically invoked HtmlPlan", () => {
  const legacy = [
    "### Visual and design work",
    "- For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the html plan tool, and stop. Wait for a pick before implementing. Non-trivial is a key word here. If exact direction is given this isnt necessary.",
  ].join("\n");
  const migrated = normalizeSystemPrompt(legacy);

  assert.doesNotMatch(migrated, /build several distinct static mocks/);
  assert.match(migrated, /only when the user explicitly asks/);
  assert.match(migrated, /implement it directly/);
});

test("can route Claude to the durable qualified Monitor without name ambiguity", () => {
  const prompt = buildSocketAgentIntegrationInstructions({
    mcpServerName: "app",
    toolNames: ["Monitor"],
    secureInventory: "<secret_inventory>\n[]\n</secret_inventory>",
    monitorToolReference: "mcp__app__Monitor",
  });

  assert.match(prompt, /Background command monitoring -> mcp__app__Monitor/);
  assert.match(prompt, /not Claude's built-in Monitor/);
  assert.match(prompt, /not durable across SocketAgent turns or server restarts/);
});
