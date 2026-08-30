import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export type CodexAppServerSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexAppServerApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";

export type CodexAppServerApprovalsReviewer =
  | "user"
  | "auto_review"
  | "guardian_subagent";

export type CodexAppServerUserInput =
  | {
      type: "text";
      text: string;
      text_elements?: unknown[];
    }
  | {
      type: "skill";
      name: string;
      path: string;
    };

export interface CodexAppServerClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface CodexAppServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  shell?: boolean;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  stderrTailBytes?: number;
}

export interface CodexAppServerInitializeParams {
  clientInfo: CodexAppServerClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    requestAttestation?: boolean;
    [key: string]: unknown;
  };
}

export interface CodexAppServerThreadStartParams {
  cwd: string;
  sandbox?: CodexAppServerSandbox;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  model?: string;
  config?: unknown;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  [key: string]: unknown;
}

export interface CodexAppServerThreadResumeParams {
  threadId: string;
  cwd?: string;
  sandbox?: CodexAppServerSandbox;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  model?: string;
  config?: unknown;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  /**
   * Resume the runtime without serializing every historical turn into the
   * response. SocketAgent hydrates chat history through its own paginated
   * store, so returning the native transcript is both redundant and
   * prohibitively expensive for long-running sessions.
   */
  excludeTurns?: boolean;
  [key: string]: unknown;
}

export interface CodexAppServerTurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: CodexAppServerUserInput[];
  model: string;
  cwd?: string;
  collaborationMode?: unknown;
  [key: string]: unknown;
}

export interface CodexAppServerTurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  expectedTurnId: string;
  input: CodexAppServerUserInput[];
  responsesapiClientMetadata?: Record<string, unknown> | null;
}

export interface CodexAppServerTurnInterruptParams {
  threadId: string;
  turnId?: string;
}

export interface CodexAppServerThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface CodexAppServerThreadListParams {
  archived?: boolean | null;
  cursor?: string | null;
  cwd?: string | string[] | null;
  limit?: number | null;
  modelProviders?: string[] | null;
  searchTerm?: string | null;
  sortDirection?: "asc" | "desc" | null;
  sortKey?: "created_at" | "updated_at" | null;
  sourceKinds?: string[] | null;
  useStateDbOnly?: boolean;
}

export interface CodexAppServerThreadLoadedListParams {
  cursor?: string | null;
  limit?: number | null;
}

export interface CodexAppServerNotification<T = unknown> {
  method: string;
  params: T;
}

interface WireResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

interface WireServerRequest {
  id: number;
  method: string;
  params?: unknown;
}

export type CodexAppServerRequestResponder = (response:
  | { result: unknown; error?: never }
  | { error: unknown; result?: never }
) => void;

