const assert = require("node:assert/strict");
const test = require("node:test");

const { TurnAbortTracker } = require("../dist/turn-abort-tracker");

test("an abort only suppresses completion for the active turn", () => {
  const tracker = new TurnAbortTracker();
  const session = {};
  const stoppedTurn = tracker.begin(session);

  tracker.markHardAborted(session);
  const replacementTurn = tracker.begin(session);

  assert.equal(tracker.finish(session, stoppedTurn), true);
  assert.equal(tracker.finish(session, replacementTurn), false);
});

test("a late abort cannot poison the next turn", () => {
  const tracker = new TurnAbortTracker();
  const session = {};
  const completedTurn = tracker.begin(session);

  assert.equal(tracker.finish(session, completedTurn), false);
  tracker.markHardAborted(session);

  const nextTurn = tracker.begin(session);
  assert.equal(tracker.finish(session, nextTurn), false);
});
