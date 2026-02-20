#!/usr/bin/env node

/**
 * SocketClaude setup script — generates server configuration.
 *
 * Generates AUTH_TOKEN, PAIRING_TOKEN, NaCl key pair, .env, and relay-keys.json.
 * Preserves existing values on re-run (safe for upgrades).
 * Outputs QR payload JSON on the last line of stdout.
 *
 * Usage: node setup.js --env-file <path> --keys-file <path> --relay-url <url> [--default-cwd <path>] [--port <port>]
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");

// Parse CLI arguments
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  args[key] = process.argv[i + 1];
}

const envFile = args["env-file"];
const keysFile = args["keys-file"];
const relayUrl = args["relay-url"] || "";
const defaultCwd = args["default-cwd"] || process.cwd();
const port = args["port"] || "8085";

if (!envFile || !keysFile) {
  console.error(
    "Usage: node setup.js --env-file <path> --keys-file <path> [--relay-url <url>] [--default-cwd <path>] [--port <port>]"
  );
  process.exit(1);
}

// --- Read existing .env if present (preserve existing values) ---
const existingEnv = {};
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) existingEnv[match[1]] = match[2];
  }
  console.log(`Read existing config from ${envFile}`);
}

// --- Generate values (only if not already present) ---
const authToken =
  existingEnv.AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
const pairingToken = existingEnv.PAIRING_TOKEN || crypto.randomUUID();
const envPort = existingEnv.PORT || port;
const envRelay = existingEnv.RELAY_URL || relayUrl;
const envCwd = existingEnv.DEFAULT_CWD || defaultCwd;

// --- Write .env ---
const envContent = [
  `PORT=${envPort}`,
  `AUTH_TOKEN=${authToken}`,
  `DEFAULT_CWD=${envCwd}`,
  `RELAY_URL=${envRelay}`,
  `PAIRING_TOKEN=${pairingToken}`,
].join("\n") + "\n";

fs.writeFileSync(envFile, envContent);
console.log(`Wrote ${envFile}`);

// --- Generate or load NaCl key pair ---
let publicKeyB64, secretKeyB64;

if (fs.existsSync(keysFile)) {
  const data = JSON.parse(fs.readFileSync(keysFile, "utf-8"));
  publicKeyB64 = data.publicKey;
  secretKeyB64 = data.secretKey;
  console.log(`Loaded existing key pair from ${keysFile}`);
} else {
  const kp = nacl.box.keyPair();
  publicKeyB64 = Buffer.from(kp.publicKey).toString("base64");
  secretKeyB64 = Buffer.from(kp.secretKey).toString("base64");

  const keysDir = path.dirname(keysFile);
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  fs.writeFileSync(
    keysFile,
    JSON.stringify(
      { publicKey: publicKeyB64, secretKey: secretKeyB64 },
      null,
      2
    )
  );
  console.log(`Generated new key pair -> ${keysFile}`);
}

// --- Output QR payload on last line (parsed by installer) ---
// Relay URL is hardcoded in the app — QR only needs token + pubkey.
// Format: SC|<token>|<pubkey> — plain delimited, no JSON (avoids
// PowerShell stripping quotes when passing to qrcode-terminal).
const qrPayload = `SC|${pairingToken}|${publicKeyB64}`;

console.log(qrPayload);
