import * as crypto from "crypto";
import type {
  HistoryEntry,
  SessionRunRecord,
  SessionRunOutcome,
  SessionRunStats,
} from "./protocol";
import {
  appendHistory,
  getHistory,
  getSdkRunLifecycleEvents,
  getSession,
  saveSession,
} from "./session-store";
import type { DelegatedAgentRecord } from "./delegated-agent-types";
import { deriveHistoricalRuns } from "./session-run-backfill";

export const SESSION_RUN_BACKFILL_VERSION = 1;

function emptyStats(): SessionRunStats {
  return {
    completedCount: 0,
    totalDurationMs: 0,
  };
}

function normalizedStats(stats?: SessionRunStats): SessionRunStats {
  const completedCount = Math.max(0, Math.trunc(stats?.completedCount || 0));
  const totalDurationMs = Math.max(0, Math.trunc(stats?.totalDurationMs || 0));
  return {
    ...emptyStats(),
    ...stats,
    completedCount,
    totalDurationMs,
    ...(completedCount > 0
      ? { averageDurationMs: Math.round(totalDurationMs / completedCount) }
      : {}),
  };
}

export function hasOutstandingDelegatedRuns(
  records: DelegatedAgentRecord[],
  logicalRunStartedAt: string,
  reportQueueActive = false,
): boolean {
  if (reportQueueActive) return true;
  const startedMs = new Date(logicalRunStartedAt).getTime();
  return records.some((record) => record.runs.some((run) => {
    if (new Date(run.startedAt).getTime() < startedMs) return false;
    if (run.status === "starting" || run.status === "running") return true;
    return run.reportStatus !== "delivered";
  }));
}

export function inferStaleRunCompletion(
  entries: HistoryEntry[],
  startedAt: string,
): { finishedAt: string; outcome: SessionRunOutcome } {
  const startedMs = Date.parse(startedAt);
  let finishedAt = startedAt;
  let finishedMs = Number.isFinite(startedMs) ? startedMs : 0;
  let hasAssistantResponse = false;
  for (const entry of entries) {
    const timestampMs = Date.parse(entry.timestamp || "");
    if (!Number.isFinite(timestampMs)) continue;
    if (Number.isFinite(startedMs) && timestampMs < startedMs) continue;
    if (entry.role === "assistant") hasAssistantResponse = true;
    if (timestampMs >= finishedMs) {
      finishedMs = timestampMs;
      finishedAt = entry.timestamp!;
    }
  }
  return {
    finishedAt,
    outcome: hasAssistantResponse ? "completed" : "failed",
  };
}

export function getSessionRunStats(sessionId: string): SessionRunStats | undefined {
  const stats = getSession(sessionId)?.runStats;
  return stats ? normalizedStats(stats) : undefined;
}

function recordTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameLogicalRun(left: SessionRunRecord, right: SessionRunRecord): boolean {
  const leftStart = recordTime(left.startedAt);
  const rightStart = recordTime(right.startedAt);
  if (Math.abs(leftStart - rightStart) <= 30_000) return true;
  const overlapStart = Math.max(leftStart, rightStart);
  const overlapEnd = Math.min(recordTime(left.finishedAt), recordTime(right.finishedAt));
  const shorter = Math.min(left.durationMs, right.durationMs);
  return overlapEnd > overlapStart && shorter > 0
    && (overlapEnd - overlapStart) / shorter >= 0.8;
}

/**
 * Reconstruct all completed historical runs for one session. Exact observed
 * records always win over SDK reconstruction, which in turn wins over the
 * transcript-only fallback. The migration is versioned and therefore cheap on
 * every subsequent resume/status read.
 */
