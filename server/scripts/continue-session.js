#!/usr/bin/env node
//
// continue-session.js — Send a prompt to continue a session via HTTP POST
//
// Usage: node continue-session.js <sessionId> <prompt>
//

const path = require("path");
const fs = require("fs");
const http = require("http");
const { randomUUID } = require("crypto");

// Prefer the active service's config selected by restart-server.sh. The helper
// can live in a different checkout from the installed service.
const envPath = process.env.SOCKETAGENT_ENV_PATH || path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const sessionId = process.argv[2];
const prompt = process.argv[3];

if (!sessionId || !prompt) {
  console.error("Usage: node continue-session.js <sessionId> <prompt>");
  process.exit(1);
}

const port = process.env.PORT || "8085";
const token = process.env.AUTH_TOKEN;
if (!token) {
  console.error("No AUTH_TOKEN found in .env");
  process.exit(1);
}

// Supply the same third argument when retrying an uncertain HTTP response.
const requestId = process.argv[4] || randomUUID();
console.log(`Continuation request ID: ${requestId}`);
const body = JSON.stringify({ sessionId, prompt, requestId });

const req = http.request({
  hostname: "127.0.0.1",
  port: parseInt(port),
  path: "/continue",
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
}, (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    if (res.statusCode === 200) {
      console.log("Continuation accepted. Check session history for its outcome.");
    } else {
      console.error(`Failed (${res.statusCode}): ${data}`);
      process.exit(1);
    }
  });
});

const deadline = setTimeout(() => req.destroy(new Error("Continuation request timed out; retry with the same request ID")), 30_000);
req.on("close", () => clearTimeout(deadline));

req.on("error", (err) => {
  console.error("HTTP error:", err.message);
  process.exit(1);
});

req.write(body);
req.end();
