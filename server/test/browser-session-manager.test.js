const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeBrowserProfile,
  normalizeBrowserUrl,
} = require("../dist/browser-session-manager");
const { SOCKETAGENT_APP_TOOLS } = require("../dist/codex-app-mcp");

test("Codex advertises the reusable remote browser", () => {
  assert.ok(SOCKETAGENT_APP_TOOLS.some((tool) => tool.name === "BrowserSession"));
});

test("browser navigation permits normal cross-domain and local HTTP URLs", () => {
  assert.equal(
    normalizeBrowserUrl("https://accounts.google.com/signin?continue=https%3A%2F%2Fplay.google.com"),
    "https://accounts.google.com/signin?continue=https%3A%2F%2Fplay.google.com",
  );
  assert.equal(normalizeBrowserUrl("http://localhost:8123/auth"), "http://localhost:8123/auth");
});

test("browser navigation rejects non-web schemes and embedded credentials", () => {
  assert.throws(() => normalizeBrowserUrl("file:///etc/passwd"), /HTTP or HTTPS/);
  assert.throws(() => normalizeBrowserUrl("javascript:alert(1)"), /HTTP or HTTPS/);
  assert.throws(() => normalizeBrowserUrl("https://user:pass@example.com/"), /embedded credentials/);
});

test("browser profile names are stable filesystem-safe identifiers", () => {
  assert.equal(normalizeBrowserProfile(" Google-Play_William "), "google-play_william");
  assert.throws(() => normalizeBrowserProfile("../shared"), /profile names/);
  assert.throws(() => normalizeBrowserProfile("spaces are not allowed"), /profile names/);
});
