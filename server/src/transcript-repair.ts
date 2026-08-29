import * as crypto from "crypto";
import type { HistoryEntry } from "./protocol";
import { createInteractiveRequestId } from "./interactive-request-id";

export interface TranscriptIdentityRepairResult {
  entries: HistoryEntry[];
  changed: boolean;
  rebased: boolean;
  collisions: number;
  collapsed: number;
  rekeyedQuestions: number;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function historyIdentityKey(entry: HistoryEntry): string | null {
  if (entry.streamId) {
    const streamRole = entry.thinking ? `${entry.role}_thinking` : entry.role;
    return `${streamRole}:stream:${entry.streamId}`;
  }
  if (entry.toolUseId && ["tool_call", "tool_result", "tool_image"].includes(entry.role)) {
    return `${entry.role}:tool:${entry.toolUseId}`;
  }
  if (entry.questionId) return `${entry.role}:question:${entry.questionId}`;
  if (entry.role === "user" && entry.uuid) return `user:uuid:${entry.uuid}`;
  if (entry.role === "monitor" && entry.taskId) return `monitor:${entry.taskId}`;
  if (entry.role === "browser_session" && entry.toolInput?.profile) {
    return `browser_session:${String(entry.toolInput.profile)}`;
  }
  if (entry.role === "task_state" && entry.taskId) {
    return `task_state:${entry.taskKind || "background"}:${entry.taskId}`;
  }
  if (entry.role === "work_review" && entry.reviewId) {
    return `work_review:${entry.reviewId}`;
  }
  return null;
}

function interactiveFingerprint(entry: HistoryEntry): string | null {
  if (entry.role === "question" || entry.role === "elicitation_url") {
    return JSON.stringify({
      role: entry.role,
      content: entry.content || "",
      questions: entry.questions || [],
      url: entry.url || "",
      mcpServerName: entry.mcpServerName || "",
    });
  }
  if (entry.role === "secure_input") {
    return JSON.stringify({
      role: entry.role,
      content: entry.content || "",
      label: entry.toolInput?.label || "",
      reason: entry.toolInput?.reason || "",
      envHint: entry.toolInput?.envHint || "",
      scope: entry.toolInput?.scope || "",
    });
  }
  return null;
}

export function sameLogicalTranscriptEntry(first: HistoryEntry, second: HistoryEntry): boolean {
  if (first.role !== second.role) return false;
  const firstKey = historyIdentityKey(first);
  const secondKey = historyIdentityKey(second);
  if (!firstKey || firstKey !== secondKey) return false;
  const firstFingerprint = interactiveFingerprint(first);
  const secondFingerprint = interactiveFingerprint(second);
  if (firstFingerprint !== null || secondFingerprint !== null) {
    return firstFingerprint === secondFingerprint;
  }
  return true;
}

function timestampMs(entry: HistoryEntry): number {
  const value = Date.parse(entry.timestamp || "");
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function insertByTimestamp(entries: HistoryEntry[], entry: HistoryEntry): void {
  const target = timestampMs(entry);
  let index = entries.length;
  for (let cursor = entries.length - 1; cursor >= 0; cursor--) {
    if (timestampMs(entries[cursor]) <= target) {
      index = cursor + 1;
      break;
    }
    index = cursor;
  }
  entries.splice(index, 0, entry);
}

/**
 * Repair identities produced by old resettable question counters or
 * append-only card revisions. Positional repairs rebase above the old maximum,
 * forcing clients with poisoned cached sequences to request a clean snapshot.
 */
export function repairTranscriptIdentityCollisions(
  source: HistoryEntry[],
): TranscriptIdentityRepairResult {
  const entries = source.map((entry) => ({ ...entry }));
  let changed = false;
  let collisions = 0;
  let collapsed = 0;
  let rekeyedQuestions = 0;

  const firstQuestionById = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    if ((entry.role !== "question" && entry.role !== "elicitation_url") || !entry.questionId) continue;
    const first = firstQuestionById.get(entry.questionId);
    if (!first) {
      firstQuestionById.set(entry.questionId, entry);
      continue;
    }
    const samePersistedPosition = !!entry.entryId
      && entry.entryId === first.entryId
      && positiveInteger(entry.sessionSeq) === positiveInteger(first.sessionSeq);
    if (samePersistedPosition && interactiveFingerprint(first) === interactiveFingerprint(entry)) {
      // This is another persisted revision of the same card. The positional
      // pass below will collapse it without changing the request identity.
      continue;
    }
    entry.questionId = createInteractiveRequestId("repaired_question");
    entry.answered = true;
    entry.status ||= "interrupted";
    rekeyedQuestions++;
    changed = true;
  }

  const maxOriginalSeq = entries.reduce(
    (max, entry) => Math.max(max, positiveInteger(entry.sessionSeq) || 0),
    0,
  );
  const output: HistoryEntry[] = [];
  const relocated: HistoryEntry[] = [];
  const indexByEntryId = new Map<string, number>();
  const indexBySessionSeq = new Map<number, number>();

  for (const entry of entries) {
    const entryIdIndex = entry.entryId ? indexByEntryId.get(entry.entryId) : undefined;
    const sequence = positiveInteger(entry.sessionSeq);
    const sequenceIndex = sequence ? indexBySessionSeq.get(sequence) : undefined;
    const collisionIndex = entryIdIndex ?? sequenceIndex;
    if (collisionIndex === undefined) {
      const index = output.length;
      output.push(entry);
      if (entry.entryId) indexByEntryId.set(entry.entryId, index);
      if (sequence) indexBySessionSeq.set(sequence, index);
      continue;
    }

    const existing = output[collisionIndex];
    if (sameLogicalTranscriptEntry(existing, entry)) {
      output[collisionIndex] = {
        ...entry,
        entryId: existing.entryId,
        sessionSeq: existing.sessionSeq,
        revision: Math.max(
          positiveInteger(entry.revision) || 1,
          (positiveInteger(existing.revision) || 1) + 1,
        ),
      };
      collapsed++;
    } else {
      relocated.push({
        ...entry,
        entryId: crypto.randomUUID(),
        sessionSeq: undefined,
        revision: 1,
      });
      collisions++;
    }
    changed = true;
  }

  for (const entry of relocated) insertByTimestamp(output, entry);

  const rebased = collisions > 0 || collapsed > 0;
  if (rebased) {
    const base = maxOriginalSeq + 1;
    const usedEntryIds = new Set<string>();
    for (let index = 0; index < output.length; index++) {
      const entry = output[index];
      if (!entry.entryId || usedEntryIds.has(entry.entryId)) entry.entryId = crypto.randomUUID();
      usedEntryIds.add(entry.entryId);
      entry.sessionSeq = base + index;
      entry.revision = positiveInteger(entry.revision) || 1;
    }
  }

  return { entries: output, changed, rebased, collisions, collapsed, rekeyedQuestions };
}
