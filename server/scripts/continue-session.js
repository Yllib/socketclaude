#!/usr/bin/env node
//
// continue-session.js — Send a prompt to continue a session via HTTP POST
//
// Usage: node continue-session.js <sessionId> <prompt>
//

const path = require("path");
const fs = require("fs");
const http = require("http");

// Load .env from server dir
const envPath = path.join(__dirname, "..", ".env");
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

const body = JSON.stringify({ sessionId, prompt });

const req = http.request({
  hostname: "localhost",
  port: parseInt(port),
  path: `/continue?token=${token}`,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
}, (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    if (res.statusCode === 200) {
      console.log("Session continued successfully");
    } else {
      console.error(`Failed (${res.statusCode}): ${data}`);
      process.exit(1);
    }
  });
});

req.on("error", (err) => {
  console.error("HTTP error:", err.message);
  process.exit(1);
});

req.write(body);
req.end();
