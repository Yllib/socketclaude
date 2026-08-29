const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-browser-history-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const { publishBrowserSessionCard } = require("../dist/app-tool-handlers");
const {
  appendHistory,
  getBrowserSessionHistory,
  getHistory,
} = require("../dist/session-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("browser cards are durable and reopening a profile updates one transcript row", () => {
  const sessionId = "browser-card-session";
  const packets = [];
  const ctx = {
    getSessionId: () => sessionId,
    appendHistory: (entry) => appendHistory(sessionId, entry),
    send: (message) => packets.push(message),
  };
  const browser = {
    profile: "google-play-rubano",
    label: "Google Play",
    running: true,
    url: "https://play.google.com/console",
  };

  const first = publishBrowserSessionCard(ctx, browser, browser.url);
  const second = publishBrowserSessionCard(ctx, {
    ...browser,
    label: "Google Admin verification",
    url: "https://admin.google.com/ac/domains/manage",
  }, browser.url);

  const cards = getHistory(sessionId).filter((entry) => entry.role === "browser_session");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].toolInput.profile, "google-play-rubano");
  assert.equal(cards[0].toolInput.url, "https://admin.google.com/ac/domains/manage");
  assert.equal(cards[0].entryId, first.entryId);
  assert.equal(cards[0].sessionSeq, first.sessionSeq);
  assert.ok(second.revision > first.revision);
  assert.equal(packets.length, 2);
  assert.equal(packets[1].entryId, cards[0].entryId);
  assert.equal(packets[1].sessionSeq, cards[0].sessionSeq);
  assert.equal(packets[1].revision, cards[0].revision);
  assert.deepEqual(getBrowserSessionHistory(sessionId), cards);

  appendHistory(sessionId, {
    ...cards[0],
    entryId: "legacy-browser-card",
    sessionSeq: undefined,
    revision: undefined,
    timestamp: new Date(Date.now() + 1_000).toISOString(),
  });
  const recovered = getBrowserSessionHistory(sessionId);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].entryId, `browser-session:${browser.profile}`);
});
