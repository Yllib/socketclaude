const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-work-review-integration-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  handleWorkReviewTool,
  publishWorkReviewCard,
} = require("../dist/app-tool-handlers");
const {
  archiveWorkReview,
  cancelWorkReview,
  finishWorkReview,
  getWorkReviewClientSnapshot,
  restoreWorkReview,
  updateWorkReviewDraft,
} = require("../dist/work-review-service");
const {
  appendHistory,
  getHistory,
} = require("../dist/session-store");
const {
  WorkReviewResultDeliveryStore,
} = require("../dist/work-review-delivery-store");
const {
  buildWorkReviewResultPrompt,
  deliverWorkReviewToSession,
} = require("../dist/work-review-result-route");
const { saveHtmlPlan } = require("../dist/html-plan-store");

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function parseToolResult(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("WorkReview keeps draft feedback private and upserts one stable history card", async () => {
  const sessionId = "review-origin-session";
  const sent = [];
  const ctx = {
    getSessionId: () => sessionId,
    getBackend: () => "codex",
    getTtsEngine: () => "system",
    getKokoroVoice: () => "af_heart",
    getKokoroSpeed: () => 1,
    appendHistory: (entry) => appendHistory(sessionId, entry),
    send: (message) => sent.push(message),
  };

  const created = parseToolResult(await handleWorkReviewTool(ctx, {
    action: "create",
    idempotency_key: "integration-create-1",
    title: "Inspect the deployed change",
    purpose: "pre-deployment verification",
    approval_meaning: "Approval authorizes production deployment.",
    items: [{
      item_id: "home",
      title: "Homepage",
      primary_target: {
        kind: "url",
        uri: "https://example.com/preview",
        environment: "sandbox",
        displayMode: "embedded",
      },
    }],
  }));

  const review = created.review;
  assert.ok(review.reviewId);
  assert.equal(created.card.entryId, review.cardId);
  assert.equal(created.card.sessionSeq, 1);

  const initial = getWorkReviewClientSnapshot(review.reviewId);
  await updateWorkReviewDraft(review.reviewId, {
    mutationId: "draft-private-1",
    expectedRevision: initial.currentDraft.revision,
    itemUpdates: [{
      itemId: "home",
      status: "changes_requested",
      note: "PRIVATE-DRAFT-NOTE",
    }],
    overallNote: "PRIVATE-OVERALL-NOTE",
  });

  for (const action of ["get", "list", "export"]) {
    const result = parseToolResult(await handleWorkReviewTool(ctx, {
      action,
      review_id: action === "get" ? review.reviewId : undefined,
      include_archived: true,
    }));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("PRIVATE-DRAFT-NOTE"), false);
    assert.equal(serialized.includes("PRIVATE-OVERALL-NOTE"), false);
    assert.equal(serialized.includes("currentDraft"), false);
  }
  assert.equal(JSON.stringify(sent).includes("PRIVATE-DRAFT-NOTE"), false);

  const beforeFinish = getWorkReviewClientSnapshot(review.reviewId);
  const finished = await finishWorkReview(review.reviewId, {
    draft: {
      mutationId: "finish-private-1",
      expectedRevision: beforeFinish.currentDraft.revision,
      itemUpdates: [{
        itemId: "home",
        status: "approved",
        note: "Published note",
      }],
      overallNote: "Ready to deploy",
    },
  });
  const updatedCard = publishWorkReviewCard(ctx, finished.review);
  const cards = getHistory(sessionId).filter((entry) => entry.role === "work_review");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].entryId, review.cardId);
  assert.equal(cards[0].sessionSeq, created.card.sessionSeq);
  assert.ok(cards[0].revision > created.card.revision);
  assert.equal(updatedCard.entryId, created.card.entryId);
  assert.equal(cards[0].workReview.title, "Inspect the deployed change");
  assert.equal(cards[0].workReview.status, "completed");
  assert.equal(cards[0].workReview.rounds, undefined);

  const repeated = await finishWorkReview(review.reviewId, {
    draft: {
      mutationId: "finish-private-1",
      expectedRevision: beforeFinish.currentDraft.revision,
      itemUpdates: [{
        itemId: "home",
        status: "approved",
        note: "Published note",
      }],
      overallNote: "Ready to deploy",
    },
  });
  assert.equal(repeated.published, false);
  assert.equal(repeated.result.resultId, finished.result.resultId);
});

