export type ControlMessageShape = {
  type?: unknown;
  sessionId?: unknown;
};

export type ControlMessageQueueScope =
  | { kind: "priority" }
  | { kind: "concurrent" }
  | { kind: "session"; sessionId: string }
  | { kind: "connection"; sessionId?: string };

const PRIORITY_MESSAGE_TYPES = new Set([
  "abort",
]);

// These requests read process-wide snapshots and do not depend on the
// connection's selected session. They can respond while a resume or prompt is
// starting instead of waiting behind it.
const CONCURRENT_READ_MESSAGE_TYPES = new Set([
  "get_push_registration",
  "get_recent_cwds",
  "get_server_settings",
  "get_status_sync",
  "html_plan_list",
  "list_archives",
  "list_scheduled_tasks",
  "list_sessions",
  "marketplaces_list",
  "plugins_list",
  "protected_files_list",
  "secret_inventory_request",
  "skills_list",
  "version_check",
  "work_review_list",
]);

// These operations replace or depend on the connection-local active runner.
// They must retain arrival order even when they name different sessions.
const CONNECTION_LIFECYCLE_MESSAGE_TYPES = new Set([
  "branch_from_message",
  "fork_session",
  "new_session",
  "prompt",
  "restore_archive",
  "resume_session",
  "rewind",
  "rewind_conversation",
]);

export function controlMessageQueueScope(
  message: ControlMessageShape,
): ControlMessageQueueScope {
  const type = typeof message.type === "string" ? message.type : "";
  if (PRIORITY_MESSAGE_TYPES.has(type)) return { kind: "priority" };
  if (CONCURRENT_READ_MESSAGE_TYPES.has(type)) return { kind: "concurrent" };
  const sessionId = typeof message.sessionId === "string"
    ? message.sessionId.trim()
    : "";
  if (CONNECTION_LIFECYCLE_MESSAGE_TYPES.has(type)) {
    return sessionId
      ? { kind: "connection", sessionId }
      : { kind: "connection" };
  }
  return sessionId
    ? { kind: "session", sessionId }
    : { kind: "connection" };
}

/**
 * Preserves mutation ordering without making one slow session block every
 * other session on the same phone connection. The stored tails never reject,
 * so one failed message cannot poison later work in that queue.
 */
export class ControlMessageScheduler {
  private connectionTail: Promise<void> = Promise.resolve();
  private readonly sessionTails = new Map<string, Promise<void>>();

  run<T>(message: ControlMessageShape, operation: () => Promise<T>): Promise<T> {
    const scope = controlMessageQueueScope(message);
    if (scope.kind === "priority" || scope.kind === "concurrent") {
      return Promise.resolve().then(operation);
    }
    if (scope.kind === "connection") {
      const sessionTail = scope.sessionId
        ? this.sessionTails.get(scope.sessionId)
        : undefined;
      const previous = sessionTail
        ? Promise.all([this.connectionTail, sessionTail]).then(() => undefined)
        : this.connectionTail;
      const result = previous.then(operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      this.connectionTail = tail;
      if (scope.sessionId) this.storeSessionTail(scope.sessionId, tail);
      return result;
    }

    const previous = this.sessionTails.get(scope.sessionId) || Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.storeSessionTail(scope.sessionId, tail);
    return result;
  }

  private storeSessionTail(sessionId: string, tail: Promise<void>): void {
    this.sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(sessionId) === tail) {
        this.sessionTails.delete(sessionId);
      }
    });
  }

  reset(): void {
    this.connectionTail = Promise.resolve();
    this.sessionTails.clear();
  }
}
