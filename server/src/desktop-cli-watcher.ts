import * as fs from "fs";
import {
  getJsonlPath,
  getLastHistoryTimestamp,
  getMissedMessages,
  appendHistory,
} from "./session-store";
import { HistoryEntry } from "./protocol";

export interface DesktopCliWatcherOptions {
  sessionId: string;
  cwd: string;
  onNewMessages: (messages: HistoryEntry[]) => void;
  isOurQueryRunning: () => boolean;
}

export class DesktopCliWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private lastSyncTimestamp: string;
  private jsonlPath: string;
  private lastMtime = 0;
  private stopped = false;
  private _isActive = false;
  private activityClearTimer: NodeJS.Timeout | null = null;
  private _queryEndedAt = 0;  // timestamp when our query last ended

  /** Whether the desktop CLI is actively writing to this session's JSONL. */
  get isActive(): boolean { return this._isActive; }

  /** Call when our own SDK query finishes to prevent false desktop CLI detection. */
  markQueryEnded(): void {
    this._queryEndedAt = Date.now();
    this._isActive = false;
    // Refresh mtime so we don't pick up our own final writes
    try {
      this.lastMtime = fs.statSync(this.jsonlPath).mtimeMs;
    } catch {}
  }

  constructor(private opts: DesktopCliWatcherOptions) {
    this.jsonlPath = getJsonlPath(opts.sessionId, opts.cwd);
    this.lastSyncTimestamp = getLastHistoryTimestamp(opts.sessionId);
  }

  start(): void {
    this.stopped = false;

    // Seed lastMtime from current file so the first poll doesn't false-positive
    try {
      this.lastMtime = fs.statSync(this.jsonlPath).mtimeMs;
    } catch {}

    // Try fs.watch first (inotify on Linux — efficient)
    try {
      if (fs.existsSync(this.jsonlPath)) {
        this.watcher = fs.watch(this.jsonlPath, { persistent: false }, () => {
          this.onJsonlChanged();
        });
        this.watcher.on("error", () => {
          // Watcher failed (e.g., file deleted), fall back to polling only
          this.watcher = null;
        });
      }
    } catch {
      // fs.watch not supported (NFS, etc.)
    }

    // Poll fallback — also covers the case where JSONL doesn't exist yet
    // or fs.watch doesn't fire on network filesystems
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      try {
        const stat = fs.statSync(this.jsonlPath);
        if (stat.mtimeMs > this.lastMtime) {
          this.lastMtime = stat.mtimeMs;
          this.onJsonlChanged();
        }
      } catch {
        // File doesn't exist yet — that's fine
      }
    }, 2000);
  }

  stop(): void {
    this.stopped = true;
    this._isActive = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.activityClearTimer) {
      clearTimeout(this.activityClearTimer);
      this.activityClearTimer = null;
    }
  }

  /** Manual sync trigger */
  syncNow(): void {
    this.syncMessages();
  }

  private onJsonlChanged(): void {
    if (this.stopped) return;

    // Ignore changes caused by our own SDK query
    if (this.opts.isOurQueryRunning()) return;

    // Grace period after our query ends — JSONL writes may still be flushing
    if (Date.now() - this._queryEndedAt < 5000) return;

    // Mark desktop CLI as active (JSONL is being written to externally)
    this._isActive = true;
    if (this.activityClearTimer) clearTimeout(this.activityClearTimer);
    // Clear activity flag after 10s of no changes
    this.activityClearTimer = setTimeout(() => { this._isActive = false; }, 10000);

    // Debounce rapid writes (CLI doing multiple tool calls)
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (this.stopped) return;

      // Reset quiet timer — CLI is still writing
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => this.onQuiet(), 2000);
    }, 500);
  }

  private onQuiet(): void {
    if (this.stopped) return;
    // Re-check: a new query may have started during the debounce window
    if (this.opts.isOurQueryRunning()) return;

    console.log(`[DesktopCLI] Session ${this.opts.sessionId}: JSONL quiet, syncing messages`);
    this.syncMessages();
  }

  private syncMessages(): void {
    // Always refresh from current history — our own session may have
    // appended messages since the watcher was created
    this.lastSyncTimestamp = getLastHistoryTimestamp(this.opts.sessionId);
    if (!this.lastSyncTimestamp) return;

    const missed = getMissedMessages(
      this.opts.sessionId,
      this.opts.cwd,
      this.lastSyncTimestamp
    );

    if (missed.length > 0) {
      console.log(`[DesktopCLI] Session ${this.opts.sessionId}: syncing ${missed.length} messages from desktop CLI`);
      for (const entry of missed) {
        appendHistory(this.opts.sessionId, entry);
      }
      this.lastSyncTimestamp = missed[missed.length - 1].timestamp;
      this.opts.onNewMessages(missed);
    }
  }
}
