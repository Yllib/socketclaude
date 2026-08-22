const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-test-file-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

module.exports = dataDir;
