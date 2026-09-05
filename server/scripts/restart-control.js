#!/usr/bin/env node
// Credentials stay in the environment, not URLs or command arguments.
const http = require("http");
const [action, previousPid] = process.argv.slice(2);
if (!["prepare", "cancel", "status"].includes(action) || !process.env.AUTH_TOKEN) {
  console.error("Usage: restart-control.js prepare|cancel|status [previousPid], with AUTH_TOKEN set");
  process.exit(1);
}
const req = http.request({
  hostname: "127.0.0.1", port: Number(process.env.PORT || 8085),
  path: `/internal/restart/${action}`, method: action === "status" ? "GET" : "POST",
  headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
}, res => {
  let body = "";
  res.on("data", chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(new Error("Response too large")); });
  res.on("end", () => {
    try {
      if (res.statusCode !== 200) throw new Error(`Restart ${action} failed (${res.statusCode}): ${body.slice(0, 200)}`);
      const result = JSON.parse(body);
      if (action === "status" && (!result.ready || String(result.pid) === previousPid)) throw new Error("New server is not ready yet");
      if (action === "prepare") console.log(result.pid);
      if (action === "status") console.log(JSON.stringify(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
  res.on("error", error => { console.error(error.message); process.exitCode = 1; });
});
const deadline = setTimeout(() => req.destroy(new Error("Restart request timed out")), 5000);
req.on("close", () => clearTimeout(deadline));
req.on("error", error => { console.error(error.message); process.exitCode = 1; });
req.end();
