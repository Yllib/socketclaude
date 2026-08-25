const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeSystemPrompt } = require("../dist/server-settings");

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
