import * as fs from "fs";
import * as path from "path";

const STORE_DIR = path.join(
  process.env.HOME || require("os").homedir(),
  ".claude-assistant"
);
const TASKS_FILE = path.join(STORE_DIR, "scheduled-tasks.json");

export interface RecurrenceConfig {
  type: "once" | "daily" | "weekly" | "monthly" | "custom";
  intervalMs?: number; // for "custom" type
  daysOfWeek?: number[]; // for "weekly" — 0=Sun, 1=Mon, ..., 6=Sat
}

export interface TaskRun {
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  resultSummary?: string;
  error?: string;
}

export interface ScheduledTask {
  id: string;
  prompt: string;
  cwd: string;
  scheduledTime: string;
  createdAt: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  sessionId?: string;
  resultSummary?: string;
  error?: string;
  createdBySessionId?: string;
  // Recurrence
  recurrence?: RecurrenceConfig;
  reuseSession?: boolean;
  runCount?: number;
  lastRunAt?: string;
  // History of all runs (for recurring tasks)
  runs?: TaskRun[];
}

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readTasks(): ScheduledTask[] {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8")) as ScheduledTask[];
  } catch {
    return [];
  }
}

function writeTasks(tasks: ScheduledTask[]): void {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

export function listScheduledTasks(): ScheduledTask[] {
  return readTasks().sort(
    (a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
  );
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  return readTasks().find((t) => t.id === id);
}

export function saveScheduledTask(task: ScheduledTask): void {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  writeTasks(tasks);
}

export function deleteScheduledTask(id: string): void {
  const tasks = readTasks().filter((t) => t.id !== id);
  writeTasks(tasks);
}

export function getDueTasks(): ScheduledTask[] {
  const now = Date.now();
  return readTasks().filter(
    (t) => t.status === "pending" && new Date(t.scheduledTime).getTime() <= now
  );
}

/** Calculate the next scheduled time for a recurring task */
export function getNextRunTime(task: ScheduledTask): string | null {
  if (!task.recurrence || task.recurrence.type === "once") return null;

  const last = new Date(task.scheduledTime);
  let next: Date;

  switch (task.recurrence.type) {
    case "daily":
      next = new Date(last.getTime() + 24 * 60 * 60 * 1000);
      break;
    case "weekly":
      next = new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case "monthly": {
      next = new Date(last);
      next.setMonth(next.getMonth() + 1);
      break;
    }
    case "custom":
      if (!task.recurrence.intervalMs) return null;
      next = new Date(last.getTime() + task.recurrence.intervalMs);
      break;
    default:
      return null;
  }

  // If next is still in the past, advance until it's in the future
  const now = Date.now();
  while (next.getTime() <= now) {
    switch (task.recurrence.type) {
      case "daily":
        next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
        break;
      case "weekly":
        next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case "monthly":
        next.setMonth(next.getMonth() + 1);
        break;
      case "custom":
        next = new Date(next.getTime() + task.recurrence!.intervalMs!);
        break;
    }
  }

  return next.toISOString();
}

/** Get all session IDs that belong to scheduled tasks */
export function getScheduledTaskSessionIds(): Set<string> {
  const tasks = readTasks();
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.sessionId) ids.add(t.sessionId);
    if (t.runs) {
      for (const run of t.runs) {
        if (run.sessionId) ids.add(run.sessionId);
      }
    }
  }
  return ids;
}
