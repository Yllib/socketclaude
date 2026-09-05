const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { RestartRecoveryStore, RestartRecoveryWorker, boundedRecoverySetup, RESTART_CONTINUATION_PROMPT } = require("../dist/restart-recovery");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-restart-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "runs.json");
  return { dir, file, store: new RestartRecoveryStore(file) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("journal survives process loss, keeps all interrupted runs, and excludes completed work", t => {
  const { file, store } = fixture(t);
  const a = store.start("a");
  store.start("b");
  const done = store.start("done");
  store.complete("done", done);
  const reboot = new RestartRecoveryStore(file);
  assert.deepEqual(reboot.list().map(r => [r.sessionId, r.state]), [["a", "pending"], ["b", "pending"]]);
  assert.equal(reboot.get("a").id, a);
  assert.ok(reboot.wasCompleted(done));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("stale completion and repeated claim cannot overwrite a newer run", t => {
  const { file, store } = fixture(t);
  const old = store.start("a");
  const next = store.start("a");
  store.complete("a", old);
  assert.equal(store.get("a").id, next);
  const reboot = new RestartRecoveryStore(file);
  assert.equal(reboot.claim("a", old), false);
  assert.equal(reboot.claim("a", next), true);
  assert.equal(reboot.claim("a", next), false);
});

test("claimed recovery is recoverable after another crash", t => {
  const { file, store } = fixture(t);
  const id = store.start("a");
  const reboot = new RestartRecoveryStore(file);
  reboot.claim("a", id);
  const again = new RestartRecoveryStore(file);
  assert.equal(again.get("a").state, "pending");
  assert.equal(again.get("a").attempts, 1);
});

test("rekey retains recovery identity and does not resume the obsolete session ID", t => {
  const { file, store } = fixture(t);
  const id = store.start("old");
  store.rekey("old", "new", id);
  const reboot = new RestartRecoveryStore(file);
  assert.equal(reboot.get("old"), undefined);
  assert.equal(reboot.get("new").id, id);
});

test("setup failures back off and stop after five attempts, across process restarts", t => {
  const { file, store } = fixture(t);
  const id = store.start("a");
  let current = new RestartRecoveryStore(file);
  for (let i = 1; i <= 5; i++) {
    assert.equal(current.claim("a", id), true);
    current.retry("a", id, "setup failed", 100);
    assert.equal(current.get("a").nextAttemptAt, 100 + 1000 * 2 ** i);
    current = new RestartRecoveryStore(file);
  }
  assert.equal(current.get("a").state, "failed");
  assert.equal(current.claim("a", id), false);
});

test("corrupt recovery data fails closed and preserves the file", t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "not valid json");
  assert.throws(() => new RestartRecoveryStore(file));
  assert.equal(fs.readFileSync(file, "utf8"), "not valid json");
});

test("setup deadline rejects a hung backend without awaiting it forever", async () => {
  await assert.rejects(boundedRecoverySetup(new Promise(() => {}), 10), /timed out/);
  assert.equal(await boundedRecoverySetup(Promise.resolve(42), 10), 42);
});

test("worker respects readiness, Stop, deleted sessions, and a racing user prompt", async t => {
  const { file, store } = fixture(t);
  for (const sid of ["run", "stopped", "deleted", "user"]) store.start(sid);
  const reboot = new RestartRecoveryStore(file);
  let ready = false;
  const launched = [];
  const worker = new RestartRecoveryWorker(reboot, {
    ready: () => ready, exists: s => s !== "deleted", stopped: s => s === "stopped", busy: s => s === "user",
    launch: async r => { launched.push(r.sessionId); }, notice: () => {},
  });
  worker.tick(); await settle(); assert.deepEqual(launched, []);
  ready = true;
  worker.tick(); worker.tick(); await settle();
  assert.deepEqual(launched, ["run"]);
  assert.equal(reboot.get("stopped"), undefined);
  assert.equal(reboot.get("deleted"), undefined);
  assert.equal(reboot.get("user").state, "pending");
});

test("one failed startup does not prevent other sessions from recovering", async t => {
  const { file, store } = fixture(t);
  store.start("bad"); store.start("good");
  const reboot = new RestartRecoveryStore(file);
  const notices = [];
  const worker = new RestartRecoveryWorker(reboot, {
    ready: () => true, exists: () => true, stopped: () => false, busy: () => false,
    launch: async r => { if (r.sessionId === "bad") throw new Error("offline"); },
    notice: (s, m) => notices.push([s, m]),
  });
  worker.tick(); await settle();
  assert.equal(reboot.get("bad").state, "pending");
  assert.equal(reboot.get("good").state, "active");
  assert.match(notices[0][1], /retry automatically/);
  const count = reboot.get("bad").attempts;
  worker.tick(0); await settle(); assert.equal(reboot.get("bad").attempts, count);
});

test("worker bounds simultaneous setup and never launches a claimed run twice", async t => {
  const { file, store } = fixture(t);
  for (let i = 0; i < 5; i++) store.start(String(i));
  const reboot = new RestartRecoveryStore(file);
  const started = [];
  const releases = [];
  const worker = new RestartRecoveryWorker(reboot, {
    ready: () => true, exists: () => true, stopped: () => false, busy: () => false,
    launch: r => { started.push(r.id); return new Promise(resolve => releases.push(resolve)); }, notice: () => {},
  });
  worker.tick(); worker.tick(); await settle(); assert.equal(started.length, 3);
  releases.splice(0).forEach(resolve => resolve()); await settle();
  worker.tick(); await settle(); assert.equal(started.length, 5);
  assert.equal(new Set(started).size, 5);
  releases.forEach(resolve => resolve()); await settle();
});

test("continuation warns about uncertain external side effects", () => {
  assert.match(RESTART_CONTINUATION_PROMPT, /Check the actual state before repeating/);
  assert.match(RESTART_CONTINUATION_PROMPT, /ask the user/);
});

async function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", c => output += c);
    child.stderr.on("data", c => output += c);
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

async function mockServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...process.env, PORT: String(server.address().port), AUTH_TOKEN: "test-only-token" };
}