interface PendingRequest<T> {
  method: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`codex app-server request timed out: ${method}`);
    this.name = "CodexAppServerRequestTimeoutError";
  }
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest<unknown>>();
  private stdoutTail = "";
  private stderrTail = "";
  private closed = false;

  constructor(private readonly options: CodexAppServerOptions) {
    super();
  }

  get isRunning(): boolean {
    return !!this.proc && !this.proc.killed && !this.closed;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.proc) return;
    this.closed = false;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    this.proc = spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      detached: process.platform !== "win32",
      shell: this.options.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrTail += chunk;
      const max = this.options.stderrTailBytes ?? 64 * 1024;
      if (this.stderrTail.length > max) this.stderrTail = this.stderrTail.slice(-max);
      this.emit("stderr", chunk);
    });

    this.proc.on("error", (err) => {
      this.rejectAll(err);
      this.emit("error", err);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      try { this.proc?.unref(); } catch {}
      try { this.proc?.stdin.destroy(); } catch {}
      try { this.proc?.stdout.destroy(); } catch {}
      try { this.proc?.stderr.destroy(); } catch {}
      this.proc = null;
      this.rejectAll(new Error(`codex app-server exited code=${code} signal=${signal}`));
      this.emit("exit", code, signal);
    });
  }

  async initialize(params: CodexAppServerInitializeParams): Promise<unknown> {
    return this.request("initialize", params, this.options.startupTimeoutMs);
  }

  async startThread(params: CodexAppServerThreadStartParams): Promise<unknown> {
    return this.request("thread/start", params);
  }

  async resumeThread(params: CodexAppServerThreadResumeParams): Promise<unknown> {
    return this.request("thread/resume", {
      ...params,
      excludeTurns: params.excludeTurns ?? true,
    });
  }

  async unsubscribeThread(threadId: string): Promise<unknown> {
    return this.request("thread/unsubscribe", { threadId });
  }

  async forkThread(params: CodexAppServerThreadResumeParams): Promise<unknown> {
    return this.request("thread/fork", params);
  }

  async startTurn(params: CodexAppServerTurnStartParams): Promise<unknown> {
    return this.request("turn/start", params);
  }

  async steerTurn(params: CodexAppServerTurnSteerParams): Promise<unknown> {
    return this.request("turn/steer", params);
  }

  async interruptTurn(params: CodexAppServerTurnInterruptParams): Promise<unknown> {
    return this.request("turn/interrupt", params);
  }

  async archiveThread(threadId: string): Promise<unknown> {
    return this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<unknown> {
    return this.request("thread/unarchive", { threadId });
  }

  async compactThread(threadId: string): Promise<unknown> {
    return this.request("thread/compact/start", { threadId });
  }

  async getGoal(threadId: string): Promise<unknown> {
    return this.request("thread/goal/get", { threadId });
  }

  async setGoal(threadId: string, params: { objective?: string; status?: string; tokenBudget?: number | null }): Promise<unknown> {
    return this.request("thread/goal/set", { threadId, ...params });
  }

  async clearGoal(threadId: string): Promise<unknown> {
    return this.request("thread/goal/clear", { threadId });
  }

  async startReview(threadId: string, instructions?: string): Promise<unknown> {
    const target = instructions && instructions.trim()
      ? { type: "custom", instructions: instructions.trim() }
      : { type: "uncommittedChanges" };
    return this.request("review/start", { threadId, target, delivery: "inline" });
  }

  async listMcpServerStatus(threadId?: string): Promise<unknown> {
    return this.request("mcpServerStatus/list", { threadId, limit: 50 });
  }

  async listModels(): Promise<unknown> {
    return this.request("model/list", { limit: 50 });
  }

  async readConfig(cwd?: string): Promise<unknown> {
    return this.request("config/read", { cwd, includeLayers: false });
  }

  async readAccount(refreshToken = false): Promise<unknown> {
    return this.request("account/read", { refreshToken });
  }

  async readAccountRateLimits(): Promise<unknown> {
    return this.request("account/rateLimits/read", {});
  }

  async readAccountUsage(): Promise<unknown> {
    return this.request("account/usage/read", {});
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<unknown> {
    return this.request("thread/rollback", { threadId, numTurns });
  }

  async readThread(params: CodexAppServerThreadReadParams): Promise<unknown> {
    return this.request("thread/read", params);
  }

  async listThreads(params: CodexAppServerThreadListParams = {}): Promise<unknown> {
    return this.request("thread/list", params);
  }

  async listLoadedThreads(params: CodexAppServerThreadLoadedListParams = {}): Promise<unknown> {
    return this.request("thread/loaded/list", params);
  }

  async setThreadName(threadId: string, name: string): Promise<unknown> {
    return this.request("thread/name/set", { threadId, name });
  }

  async listCollaborationModes(): Promise<unknown> {
    return this.request("collaborationMode/list", {});
  }

  async request<T = unknown>(
    method: string,
    params: object | undefined,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    this.start();
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }

    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params: params ?? {} });
    this.proc.stdin.write(line + "\n");

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });
  }

  async stop(
    signal: NodeJS.Signals = "SIGTERM",
    forceKillMs = 3000,
    requireConfirmedExit = false,
  ): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    if (this.closed) {
      try { proc.stdin.destroy(); } catch {}
      try { proc.stdout.destroy(); } catch {}
      try { proc.stderr.destroy(); } catch {}
      this.proc = null;
      return;
    }

    const killProcessTree = (nextSignal: NodeJS.Signals) => {
      if (process.platform === "win32" && nextSignal === "SIGKILL" && proc.pid) {
        const result = spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        if (result.status === 0) return;
      }
      if (process.platform !== "win32" && proc.pid) {
        try {
          process.kill(-proc.pid, nextSignal);
          return;
        } catch {
          // Fall back to the direct child below.
        }
      }
      try {
        proc.kill(nextSignal);
      } catch {
        // Ignore cleanup races.
      }
    };

    await new Promise<void>((resolve, reject) => {
      let exited = false;
      let finished = false;
      let forceTimer: NodeJS.Timeout | null = null;
      let abandonTimer: NodeJS.Timeout | null = null;
      const done = (confirmedExit: boolean) => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (abandonTimer) clearTimeout(abandonTimer);
        if (!confirmedExit && requireConfirmedExit) {
          reject(new Error(`codex app-server process tree ${proc.pid ?? "unknown"} did not exit after SIGKILL`));
          return;
        }
        this.closed = true;
        this.proc = null;
        try { proc.unref(); } catch {}
        try { proc.removeAllListeners(); } catch {}
        try { proc.stdin.destroy(); } catch {}
        try { proc.stdout.destroy(); } catch {}
        try { proc.stderr.destroy(); } catch {}
        resolve();
      };
      forceTimer = setTimeout(() => {
        if (!exited) killProcessTree("SIGKILL");
      }, forceKillMs);
      abandonTimer = setTimeout(() => done(false), forceKillMs + 2000);
      proc.once("exit", () => {
        exited = true;
        done(true);
      });
      try {
        proc.stdin.end();
      } catch {
        // Ignore cleanup races.
      }
      killProcessTree(signal);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutTail += chunk;
    const lines = this.stdoutTail.split("\n");
    this.stdoutTail = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.emit("malformed", line, err);
        continue;
      }

      if (this.isServerRequest(msg)) {
        this.handleServerRequest(msg);
        continue;
      }

      if (this.isResponse(msg)) {
        this.handleResponse(msg);
        continue;
      }

      if (this.isNotification(msg)) {
        this.emit("notification", { method: msg.method, params: msg.params });
        // EventEmitter treats "error" as a reserved event that throws
        // (ERR_UNHANDLED_ERROR) when no listener is registered. Codex sends
        // "error" notifications (e.g. usageLimitExceeded / systemError), so
        // re-emitting one on the reserved channel would crash the whole server.
        // It is already delivered via the "notification" event above; expose it
        // on a safe channel instead of the reserved one.
        if (msg.method === "error") {
          this.emit("errorNotification", msg.params);
        } else {
          this.emit(msg.method, msg.params);
        }
        continue;
      }

      this.emit("unknown", msg);
    }
  }

  private handleResponse(msg: WireResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.emit("orphanResponse", msg);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(this.formatProtocolError(pending.method, msg.error)));
    } else {
      pending.resolve(msg.result);
    }
    this.emit("response", pending.method, msg);
  }

  private handleServerRequest(msg: WireServerRequest): void {
    let responded = false;
    const respond: CodexAppServerRequestResponder = (response) => {
      if (responded) return;
      responded = true;
      this.writeResponse({ id: msg.id, ...response });
    };

    const handled = this.emit("serverRequest", msg, respond);
    if (!handled) {
      respond({
        error: {
          code: "unsupported_server_request",
          message: `SocketAgent does not handle Codex app-server request '${msg.method}' yet`,
        },
      });
    }
  }

  private writeResponse(response: WireResponse): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(response) + "\n");
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private isResponse(value: unknown): value is WireResponse {
    return !!value
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "number";
  }

  private isServerRequest(value: unknown): value is WireServerRequest {
    return !!value
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "number"
      && typeof (value as { method?: unknown }).method === "string";
  }

  private isNotification(value: unknown): value is CodexAppServerNotification {
    return !!value
      && typeof value === "object"
      && typeof (value as { method?: unknown }).method === "string";
  }

  private formatProtocolError(method: string, error: unknown): string {
    if (error instanceof Error) return `${method}: ${error.message}`;
    if (typeof error === "string") return `${method}: ${error}`;
    try {
      return `${method}: ${JSON.stringify(error)}`;
    } catch {
      return `${method}: ${String(error)}`;
    }
  }
}
