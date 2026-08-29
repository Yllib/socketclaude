const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  browserDataDir,
  normalizeBrowserProfile,
  normalizeBrowserUrl,
  removeStaleBrowserControlFile,
  resolveBrowserBinary,
} = require("../dist/browser-session-manager");
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

test("browser launch discards stale Chromium control files", () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-browser-profile-"));
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const singletonLock = path.join(profileDir, "SingletonLock");
  const singletonSocket = path.join(profileDir, "SingletonSocket");
  const singletonCookie = path.join(profileDir, "SingletonCookie");
  try {
    fs.writeFileSync(activePortPath, "41723\n/devtools/browser/stale\n");
    fs.symlinkSync("agent-dev-999999999", singletonLock);
    fs.symlinkSync("/tmp/socketagent-missing/SingletonSocket", singletonSocket);
    fs.symlinkSync("123456789", singletonCookie);
    removeStaleBrowserControlFile(profileDir);
    assert.equal(fs.existsSync(activePortPath), false);
    assert.throws(() => fs.lstatSync(singletonLock), { code: "ENOENT" });
    assert.throws(() => fs.lstatSync(singletonSocket), { code: "ENOENT" });
    assert.throws(() => fs.lstatSync(singletonCookie), { code: "ENOENT" });
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