test("silent lifecycle changes revise one durable phone card without draft content", async () => {
  const sessionId = "review-lifecycle-session";
  const sent = [];
  const ctx = {
    getSessionId: () => sessionId,
    getBackend: () => "claude",
    appendHistory: (entry) => appendHistory(sessionId, entry),
    send: (message) => sent.push(message),
  };
  const created = parseToolResult(await handleWorkReviewTool(ctx, {
    action: "create",
    idempotency_key: "integration-lifecycle-1",
    title: "Lifecycle review",
    items: [{
      item_id: "item-1",
      title: "Item one",
      primary_target: { kind: "url", uri: "https://example.com" },
    }],
  }));
  const snapshot = getWorkReviewClientSnapshot(created.review.reviewId);
  await updateWorkReviewDraft(created.review.reviewId, {
    mutationId: "private-lifecycle-draft",
    expectedRevision: snapshot.currentDraft.revision,
    itemUpdates: [{
      itemId: "item-1",
      status: "changes_requested",
      note: "PRIVATE-LIFECYCLE-NOTE",
    }],
  });

  const cancelled = await cancelWorkReview(created.review.reviewId);
  publishWorkReviewCard(ctx, cancelled);
  let card = getHistory(sessionId).find((entry) => entry.role === "work_review");
  assert.equal(card.entryId, created.card.entryId);
  assert.equal(card.workReview.status, "cancelled");
  assert.equal(JSON.stringify(card).includes("PRIVATE-LIFECYCLE-NOTE"), false);

  const archived = await archiveWorkReview(created.review.reviewId);
  publishWorkReviewCard(ctx, archived);
  card = getHistory(sessionId).find((entry) => entry.role === "work_review");
  assert.ok(card.workReview.archivedAt);

  const restored = await restoreWorkReview(created.review.reviewId);
  publishWorkReviewCard(ctx, restored);
  const cards = getHistory(sessionId).filter((entry) => entry.role === "work_review");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].entryId, created.card.entryId);
  assert.equal(cards[0].workReview.archivedAt, undefined);
  assert.equal(cards[0].workReview.status, "cancelled");
});