export function backfillSessionRunStats(
  sessionId: string,
  delegations: DelegatedAgentRecord[] = [],
  force = false,
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const existing = normalizedStats(session.runStats);
  if (!force && (existing.backfillVersion || 0) >= SESSION_RUN_BACKFILL_VERSION) {
    return existing;
  }

  const derived = deriveHistoricalRuns(
    getHistory(sessionId),
    getSdkRunLifecycleEvents(sessionId),
    delegations,
  );
  const currentStartedMs = existing.current
    ? recordTime(existing.current.startedAt)
    : Number.POSITIVE_INFINITY;
  const completedDerived = derived.filter((run) =>
    recordTime(run.finishedAt) < currentStartedMs,
  );
  const observed = (existing.recentRuns || []).map((run) => ({
    ...run,
    source: run.source || "observed" as const,
  }));
  const combined = completedDerived.filter((candidate) =>
    !observed.some((run) => sameLogicalRun(candidate, run)),
  );
  combined.push(...observed);
  combined.sort((left, right) =>
    recordTime(left.startedAt) - recordTime(right.startedAt),
  );

  const numbered = combined.map((run, index) => ({
    ...run,
    runNumber: index + 1,
  }));
  const totalDurationMs = numbered.reduce((sum, run) => sum + run.durationMs, 0);
  const longestDurationMs = numbered.reduce(
    (longest, run) => Math.max(longest, run.durationMs),
    0,
  );
  const shortestDurationMs = numbered.reduce(
    (shortest, run) => Math.min(shortest, run.durationMs),
    Number.POSITIVE_INFINITY,
  );
  const next: SessionRunStats = {
    ...(existing.current ? { current: existing.current } : {}),
    completedCount: numbered.length,
    totalDurationMs,
    ...(numbered.length > 0 ? {
      averageDurationMs: Math.round(totalDurationMs / numbered.length),
      longestDurationMs,
      shortestDurationMs,
      lastCompletedAt: numbered[numbered.length - 1].finishedAt,
      recentRuns: numbered.slice(-500),
    } : {}),
    backfillVersion: SESSION_RUN_BACKFILL_VERSION,
  };
  session.runStats = next;
  saveSession(session);
  return normalizedStats(next);
}

export function beginSessionRun(
  sessionId: string,
  startedAt = new Date().toISOString(),
  runId: string = crypto.randomUUID(),
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const stats = normalizedStats(session.runStats);
  if (!stats.current) {
    stats.current = { runId, startedAt, supervisorSettled: false };
    session.runStats = stats;
    saveSession(session);
  }
  return normalizedStats(stats);
}

export function setSessionRunSupervisorSettled(
  sessionId: string,
  settled: boolean,
  pendingOutcome?: SessionRunOutcome,
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session?.runStats?.current) return session?.runStats;
  const stats = normalizedStats(session.runStats);
  stats.current = {
    ...stats.current!,
    supervisorSettled: settled,
    ...(settled && pendingOutcome ? { pendingOutcome } : {}),
    ...(!settled ? { pendingOutcome: undefined } : {}),
  };
  session.runStats = stats;
  saveSession(session);
  return normalizedStats(stats);
}

export function finishSessionRun(
  sessionId: string,
  outcome: SessionRunOutcome,
  finishedAt = new Date().toISOString(),
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session?.runStats?.current) return session?.runStats;

  const stats = normalizedStats(session.runStats);
  const current = stats.current!;
  const startMs = new Date(current.startedAt).getTime();
  const finishMs = new Date(finishedAt).getTime();
  const durationMs = Math.max(
    0,
    Number.isFinite(startMs) && Number.isFinite(finishMs) ? finishMs - startMs : 0,
  );
  const completedCount = stats.completedCount + 1;
  const totalDurationMs = stats.totalDurationMs + durationMs;
  const next: SessionRunStats = {
    completedCount,
    totalDurationMs,
    averageDurationMs: Math.round(totalDurationMs / completedCount),
    longestDurationMs: stats.longestDurationMs == null
      ? durationMs
      : Math.max(stats.longestDurationMs, durationMs),
    shortestDurationMs: stats.shortestDurationMs == null
      ? durationMs
      : Math.min(stats.shortestDurationMs, durationMs),
    lastCompletedAt: finishedAt,
    recentRuns: [
      ...(stats.recentRuns || []),
      {
        runId: current.runId,
        runNumber: completedCount,
        startedAt: current.startedAt,
        finishedAt,
        durationMs,
        outcome,
        source: "observed" as const,
      },
    ].slice(-500),
    backfillVersion: stats.backfillVersion,
  };
  session.runStats = next;
  saveSession(session);

  appendHistory(sessionId, {
    role: "run_boundary",
    content: "Run finished",
    timestamp: finishedAt,
    runId: current.runId,
    runNumber: completedCount,
    runStartedAt: current.startedAt,
    runFinishedAt: finishedAt,
    runDurationMs: durationMs,
    runOutcome: outcome,
  });
  return normalizedStats(next);
}
