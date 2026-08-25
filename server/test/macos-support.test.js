const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = require("node:path").resolve(__dirname, "../..");

test("server shell entrypoints pass bash syntax validation", () => {
  const scripts = [
    "install.sh",
    "install-server.sh",
    "bin/socketagent",
    "server/scripts/start-server.sh",
    "server/scripts/restart-server.sh",
    "server/scripts/recovery-guard.sh",
    "server/scripts/install-macos-helper.sh",
    "server/scripts/ensure-codex-linux-sandbox.sh",
    "server/scripts/service-control.sh",
  ];
  const result = spawnSync("bash", ["-n", ...scripts], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