test("WorkReview embeds one same-session HTML plan for anchored item decisions", async () => {
  const sessionId = "linked-plan-review-session";
  const sent = [];
  const ctx = {
    getSessionId: () => sessionId,
    getBackend: () => "codex",
    appendHistory: (entry) => appendHistory(sessionId, entry),
    send: (message) => sent.push(message),
  };
  const plan = saveHtmlPlan({
    sessionId,
    planId: "feedback-queue-plan",
    title: "Feedback queue",
    html: '<section id="ticket-699"><h2>Ticket 699</h2></section>',
  });
  const created = parseToolResult(await handleWorkReviewTool(ctx, {
    action: "create",
    idempotency_key: "linked-plan-review-create",
    linked_html_plan_id: plan.planId,
    title: "Choose ticket directions",
    items: [{
      item_id: "ticket-699",
      title: "Ticket 699",
      primary_target: { kind: "html_plan", uri: "#ticket-699" },
    }],
  }));

  const card = getHistory(sessionId).find((entry) => entry.role === "work_review");
  assert.equal(created.review.rounds[0].linkedHtmlPlanId, plan.planId);
  assert.equal(card.workReview.linkedHtmlPlan.planId, plan.planId);
  assert.match(card.workReview.linkedHtmlPlan.html, /ticket-699/);
  assert.equal(card.workReview.items[0].primaryTarget.kind, "html_plan");
  assert.equal(JSON.stringify(card).match(/<section/g).length, 1);

  const missing = await handleWorkReviewTool(ctx, {
    action: "create",
    idempotency_key: "missing-linked-plan-create",
    linked_html_plan_id: "not-in-this-session",
    title: "Invalid plan",
    items: [{
      title: "Ticket",
      primary_target: { kind: "html_plan", uri: "#ticket" },
    }],
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found in this session/);
});

test("Work Review result outbox persists compact pending records and delivered tombstones", () => {
  const file = path.join(dataDir, "outbox-test.json");
  const store = new WorkReviewResultDeliveryStore(file);
  const resultId = "result-durable-1";
  store.enqueue({
    reviewId: "review-1",
    originSessionId: "origin-1",
    rounds: [{ summary: "x".repeat(512 * 1024) }],
  }, {
    resultId,
    reviewId: "review-1",
    roundId: "round-1",
    itemResults: [{ itemId: "item-1", status: "approved", note: "y".repeat(512 * 1024) }],
  });
  assert.equal(store.pending().length, 1);
  assert.ok(fs.statSync(file).size < 2_000);

  const pendingAfterRestart = new WorkReviewResultDeliveryStore(file);
  assert.deepEqual(
    pendingAfterRestart.pending().map((record) => record.resultId),
    [resultId],
  );

  store.markDelivered(resultId);
  const restored = new WorkReviewResultDeliveryStore(file);
  assert.equal(restored.pending().length, 0);
  assert.equal(restored.isDelivered(resultId), true);
  assert.ok(fs.statSync(file).size < 500);
});

test("Claude and Codex delivery paths propagate resultId as the message identity", async () => {
  const calls = [];
  const session = {
    injectMessage: async (...args) => calls.push(["inject", ...args]),
    runQuery: async (...args) => calls.push(["claude", ...args]),
    runQueryWithOptions: async (...args) => calls.push(["codex", ...args]),
  };
  await deliverWorkReviewToSession(
    session, "claude", "result text", "origin-claude", "result-claude", false,
  );
  await deliverWorkReviewToSession(
    session, "codex", "result text", "origin-codex", "result-codex", false,
  );
  await deliverWorkReviewToSession(
    session, "claude", "result text", "origin-busy", "result-busy", true,
  );
  assert.deepEqual(calls, [
    ["claude", "result text", "origin-claude", "result-claude"],
    ["codex", "result text", "origin-codex", { messageId: "result-codex" }],
    ["inject", "result text", "next", "result-busy"],
  ]);
});

test("consolidated result prompt carries actionable item context but no draft", () => {
  const prompt = buildWorkReviewResultPrompt({
    rounds: [{
      roundId: "round-1",
      title: "Production checkout review",
      purpose: "pre-deployment",
      approvalMeaning: "Approval authorizes deployment",
      items: [{
        itemId: "checkout",
        title: "Checkout flow",
        primaryTarget: {
          kind: "url",
          uri: "https://preview.example/checkout",
          label: "Preview",
          environment: "sandbox",
        },
      }],
    }],
  }, {
    resultId: "result-1",
    reviewId: "review-1",
    roundId: "round-1",
    revision: 1,
    publishedAt: "2026-07-29T12:00:00.000Z",
    itemResults: [{ itemId: "checkout", status: "changes_requested", note: "Align total" }],
  });
  assert.match(prompt, /Production checkout review/);
  assert.match(prompt, /Checkout flow/);
  assert.match(prompt, /https:\/\/preview\.example\/checkout/);
  assert.match(prompt, /Approval authorizes deployment/);
  assert.doesNotMatch(prompt, /currentDraft|itemDecisions|"pending"/);
});

test("stable result IDs collapse replayed Claude/history user messages", () => {
  const sessionId = "review-delivery-history";
  const resultId = "result-stable-message-id";
  appendHistory(sessionId, {
    role: "user",
    content: "published result",
    uuid: resultId,
    timestamp: new Date().toISOString(),
  });
  appendHistory(sessionId, {
    role: "user",
    content: "published result",
    uuid: resultId,
    timestamp: new Date().toISOString(),
  });
  const entries = getHistory(sessionId).filter((entry) => entry.uuid === resultId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionSeq, 1);
  assert.equal(entries[0].revision, 2);
});
