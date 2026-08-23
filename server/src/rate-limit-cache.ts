import * as fs from "fs";
import type { Backend } from "./protocol";
import type { RateLimitEventPayload } from "./rate-limit-events";
import { rateLimitWindowForType } from "./rate-limit-events";
import { socketAgentDataPath } from "./socket-agent-paths";

type CachedWindow = "five_hour" | "weekly";
type BackendWindows = Partial<Record<CachedWindow, RateLimitEventPayload>>;
type StoredRateLimits = Partial<Record<Backend, BackendWindows>>;

const RATE_LIMIT_CACHE_FILE = socketAgentDataPath("rate-limits.json");
// Earlier schemas may contain one-percent Codex or Claude /usage values
// mis-normalized and persisted as 100%. Discard them once so fresh harness
// snapshots become authoritative.
const RATE_LIMIT_CACHE_SCHEMA_VERSION = 3;
let memoryCache: StoredRateLimits | null = null;

function cloneEvent(event: RateLimitEventPayload): RateLimitEventPayload {
  return JSON.parse(JSON.stringify(event)) as RateLimitEventPayload;
}

function readCache(): StoredRateLimits {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(RATE_LIMIT_CACHE_FILE, "utf8"));
    memoryCache = parsed
      && typeof parsed === "object"
      && parsed.schemaVersion === RATE_LIMIT_CACHE_SCHEMA_VERSION
      && parsed.backends
      && typeof parsed.backends === "object"
      ? parsed.backends
      : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

function writeCache(cache: StoredRateLimits): void {
  const tempFile = `${RATE_LIMIT_CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify({
    schemaVersion: RATE_LIMIT_CACHE_SCHEMA_VERSION,
    backends: cache,
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, RATE_LIMIT_CACHE_FILE);
}

function eventIsActive(event: RateLimitEventPayload, nowMs: number): boolean {
  if (event.status !== "allowed_warning" && event.status !== "rejected") {
    return false;
  }
  if (!event.resetsAt) return true;
  const resetMs = Date.parse(event.resetsAt);
  return Number.isFinite(resetMs) && resetMs > nowMs;
}

function pruneExpired(cache: StoredRateLimits, nowMs: number): boolean {
  let changed = false;
  for (const backend of ["claude", "codex"] as const) {
    const windows = cache[backend];
    if (!windows) continue;
    for (const window of ["five_hour", "weekly"] as const) {
      const event = windows[window];
      if (event && !eventIsActive(event, nowMs)) {
        delete windows[window];
        changed = true;
      }
    }
    if (Object.keys(windows).length === 0) {
      delete cache[backend];
      changed = true;
    }
  }
  return changed;
}

/**
 * Records a fresh harness event as the source of truth for its exact window.
 * Allowed or already-expired events clear only that backend/window.
 */
export function recordRateLimitEvent(
  event: RateLimitEventPayload,
  nowMs = Date.now(),
): void {
  const cache = readCache();
  pruneExpired(cache, nowMs);
  const window = rateLimitWindowForType(event.rateLimitType);
  const windows = cache[event.backend] ?? {};
  if (eventIsActive(event, nowMs)) {
    windows[window] = {
      ...cloneEvent(event),
      sessionId: "",
    };
    cache[event.backend] = windows;
  } else {
    delete windows[window];
    if (Object.keys(windows).length === 0) {
      delete cache[event.backend];
    } else {
      cache[event.backend] = windows;
    }
  }
  writeCache(cache);
}

export function getCachedRateLimitEvents(
  backend?: Backend,
  sessionId = "",
  nowMs = Date.now(),
): RateLimitEventPayload[] {
  const cache = readCache();
  if (pruneExpired(cache, nowMs)) writeCache(cache);
  const backends: Backend[] = backend ? [backend] : ["claude", "codex"];
  const events: RateLimitEventPayload[] = [];
  for (const currentBackend of backends) {
    const windows = cache[currentBackend];
    if (!windows) continue;
    for (const window of ["five_hour", "weekly"] as const) {
      const event = windows[window];
      if (event) events.push({ ...cloneEvent(event), sessionId });
    }
  }
  return events;
}

/** Test-only reset for module-local state after changing the cache fixture. */
export function resetRateLimitCacheForTests(): void {
  memoryCache = null;
}
