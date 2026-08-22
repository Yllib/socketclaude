import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";
import {
  getSessionCompactionCount,
  rememberHistoryContext,
  rememberRecentRuns,
} from "./session-store";

export type SessionMemoryKind =
  | "active_work"
  | "decision"
  | "constraint"
  | "preference"
  | "project_fact"
  | "open_question";

export interface SessionMemoryEntry {
  id: string;
  kind: SessionMemoryKind;
  text: string;
  pinned: boolean;
  status: "active" | "superseded";
  sourceSessionSeq?: number;
  sourceEntryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemorySettings {
  autoRollover: boolean;
  maxCompactions: number;
  maxPostCompactionTokens: number;
  recentRuns: number;
}

export interface SessionMemoryEpoch {
  number: number;
  nativeSessionId: string;
  startedAt: string;
  endedAt?: string;
  rolloverReason?: string;
  startingTokens?: number;
  endingTokens?: number;
  compactions: number;
}

export interface SessionMemoryState {
  version: 1;
  sessionId: string;
  entries: SessionMemoryEntry[];
  settings: SessionMemorySettings;
  epochs: SessionMemoryEpoch[];
  currentTokens: number;
  contextWindow: number;
  compactionsSinceRollover: number;
  lastCompactionAt?: string;
  lastCompactionPreTokens?: number;
  lastPostCompactionTokens?: number;
  awaitingPostCompactionMeasurement: boolean;
  rolloverPending: boolean;
  rolloverReason?: string;
  historicalCompactionsSeeded: boolean;
  updatedAt: string;
}

const MEMORY_DIR = path.join(socketAgentDataPath(), "session-memory");
const DEFAULT_SETTINGS: SessionMemorySettings = {
  autoRollover: true,
  maxCompactions: 3,
  maxPostCompactionTokens: 90_000,
  recentRuns: 3,
};
const SESSION_MEMORY_KINDS = new Set<SessionMemoryKind>([
  "active_work",
  "decision",
  "constraint",
  "preference",
  "project_fact",
  "open_question",
]);
const cache = new Map<string, SessionMemoryState>();
const flushTimers = new Map<string, NodeJS.Timeout>();

function now(): string {
  return new Date().toISOString();
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function memoryPath(sessionId: string): string {
  return path.join(MEMORY_DIR, `${safeId(sessionId)}.json`);
}

function cloneState(state: SessionMemoryState): SessionMemoryState {
  return structuredClone(state);
}

function defaultState(sessionId: string): SessionMemoryState {
  const createdAt = now();
  const historicalCompactions = getSessionCompactionCount(sessionId);
  const rolloverPending = historicalCompactions >= DEFAULT_SETTINGS.maxCompactions;
  return {
    version: 1,
    sessionId,
    entries: [],
    settings: { ...DEFAULT_SETTINGS },
    epochs: [{
      number: 1,
      nativeSessionId: sessionId,
      startedAt: createdAt,
      compactions: historicalCompactions,
    }],
    currentTokens: 0,
    contextWindow: 0,
    compactionsSinceRollover: historicalCompactions,
    awaitingPostCompactionMeasurement: false,
    rolloverPending,
    ...(rolloverPending
      ? { rolloverReason: `${historicalCompactions} existing compactions exceed the configured limit` }
      : {}),
    historicalCompactionsSeeded: true,
    updatedAt: createdAt,
  };
}

function normalizeState(sessionId: string, value: Partial<SessionMemoryState>): SessionMemoryState {
  const base = defaultState(sessionId);
  const entries = Array.isArray(value.entries)
    ? value.entries.filter((entry): entry is SessionMemoryEntry =>
      !!entry && typeof entry.id === "string" && typeof entry.text === "string")
    : [];
  const epochs = Array.isArray(value.epochs) && value.epochs.length > 0
    ? value.epochs
    : base.epochs;
  const state: SessionMemoryState = {
    ...base,
    ...value,
    version: 1,
    sessionId,
    entries,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(value.settings || {}),
    },
    epochs,
  };
  if (value.historicalCompactionsSeeded !== true && state.epochs.length === 1) {
    const historicalCompactions = getSessionCompactionCount(sessionId);
    state.compactionsSinceRollover = Math.max(
      state.compactionsSinceRollover,
      historicalCompactions,
    );
    state.epochs[0].compactions = state.compactionsSinceRollover;
    if (
      state.settings.autoRollover
      && state.compactionsSinceRollover >= state.settings.maxCompactions
    ) {
      state.rolloverPending = true;
      state.rolloverReason = `${state.compactionsSinceRollover} existing compactions exceed the configured limit`;
    }
  }
  state.historicalCompactionsSeeded = true;
  return state;
}

function readState(sessionId: string): SessionMemoryState {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  let state = defaultState(sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath(sessionId), "utf8"));
    state = normalizeState(sessionId, parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[SessionMemory] Could not read ${sessionId}: ${String(error)}`);
    }
  }
  cache.set(sessionId, state);
  return state;
}

function flushState(sessionId: string): void {
  const timer = flushTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  flushTimers.delete(sessionId);
  const state = cache.get(sessionId);
  if (!state) return;
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const target = memoryPath(sessionId);
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
}

function scheduleFlush(sessionId: string): void {
  if (flushTimers.has(sessionId)) return;
  const timer = setTimeout(() => flushState(sessionId), 750);
  timer.unref?.();
  flushTimers.set(sessionId, timer);
}

function mutateState(
  sessionId: string,
  mutation: (state: SessionMemoryState) => void,
  immediate = false,
): SessionMemoryState {
  const state = readState(sessionId);
  mutation(state);
  state.updatedAt = now();
  if (immediate) flushState(sessionId);
  else scheduleFlush(sessionId);
  return cloneState(state);
}

export function getSessionMemoryState(sessionId: string): SessionMemoryState {
  return cloneState(readState(sessionId));
}

export function upsertSessionMemoryEntry(
  sessionId: string,
  input: {
    id?: string;
    kind: SessionMemoryKind;
    text: string;
    pinned?: boolean;
    status?: "active" | "superseded";
    sourceSessionSeq?: number;
    sourceEntryId?: string;
  },
): SessionMemoryState {
  const text = input.text.trim();
  if (!text) throw new Error("Memory text is required");
  if (text.length > 20_000) throw new Error("Memory text is limited to 20,000 characters");
  if (!SESSION_MEMORY_KINDS.has(input.kind)) throw new Error("Memory kind is invalid");
  const timestamp = now();
  return mutateState(sessionId, (state) => {
    const existing = input.id
      ? state.entries.find((entry) => entry.id === input.id)
      : undefined;
    if (existing) {
      existing.kind = input.kind;
      existing.text = text;
      existing.pinned = input.pinned ?? existing.pinned;
      existing.status = input.status ?? existing.status;
      existing.sourceSessionSeq = input.sourceSessionSeq;
      existing.sourceEntryId = input.sourceEntryId;
      existing.updatedAt = timestamp;
      return;
    }
    state.entries.push({
      id: input.id || crypto.randomUUID(),
      kind: input.kind,
      text,
      pinned: input.pinned ?? false,
      status: input.status ?? "active",
      ...(input.sourceSessionSeq ? { sourceSessionSeq: input.sourceSessionSeq } : {}),
      ...(input.sourceEntryId ? { sourceEntryId: input.sourceEntryId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }, true);
}

export function deleteSessionMemoryEntry(sessionId: string, entryId: string): SessionMemoryState {
  return mutateState(sessionId, (state) => {
    const next = state.entries.filter((entry) => entry.id !== entryId);
    if (next.length === state.entries.length) throw new Error("Memory entry was not found");
    state.entries = next;
  }, true);
}

export function updateSessionMemorySettings(
  sessionId: string,
  patch: Partial<SessionMemorySettings>,
): SessionMemoryState {
  return mutateState(sessionId, (state) => {
    state.settings = {
      autoRollover: patch.autoRollover ?? state.settings.autoRollover,
      maxCompactions: Math.max(1, Math.min(20,
        Math.floor(patch.maxCompactions ?? state.settings.maxCompactions))),
      maxPostCompactionTokens: Math.max(20_000, Math.min(500_000,
        Math.floor(patch.maxPostCompactionTokens ?? state.settings.maxPostCompactionTokens))),
      recentRuns: Math.max(1, Math.min(10,
        Math.floor(patch.recentRuns ?? state.settings.recentRuns))),
    };
  }, true);
}

export function recordSessionMemoryCompaction(sessionId: string, preTokens: number): void {
  mutateState(sessionId, (state) => {
    state.compactionsSinceRollover += 1;
    state.lastCompactionAt = now();
    state.lastCompactionPreTokens = Math.max(0, Math.floor(preTokens));
    state.awaitingPostCompactionMeasurement = true;
    const epoch = state.epochs.at(-1);
    if (epoch) epoch.compactions = state.compactionsSinceRollover;
    if (
      state.settings.autoRollover
      && state.compactionsSinceRollover >= state.settings.maxCompactions
    ) {
      state.rolloverPending = true;
      state.rolloverReason = `${state.compactionsSinceRollover} compactions reached the configured limit`;
    }
  });
}

export function recordSessionMemoryContextUsage(
  sessionId: string,
  currentTokens: number,
  contextWindow: number,
): void {
  mutateState(sessionId, (state) => {
    state.currentTokens = Math.max(0, Math.floor(currentTokens));
    state.contextWindow = Math.max(0, Math.floor(contextWindow));
    const epoch = state.epochs.at(-1);
    if (epoch && epoch.startingTokens === undefined && state.currentTokens > 0) {
      epoch.startingTokens = state.currentTokens;
    }
    if (!state.awaitingPostCompactionMeasurement) return;
    state.awaitingPostCompactionMeasurement = false;
    state.lastPostCompactionTokens = state.currentTokens;
    if (
      state.settings.autoRollover
      && state.currentTokens >= state.settings.maxPostCompactionTokens
    ) {
      state.rolloverPending = true;
      state.rolloverReason = `post-compaction context remained at ${state.currentTokens.toLocaleString()} tokens`;
    }
  });
}

export function requestSessionMemoryRollover(
  sessionId: string,
  reason = "manual rollover requested",
): SessionMemoryState {
  return mutateState(sessionId, (state) => {
    state.rolloverPending = true;
    state.rolloverReason = reason;
  }, true);
}

export function shouldRolloverSessionMemory(sessionId: string): boolean {
  return readState(sessionId).rolloverPending;
}

function clipped(value: unknown, limit: number): string {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 18))}\n[content clipped]`;
}

function recentRunContext(sessionId: string, limit: number): string[] {
  const runs = rememberRecentRuns(sessionId, limit).reverse();
  return runs.map(({ prompt, boundary }, index) => {
    let finalReply = "";
    if (boundary?.sessionSeq) {
      const context = rememberHistoryContext(sessionId, boundary.sessionSeq, 12, 0);
      const assistant = [...context].reverse().find((entry) =>
        entry.role === "assistant"
        && !String(entry.content || "").startsWith("[compact_boundary:"));
      finalReply = clipped(assistant?.content, 5_000);
    }
    return [
      `Run ${index + 1}`,
      `User: ${clipped(prompt.content, 3_000)}`,
      finalReply ? `Agent: ${finalReply}` : "Agent: final reply unavailable in the bounded run summary",
      boundary?.runOutcome ? `Outcome: ${boundary.runOutcome}` : "",
      `History sequence: ${prompt.sessionSeq || "unknown"}`,
    ].filter(Boolean).join("\n");
  });
}

export function buildSessionMemoryContinuityContext(sessionId: string, cwd: string): string {
  const state = readState(sessionId);
  const kindOrder: SessionMemoryKind[] = [
    "active_work",
    "constraint",
    "decision",
    "preference",
    "project_fact",
    "open_question",
  ];
  const activeEntries = state.entries
    .filter((entry) => entry.status === "active")
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind);
    });
  const memoryLines = activeEntries.map((entry) => {
    const source = entry.sourceSessionSeq ? ` source_session_seq=${entry.sourceSessionSeq}` : "";
    return `- [${entry.kind}]${entry.pinned ? " [pinned]" : ""}${source} ${clipped(entry.text, 4_000)}`;
  });
  const runs = recentRunContext(sessionId, state.settings.recentRuns);
  const epoch = state.epochs.at(-1);
  return [
    "This is an automatic SocketAgent context rollover inside the same visible session.",
    "Treat the current user message as a continuation, not a new project.",
    `Project directory: ${cwd}`,
    `Previous native thread: ${sessionId}`,
    `Previous epoch: ${epoch?.number || 1}`,
    "The complete transcript remains available through the Remember tool under the current SocketAgent session.",
    "Before asking the user to repeat prior context or claiming something was forgotten, search Remember.",
    "Inspect current files and git state before relying on remembered implementation details.",
    "",
    "Durable session memory:",
    memoryLines.length > 0 ? memoryLines.join("\n") : "- No user-managed memory entries have been saved yet.",
    "",
    `Recent ${runs.length} logical runs:`,
    runs.length > 0 ? runs.join("\n\n") : "No completed recent runs were found.",
  ].join("\n").slice(0, 60_000);
}

