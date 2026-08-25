const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("installers install both harnesses without choices or login prompts", () => {
  const unix = read("install-server.sh");
  const windows = read("install.ps1");

  for (const [name, installer] of [
    ["install-server.sh", unix],
    ["install.ps1", windows],
  ]) {
    assert.match(installer, /@anthropic-ai\/claude-code@latest/);
    assert.match(installer, /@openai\/codex@latest/);
    assert.doesNotMatch(installer, /\bBackends?\b/);
    assert.doesNotMatch(installer, /Which managed agent toolchain/);
    assert.doesNotMatch(installer, /Claude Code Authentication/);
    assert.doesNotMatch(installer, /Codex Authentication/);
    assert.doesNotMatch(installer, /claude auth login/);
    assert.doesNotMatch(installer, /codex login --device-auth/);
    assert.doesNotMatch(installer, /Read-Host|prompt_read/);
    assert.match(installer, /Sign in later from the app or CLI if needed/);
    const pairingMarker = name === "install.ps1"
      ? "Show-QrCode $qrPayload"
      : "qrcode-terminal";
    assert.ok(
      installer.indexOf("Installation complete!") <
        installer.lastIndexOf(pairingMarker),
      `${name} should finish by presenting the pairing QR`,
    );
  }
});

test("public install entrypoints expose one-command setup only", () => {
  const unixEntrypoint = read("install.sh");
  const windowsEntrypoint = read("install-windows.ps1");
  const readme = read("README.md");

  assert.doesNotMatch(unixEntrypoint, /--backends?/);
  assert.doesNotMatch(windowsEntrypoint, /-Backends?/);
  assert.doesNotMatch(readme, /Choose Claude, Codex, or both/);
  assert.match(
    readme,
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Yllib\/socketagent\/master\/install\.sh \| bash/,
  );
  assert.match(
    readme,
    /irm https:\/\/raw\.githubusercontent\.com\/Yllib\/socketagent\/master\/install-windows\.ps1 \| iex/,
  );
  assert.doesNotMatch(
    readme,
    /powershell(?:\.exe)?\s+-ExecutionPolicy[^\n]*install-windows\.ps1/i,
  );
  assert.doesNotMatch(windowsEntrypoint, /&\s+powershell(?:\.exe)?\b/i);
  assert.doesNotMatch(windowsEntrypoint, /^\s*exit\b/im);
  assert.match(windowsEntrypoint, /This window will stay open so the error is not lost/);
});

test("Unix entrypoint runs without a controlling terminal", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-installer-"));
  try {
    fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(fixture, "install.sh"));
    fs.mkdirSync(path.join(fixture, "server"));
    fs.writeFileSync(
      path.join(fixture, "install-server.sh"),
      "#!/usr/bin/env bash\nprintf 'delegated without tty\\n'\n",
      { mode: 0o755 },
    );
    const init = spawnSync("git", ["init", "--quiet", fixture], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const result = spawnSync("bash", [path.join(fixture, "install.sh")], {
      encoding: "utf8",
      input: "",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /delegated without tty/);
    assert.doesNotMatch(result.stderr, /\/dev\/tty/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Linux installs and repairs Codex's Bubblewrap sandbox dependency", () => {
  const installer = read("install-server.sh");
  const repair = read("server/scripts/ensure-codex-linux-sandbox.sh");
  const startup = read("server/src/index.ts");

  assert.match(installer, /ensure-codex-linux-sandbox\.sh/);
  assert.match(installer, /CODEX_SANDBOX_REPAIR" --interactive/);
  assert.match(repair, /apt-get install -y bubblewrap/);
  assert.match(repair, /dnf install -y bubblewrap/);
  assert.match(repair, /pacman -Sy --noconfirm bubblewrap/);
  assert.match(repair, /--unshare-all/);
  assert.match(repair, /bwrap-userns-restrict/);
  assert.match(repair, /sudo -n true/);
  assert.match(startup, /ensureCodexLinuxSandboxDependency\("startup"\)/);
  assert.match(startup, /periodic retry/);
  assert.match(startup, /SOCKETAGENT_AUTO_REPAIR_CODEX_SANDBOX/);
});

test("Unix installer provisions native Node build tools", () => {
  const installer = read("install-server.sh");

  assert.match(installer, /native_build_tools_ready/);
  assert.match(installer, /apt-get install -y build-essential python3/);
  assert.match(installer, /dnf install -y gcc-c\+\+ make python3/);
  assert.match(installer, /pacman -Sy --noconfirm base-devel python/);
  assert.match(installer, /apk add build-base python3/);
  assert.match(installer, /command -v make/);
  assert.match(installer, /command -v (?:c\+\+|g\+\+|clang\+\+)/);
});