test("one-time bootstrap admits only the caller, never overwrites a journal, and can cancel", async t => {
  const { dir } = fixture(t);
  const scripts = path.join(dir, "scripts");
  fs.mkdirSync(scripts);
  const helper = path.join(scripts, "bootstrap-restart.js");
  fs.copyFileSync(path.join(__dirname, "../scripts/bootstrap-restart.js"), helper);
  fs.writeFileSync(path.join(scripts, "service-control.sh"), "#!/bin/sh\necho fake-service\n", { mode: 0o700 });
  fs.writeFileSync(path.join(scripts, "systemctl"), "#!/bin/sh\necho 123\n", { mode: 0o700 });
  let sessions = ["caller", "other"];
  const env = await mockServer(t, (req, res) => {
    if (req.url === "/internal/restart/status") { res.writeHead(404); res.end("Not found"); }
    else res.end(JSON.stringify({ sessions }));
  });
  const isolatedEnv = { ...env, PATH: `${scripts}:${env.PATH}`, SOCKET_AGENT_DATA_DIR: dir, SOCKETAGENT_DATA_DIR: dir };
  const journal = path.join(dir, "recovery/runs.json");
  assert.equal((await runChild(process.execPath, [helper, "seed", "caller"], isolatedEnv)).code, 1);
  assert.equal(fs.existsSync(journal), false);
  sessions = ["caller"];
  assert.equal((await runChild(process.execPath, [helper, "seed", "caller"], isolatedEnv)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(journal)).runs[0].sessionId, "caller");
  const before = fs.readFileSync(journal, "utf8");
  assert.equal((await runChild(process.execPath, [helper, "seed", "caller"], isolatedEnv)).code, 1);
  assert.equal(fs.readFileSync(journal, "utf8"), before);
  await runChild(process.execPath, [helper, "cancel", "caller", "999"], isolatedEnv);
  assert.equal(fs.existsSync(journal), true);
  await runChild(process.execPath, [helper, "cancel", "caller", "123"], isolatedEnv);
  assert.equal(fs.existsSync(journal), false);
});

