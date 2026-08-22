const assert = require("node:assert/strict");
const test = require("node:test");

const { codexThreadToSessionInfo } = require("../dist/session-store");

const thread = {
  id: "new-native-id",
  cwd: "/tmp/project",
  name: "<socketagent_session_handoff>",
  preview: "<socketagent_session_handoff> hidden continuity data",
  createdAt: 1787436000,
  updatedAt: 1787436060,
};

test("stored session name wins over a native handoff wrapper title", () => {
  const session = codexThreadToSessionInfo(thread, {
    id: thread.id,
    title: "Socketagent",
    cwd: thread.cwd,
    createdAt: "2026-08-22T22:00:00.000Z",
    lastActive: "2026-08-22T22:01:00.000Z",
    messagePreview: "",
    backend: "codex",
  });

  assert.equal(session.title, "Socketagent");
});

test("native title remains the fallback for an untracked thread", () => {
  const session = codexThreadToSessionInfo({ ...thread, name: "Native title" });
  assert.equal(session.title, "Native title");
});
