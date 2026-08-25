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