test("readiness helper rejects the old process and authenticates without query credentials", async t => {
  const env = await mockServer(t, (req, res) => {
    assert.equal(req.url, "/internal/restart/status");
    assert.equal(req.headers.authorization, "Bearer test-only-token");
    res.end(JSON.stringify({ ready: true, pid: 123 }));
  });
  const helper = path.resolve(__dirname, "../scripts/restart-control.js");
  assert.equal((await runChild(process.execPath, [helper, "status", "123"], env)).code, 1);
  assert.equal((await runChild(process.execPath, [helper, "status", "122"], env)).code, 0);
});

for (const scenario of ["ready", "prepare-fails", "compile-fails", "restart-fails", "guard-fails", "never-ready"]) {
  test(`restart worker with mocked service manager: ${scenario}`, async t => {
    const { dir } = fixture(t);
    const scripts = path.join(dir, "scripts");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(scripts); fs.mkdirSync(bin);
    for (const file of ["restart-server.sh", "restart-control.js"]) fs.copyFileSync(path.join(__dirname, "../scripts", file), path.join(scripts, file));
    const calls = [];
    let statusCalls = 0;
    const env = await mockServer(t, (req, res) => {
      calls.push(req.url);
      if (req.url.endsWith("prepare")) {
        res.statusCode = scenario === "prepare-fails" ? 503 : 200;
        res.end(JSON.stringify({ pid: 1 }));
      } else if (req.url.endsWith("status")) {
        // A listening old process and a not-yet-ready new process are not success.
        statusCalls++;
        res.end(JSON.stringify({ pid: statusCalls === 1 ? 1 : 2, ready: scenario !== "never-ready" && statusCalls >= 3 }));
      } else res.end("{}");
    });
    fs.writeFileSync(path.join(dir, ".env"), `PORT=${env.PORT}\nAUTH_TOKEN=test-only-token\nSOCKETAGENT_DATA_DIR=${dir}/data\nSOCKETAGENT_NODE=${process.execPath}\n`);
    fs.writeFileSync(path.join(scripts, "service-control.sh"), `#!/bin/bash\ncase "$1" in\n directory) echo '${dir}' ;;\n environment-file) echo '${dir}/.env' ;;\n restart) echo restart >> '${dir}/service-calls'; exit ${scenario === "restart-fails" ? 1 : 0} ;;\nesac\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(scripts, "recovery-guard.sh"), `#!/bin/bash\necho "$1" >> '${dir}/guard-calls'\necho test-guard\nexit ${scenario === "guard-fails" ? 1 : 0}\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "npx"), "#!/bin/bash\nexit 1\n", { mode: 0o700 });
    const result = await runChild("bash", [path.join(scripts, "restart-server.sh"), ...(scenario === "compile-fails" ? [] : ["--no-compile"])], {
      ...env, _RESTART_DETACHED: "1", PATH: `${bin}:${env.PATH}`,
    });
    assert.equal(result.code, scenario === "ready" ? 0 : 1, result.output);
    assert.equal(fs.existsSync(path.join(dir, "service-calls")), ["ready", "restart-fails", "never-ready"].includes(scenario));
    assert.ok(!calls.some(c => c.startsWith("/continue")));
    if (scenario === "compile-fails") assert.deepEqual(calls, []);
    if (["restart-fails", "guard-fails"].includes(scenario)) assert.ok(calls.includes("/internal/restart/cancel"));
    if (scenario === "never-ready") {
      assert.equal(statusCalls, 60);
      assert.equal(fs.readFileSync(path.join(dir, "guard-calls"), "utf8"), "arm\n");
    }
    if (scenario === "ready") {
      assert.equal(statusCalls, 3);
      assert.equal(fs.readFileSync(path.join(dir, "guard-calls"), "utf8"), "arm\ncancel\n");
    }
  });
}
