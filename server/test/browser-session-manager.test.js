const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  browserDataDir,
  normalizeBrowserProfile,
  normalizeBrowserUrl,
  resolveBrowserBinary,
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

test("browser resolver uses the managed installer marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-browser-test-"));
  const executable = path.join(root, "managed-browser");
  const runtime = path.join(root, "browser-runtime");
  const previousDataDir = process.env.SOCKET_AGENT_DATA_DIR;
  try {
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(executable, "test", { mode: 0o700 });
    fs.writeFileSync(path.join(runtime, "executable-path"), `${executable}\n`);
    process.env.SOCKET_AGENT_DATA_DIR = root;
    assert.equal(resolveBrowserBinary(), executable);
  } finally {
    if (previousDataDir === undefined) delete process.env.SOCKET_AGENT_DATA_DIR;
    else process.env.SOCKET_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Ubuntu snap Chromium stores persistent profiles in its confined writable home", () => {
  assert.equal(
    browserDataDir("/usr/bin/chromium-browser"),
    path.join(process.env.HOME || os.homedir(), "snap", "chromium", "common", "socketagent-browser-sessions"),
  );
});
