#!/usr/bin/env node
// One-time local upgrade from servers without the preparation endpoint.
// Refuse to interrupt anything except the explicitly identified caller.
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFileSync } = require("child_process");
const [action, sessionId, expectedPid] = process.argv.slice(2);
const serviceControl = path.join(__dirname, "service-control.sh");
const storeDir = process.env.SOCKET_AGENT_DATA_DIR || process.env.SOCKETAGENT_DATA_DIR
  || process.env.SOCKET_AGENT_HOME || process.env.SOCKETAGENT_HOME
  || path.join(process.env.HOME, ".socket-agent");
const file = path.join(storeDir, "recovery", "runs.json");
function pid() {
  const service = execFileSync(serviceControl, ["name"], { encoding: "utf8" }).trim();
  return execFileSync("systemctl", ["--user", "show", service, "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
}
async function request(route) {
  return fetch(`http://127.0.0.1:${process.env.PORT || 8085}${route}`, {
    headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` }, signal: AbortSignal.timeout(5000),
  });
}
(async () => {
  if (process.platform !== "linux" || !process.env.AUTH_TOKEN || !sessionId) throw new Error("Bootstrap requires Linux, credentials, and an explicit session ID");
  const status = await request("/internal/restart/status");
  if (status.status !== 404) throw new Error("Bootstrap is only for old servers without restart preparation");
  const currentPid = pid();
  if (!/^[1-9][0-9]*$/.test(currentPid)) throw new Error("No running service process");
  if (action === "cancel") {
    if (currentPid !== expectedPid || !fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.runs?.length === 1 && data.runs[0].sessionId === sessionId
        && data.runs[0].id.startsWith(`bootstrap:${currentPid}:`)) fs.unlinkSync(file);
    return;
  }
  if (action !== "seed") throw new Error("Usage: bootstrap-restart.js seed|cancel sessionId [oldPid]");
  const response = await request(`/running-sessions?token=${encodeURIComponent(process.env.AUTH_TOKEN)}`);
  if (!response.ok) throw new Error("Could not verify active sessions");
  const running = await response.json();
  if (!Array.isArray(running.sessions) || running.sessions.length !== 1 || running.sessions[0] !== sessionId) {
    throw new Error("Bootstrap refused: only the explicitly identified caller may be running");
  }
  if (fs.existsSync(file)) throw new Error("Recovery journal already exists; refusing to overwrite it");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.bootstrap-${process.pid}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, completed: [], runs: [{
      sessionId, id: `bootstrap:${currentPid}:${randomUUID()}`, state: "active", attempts: 0, nextAttemptAt: 0,
    }] }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); }
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  console.log(currentPid);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