export function remapSessionMemory(
  oldSessionId: string,
  newSessionId: string,
): SessionMemoryState {
  const oldState = readState(oldSessionId);
  const timestamp = now();
  const currentEpoch = oldState.epochs.at(-1);
  if (currentEpoch && !currentEpoch.endedAt) {
    currentEpoch.endedAt = timestamp;
    currentEpoch.endingTokens = oldState.currentTokens;
    currentEpoch.rolloverReason = oldState.rolloverReason || "context rollover";
  }
  oldState.sessionId = newSessionId;
  oldState.epochs.push({
    number: (currentEpoch?.number || 0) + 1,
    nativeSessionId: newSessionId,
    startedAt: timestamp,
    compactions: 0,
  });
  oldState.currentTokens = 0;
  oldState.contextWindow = 0;
  oldState.compactionsSinceRollover = 0;
  oldState.awaitingPostCompactionMeasurement = false;
  oldState.rolloverPending = false;
  delete oldState.rolloverReason;
  oldState.historicalCompactionsSeeded = true;
  oldState.updatedAt = timestamp;

  const oldTimer = flushTimers.get(oldSessionId);
  if (oldTimer) clearTimeout(oldTimer);
  flushTimers.delete(oldSessionId);
  cache.delete(oldSessionId);
  cache.set(newSessionId, oldState);
  flushState(newSessionId);
  if (oldSessionId !== newSessionId) fs.rmSync(memoryPath(oldSessionId), { force: true });
  return cloneState(oldState);
}
