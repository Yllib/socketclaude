import { randomUUID } from "crypto";

type SessionEvent = Record<string, any>;

interface PendingDelivery {
  message: SessionEvent;
  attempts: number;
  createdAt: number;
}

function requiresAcknowledgement(message: SessionEvent): boolean {
  const type = String(message.type || "");
  return type === "tool_call"
    || type === "tool_result"
    || type === "user_message_uuid"
    // SendFile's canonical tool card and its transport registration are
    // separate events. Losing the latter leaves a live card that cannot be
    // downloaded until history is reloaded and supplies the persisted ID.
    || type === "file"
    || type === "html_plan"
    || type === "work_review_card"
    || type === "browser_session_open"
    || type === "monitor_output"
    || ((type === "text" || type === "thinking") && message.finalSnapshot === true);
}

/**
 * Retains card-defining session events until the app confirms that its live
 * reducer applied them. WebSocket delivery alone is not sufficient: a frame
 * can reach the phone while a session/provider transition discards it.
 */
export class SessionEventDelivery {
  private pending = new Map<string, PendingDelivery>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dispatch: (message: SessionEvent) => void,
    private readonly retryMs = 750,
    private readonly maxPending = 1_000,
    private readonly maxAgeMs = 10 * 60_000,
    private readonly maxRetryAttempts = 3,
  ) {}

  prepare(message: SessionEvent): SessionEvent {
    if (!requiresAcknowledgement(message)) return message;
    if (typeof message.deliveryId === "string" && message.deliveryId) {
      return message;
    }

    const deliveryId = randomUUID();
    const tracked = { ...message, deliveryId };
    this.pending.set(deliveryId, {
      message: tracked,
      attempts: 0,
      createdAt: Date.now(),
    });
    console.log(
      `[SessionDelivery] track type=${String(message.type || "unknown")}`
      + ` session=${String(message.sessionId || "")}`
      + ` delivery=${deliveryId}`
      + (message.toolUseId ? ` toolUseId=${String(message.toolUseId)}` : "")
      + (message.streamId ? ` streamId=${String(message.streamId)}` : ""),
    );
    this.trim();
    this.scheduleRetry();
    return tracked;
  }

  acknowledge(deliveryId: string): boolean {
    const entry = this.pending.get(deliveryId);
    const removed = this.pending.delete(deliveryId);
    if (entry) {
      console.log(
        `[SessionDelivery] ack type=${String(entry.message.type || "unknown")}`
        + ` session=${String(entry.message.sessionId || "")}`
        + ` delivery=${deliveryId}`
        + (entry.message.toolUseId ? ` toolUseId=${String(entry.message.toolUseId)}` : "")
        + (entry.message.streamId ? ` streamId=${String(entry.message.streamId)}` : ""),
      );
    }
    if (this.pending.size === 0 && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return removed;
  }

  replayTo(dispatch: (message: SessionEvent) => void): void {
    for (const entry of this.pending.values()) {
      // A reattached client is a new delivery opportunity. Reset the small
      // automatic retry budget, but retain the original delivery identity so
      // the app can collapse anything already applied before reconnecting.
      entry.attempts = 0;
      dispatch({ ...entry.message, replay: true });
    }
    this.scheduleRetry();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(type: string, identity?: string): boolean {
    for (const entry of this.pending.values()) {
      if (String(entry.message.type || "") !== type) continue;
      if (!identity) return true;
      if (String(entry.message.toolUseId || entry.message.entryId || "") === identity) return true;
    }
    return false;
  }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pending.clear();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.hasRetryablePending()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryPending();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private retryPending(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [deliveryId, entry] of this.pending.entries()) {
      if (entry.createdAt < cutoff) {
        this.pending.delete(deliveryId);
        continue;
      }
      // Keep the event available for an explicit reconnect replay, but never
      // flood a connected relay forever when a background session is not the
      // phone's visible chat. History remains the durable recovery source.
      if (entry.attempts >= this.maxRetryAttempts) continue;
      entry.attempts++;
      console.warn(
        `[SessionDelivery] retry type=${String(entry.message.type || "unknown")}`
        + ` session=${String(entry.message.sessionId || "")}`
        + ` delivery=${deliveryId}`
        + ` attempt=${entry.attempts + 1}`
        + (entry.message.toolUseId ? ` toolUseId=${String(entry.message.toolUseId)}` : "")
        + (entry.message.streamId ? ` streamId=${String(entry.message.streamId)}` : ""),
      );
      this.dispatch({
        ...entry.message,
        replay: true,
        deliveryAttempt: entry.attempts + 1,
      });
    }
    this.scheduleRetry();
  }

  private hasRetryablePending(): boolean {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const entry of this.pending.values()) {
      if (entry.createdAt >= cutoff && entry.attempts < this.maxRetryAttempts) {
        return true;
      }
    }
    return false;
  }

  private trim(): void {
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
  }
}
