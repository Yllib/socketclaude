import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export interface RecoveryRun {
  sessionId: string;
  id: string;
  state: "active" | "pending" | "failed";
  attempts: number;
  nextAttemptAt: number;
  error?: string;
}

/** One process owns this journal. Never replay the original prompt: an
 * interrupted tool may already have performed its external side effect. */
export const RESTART_CONTINUATION_PROMPT = "[System: SocketAgent restarted while this session was working. Continue the interrupted task using the existing conversation and saved state. A tool or external action may have completed before shutdown without its result being recorded. Check the actual state before repeating commands, sends, purchases, or deployments. Do not repeat completed work. If an action's outcome cannot be checked safely, ask the user. Preserve the user's existing scope and approvals.]";

export class RestartRecoveryStore {
  private runs = new Map<string, RecoveryRun>();
  private completed: string[] = [];

  constructor(private readonly file: string) {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.runs)) throw new Error("Invalid restart recovery journal");
    this.completed = Array.isArray(data.completed) ? data.completed.slice(-1000) : [];
    for (const run of data.runs) {
      if (typeof run.sessionId !== "string" || typeof run.id !== "string"
          || !["active", "pending", "failed"].includes(run.state)) {
        throw new Error("Invalid restart recovery run");
      }
      // An active run belonged to the previous process, not this one.
      this.runs.set(run.sessionId, { ...run, state: run.state === "active" ? "pending" : run.state });
    }
    this.save();
  }

  private save(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, runs: [...this.runs.values()], completed: this.completed }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(dir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }

  list(): RecoveryRun[] { return [...this.runs.values()].map(run => ({ ...run })); }
  get(sessionId: string): RecoveryRun | undefined {
    const run = this.runs.get(sessionId);
    return run ? { ...run } : undefined;
  }
  wasCompleted(id: string): boolean { return this.completed.includes(id); }

  start(sessionId: string, id: string = randomUUID()): string {
    const previous = this.runs.get(sessionId);
    if (previous) this.rememberCompleted(previous.id);
    this.runs.set(sessionId, { sessionId, id, state: "active", attempts: 0, nextAttemptAt: 0 });
    this.save();
    return id;
  }

  rekey(previousSessionId: string, nextSessionId: string, id: string): void {
    const run = this.runs.get(previousSessionId);
    if (!run || run.id !== id || previousSessionId === nextSessionId) return;
    if (this.runs.has(nextSessionId)) throw new Error("Recovery destination already has a run");
    this.runs.delete(previousSessionId);
    this.runs.set(nextSessionId, { ...run, sessionId: nextSessionId });
    this.save();
  }

  claim(sessionId: string, id: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || run.id !== id || run.state !== "pending") return false;
    run.state = "active";
    run.attempts++;
    this.save();
    return true;
  }

  retry(sessionId: string, id: string, error: string, now = Date.now()): void {
    const run = this.runs.get(sessionId);
    if (!run || run.id !== id) return;
    run.error = error.slice(0, 500);
    run.state = run.attempts >= 5 ? "failed" : "pending";
    run.nextAttemptAt = now + Math.min(60_000, 1000 * 2 ** run.attempts);
    this.save();
  }

  private rememberCompleted(id: string): void {
    this.completed.push(id);
    this.completed = this.completed.slice(-1000);
  }

  complete(sessionId: string, id: string): void {
    if (this.runs.get(sessionId)?.id !== id) return;
    this.runs.delete(sessionId);
    this.rememberCompleted(id);
    this.save();
  }
}

export async function boundedRecoverySetup<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Recovery backend setup timed out")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class RestartRecoveryWorker {
  private starting = new Set<string>();
  constructor(private readonly store: RestartRecoveryStore, private readonly hooks: {
    ready(): boolean;
    exists(sessionId: string): boolean;
    stopped(sessionId: string): boolean;
    busy(sessionId: string): boolean;
    launch(run: RecoveryRun): Promise<void>;
    notice(sessionId: string, message: string): void;
    skipped?(sessionId: string): void;
  }) {}

  tick(now = Date.now()): void {
    if (!this.hooks.ready()) return;
    for (const run of this.store.list()) {
      if (run.state !== "pending" || run.nextAttemptAt > now) continue;
      if (this.starting.size >= 3) break;
      if (this.starting.has(run.sessionId)) continue;
      if (!this.hooks.exists(run.sessionId) || this.hooks.stopped(run.sessionId)) {
        this.store.complete(run.sessionId, run.id);
        this.hooks.skipped?.(run.sessionId);
        continue;
      }
      if (this.hooks.busy(run.sessionId)) continue;
      if (!this.store.claim(run.sessionId, run.id)) continue;
      this.starting.add(run.sessionId);
      void Promise.resolve().then(() => this.hooks.launch(run)).catch(error => {
        this.store.retry(run.sessionId, run.id, String(error?.message || error));
        const failed = this.store.get(run.sessionId)?.state === "failed";
        this.hooks.notice(run.sessionId, failed
          ? "Could not resume after five attempts. Send a message to retry."
          : "Could not start the backend. Recovery will retry automatically.");
      }).finally(() => this.starting.delete(run.sessionId));
    }
  }
}
