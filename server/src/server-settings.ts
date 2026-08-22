import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { Backend, BackendHealthInfo, CodexDriver } from "./protocol";
import { buildCodexSpawn } from "./codex-env";
import { getCodexLinuxSandboxHealth } from "./codex-linux-sandbox";
import { resolveClientPath } from "./path-utils";
import { getClaudeAvailability, getClaudeExecutableInfo } from "./claude-session";
import {
  legacyManagedNpmBinDir,
  managedNpmBinDir,
  managedNpmPrefix,
  socketAgentDataPath,
} from "./socket-agent-paths";

export interface ServerSettings {
  codexDriver: CodexDriver;
  defaultCwd: string;
  systemPrompt: string;
  systemPromptInitialized: boolean;
  /** Null explicitly delegates the window selection to the Claude SDK/model. */
  claudeAutoCompactWindow: number | null;
  /**
   * Internal migration marker. Older settings serialized null as the implicit
   * default; true means the user deliberately selected the stored value.
   */
  claudeAutoCompactWindowConfigured?: boolean;
}

const STORE_DIR = socketAgentDataPath();
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");
const DEFAULT_CODEX_DRIVER: CodexDriver = "app-server";
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 250_000;
const BOOT_DEFAULT_CWD = resolveClientPath(process.env.DEFAULT_CWD || process.cwd()).resolvedPath || path.resolve(process.cwd());
const CODEX_DRIVER_CACHE_MS = 5000;
const BACKEND_HEALTH_CACHE_MS = 10000;

let cachedSettings: ServerSettings | null = null;
let cachedDriversAvailable: { checkedAt: number; value: CodexDriver[] } | null = null;
let cachedBackendHealth: { checkedAt: number; value: BackendHealthInfo[] } | null = null;

const LEGACY_AUTOMATIC_HTML_PLAN_RULES = [
  "- For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the html plan tool, and stop. Wait for a pick before implementing. Non-trivial is a key word here. If exact direction is given this isnt necessary.",
  "- Do not edit real components first. For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the html plan tool, and stop. Wait for a pick before implementing. Non-trivial is a key word here.",
];
const EXPLICIT_HTML_PLAN_RULE =
  "- Use the HTML plan tool only when the user explicitly asks for an HTML plan or explicitly asks to use that tool. Never invoke it automatically for UI, layout, copy, mockups, or implementation planning. When the user gives exact UI direction, implement it directly.";

export function normalizeSystemPrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  let prompt = value;
  for (const legacyRule of LEGACY_AUTOMATIC_HTML_PLAN_RULES) {
    prompt = prompt.replace(legacyRule, EXPLICIT_HTML_PLAN_RULE);
  }
  return prompt.slice(0, 20_000);
}

export function normalizeClaudeAutoCompactWindow(value: unknown): number | null {
  // An absent persisted setting receives SocketAgent's bounded default. Null
  // remains a deliberate escape hatch for users who want the SDK/model default.
  if (value === undefined) return DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100_000 || parsed > 1_000_000) {
    throw new Error("Claude auto-compact window must be an integer from 100,000 to 1,000,000 tokens");
  }
  return parsed;
}

export function resolvePersistedClaudeAutoCompactWindow(
  value: unknown,
  explicitlyConfigured: unknown,
): number | null {
  if (explicitlyConfigured === true) {
    return normalizeClaudeAutoCompactWindow(value);
  }
  // Preserve legacy numeric choices, but migrate the old implicit null/absent
  // default to SocketAgent's bounded default.
  if (value !== undefined && value !== null && value !== "") {
    return normalizeClaudeAutoCompactWindow(value);
  }
  return DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW;
}
const backendHealthOverrides = new Map<Backend, BackendHealthInfo>();

export function invalidateCodexDriverAvailabilityCache(): void {
  cachedDriversAvailable = null;
}

export function invalidateBackendHealthCache(): void {
  cachedBackendHealth = null;
}

export function markBackendAuthRequired(backend: Backend, detail?: string): void {
  const label = backend === "codex" ? "Codex" : "Claude";
  backendHealthOverrides.set(backend, {
    backend,
    enabled: true,
    available: false,
    severity: "error",
    reason: `${label} authentication is invalid or expired. Repair the backend to sign in again.`,
    detail,
  });
  invalidateBackendHealthCache();
}

export function clearBackendHealthOverride(backend: Backend): void {
  if (backendHealthOverrides.delete(backend)) {
    invalidateBackendHealthCache();
  }
}

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normalizeDriver(_value: unknown): CodexDriver {
  return "app-server";
}

function normalizeDefaultCwd(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return BOOT_DEFAULT_CWD;
  return resolveClientPath(value).resolvedPath || BOOT_DEFAULT_CWD;
}

function pathStartsWith(candidate: string | undefined, dir: string): boolean {
  if (!candidate) return false;
  try {
    const resolvedCandidate = path.resolve(candidate).toLowerCase();
    const resolvedDir = path.resolve(dir).toLowerCase();
    return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(resolvedDir + path.sep);
  } catch {
    return false;
  }
}

function codexCommandSource(command: string): BackendHealthInfo["source"] {
  if (pathStartsWith(command, managedNpmBinDir())) return "managed";
  if (pathStartsWith(command, legacyManagedNpmBinDir())) return "legacy";
  if (command === "codex" || command === "codex.cmd") return "path";
  return "system";
}

function managedSourceWarning(backend: Backend, source: BackendHealthInfo["source"]): string | undefined {
  if (source === "managed" || source === "explicit") return undefined;
  if (source === "sdk") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the SDK-bundled executable instead of the SocketAgent-managed toolchain. Repair the backend to install and use the managed copy.`;
  }
  if (source === "legacy") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the old SocketAgent toolchain location. Repair the backend to move it under .socket-agent.`;
  }
  if (source === "system" || source === "path") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the system install instead of the SocketAgent-managed toolchain. Local customizations can break SocketAgent.`;
  }
  return undefined;
}

function firstOutputLine(stdout?: string | Buffer, stderr?: string | Buffer): string | undefined {
  const text = `${stdout || ""}\n${stderr || ""}`.trim();
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function codexHealth(): BackendHealthInfo {
  const codexVersion = buildCodexSpawn(["--version"]);
  const source = codexCommandSource(codexVersion.command);
  const base: BackendHealthInfo = {
    backend: "codex",
    enabled: true,
    available: false,
    severity: "error",
    source,
    command: codexVersion.command,
    installRoot: managedNpmPrefix(),
  };

  const versionProbe = spawnSync(codexVersion.command, codexVersion.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    env: codexVersion.env,
    shell: codexVersion.shell,
    windowsHide: true,
  });

  if (versionProbe.error) {
    const code = (versionProbe.error as NodeJS.ErrnoException).code;
    return {
      ...base,
      reason: code === "ENOENT"
        ? "Codex CLI was not found."
        : `Codex CLI probe failed: ${versionProbe.error.message}`,
      detail: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
    };
  }

  if (versionProbe.status !== 0) {
    const detail = firstOutputLine(versionProbe.stdout, versionProbe.stderr);
    return {
      ...base,
      reason: detail
        ? `Codex CLI probe exited ${versionProbe.status}: ${detail}`
        : `Codex CLI probe exited ${versionProbe.status}`,
      detail,
    };
  }

  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return {
      ...base,
      version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
      reason: "Codex CLI is installed, but ~/.codex/auth.json is missing.",
    };
  }

  const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
  const appServerProbe = spawnSync(appServerHelp.command, appServerHelp.args, {
    encoding: "utf8",
    timeout: 3000,
    env: appServerHelp.env,
    shell: appServerHelp.shell,
    windowsHide: true,
  });
  if (appServerProbe.status !== 0 || appServerProbe.error) {
    const detail = appServerProbe.error?.message || firstOutputLine(appServerProbe.stdout, appServerProbe.stderr);
    return {
      ...base,
      version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
      reason: detail
        ? `Codex app-server probe failed: ${detail}`
        : "Codex app-server probe failed.",
      detail,
    };
  }

  const warning = managedSourceWarning("codex", source);
  const sandboxHealth = getCodexLinuxSandboxHealth();
  const warnings = [warning, sandboxHealth?.available === false ? sandboxHealth.reason : undefined]
    .filter((value): value is string => !!value);
  return {
    ...base,
    available: true,
    severity: warnings.length > 0 ? "warning" : "ok",
    version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
    reason: warnings.length > 0 ? warnings.join(" ") : undefined,
    detail: sandboxHealth?.available === false ? sandboxHealth.detail : undefined,
  };
}

function claudeHealth(): BackendHealthInfo {
  const info = getClaudeExecutableInfo();
  const availability = getClaudeAvailability();
  if (!info.path) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      source: info.source,
      reason: info.reason || "No Claude executable is available.",
      installRoot: managedNpmPrefix(),
    };
  }

  if (!availability.available) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      source: info.source,
      command: info.path,
      reason: availability.reason || "Claude executable is not launchable.",
      detail: availability.detail,
      installRoot: managedNpmPrefix(),
    };
  }

  const warning = managedSourceWarning("claude", info.source);
  return {
    backend: "claude",
    enabled: true,
    available: true,
    severity: warning ? "warning" : "ok",
    source: info.source,
    command: info.path,
    version: availability.version,
    reason: warning,
    installRoot: managedNpmPrefix(),
  };
}

export function loadServerSettings(): ServerSettings {
  if (cachedSettings) return cachedSettings;
  ensureStoreDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    cachedSettings = {
      codexDriver: DEFAULT_CODEX_DRIVER,
      defaultCwd: BOOT_DEFAULT_CWD,
      systemPrompt: "",
      systemPromptInitialized: false,
      claudeAutoCompactWindow: DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
      claudeAutoCompactWindowConfigured: false,
    };
    return cachedSettings;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Partial<ServerSettings>;
    const rawClaudeAutoCompactWindow = (
      raw as Record<string, unknown>
    ).claudeAutoCompactWindow;
    cachedSettings = {
      codexDriver: normalizeDriver(raw.codexDriver),
      defaultCwd: normalizeDefaultCwd(raw.defaultCwd),
      systemPrompt: normalizeSystemPrompt(raw.systemPrompt),
      systemPromptInitialized: raw.systemPromptInitialized === true,
      claudeAutoCompactWindow: resolvePersistedClaudeAutoCompactWindow(
        rawClaudeAutoCompactWindow,
        raw.claudeAutoCompactWindowConfigured,
      ),
      claudeAutoCompactWindowConfigured:
        raw.claudeAutoCompactWindowConfigured === true
        || (
          rawClaudeAutoCompactWindow !== undefined
          && rawClaudeAutoCompactWindow !== null
          && rawClaudeAutoCompactWindow !== ""
        ),
    };
  } catch (err: any) {
    console.warn(`[settings] Failed to read server settings: ${err?.message || String(err)}`);
    cachedSettings = {
      codexDriver: DEFAULT_CODEX_DRIVER,
      defaultCwd: BOOT_DEFAULT_CWD,
      systemPrompt: "",
      systemPromptInitialized: false,
      claudeAutoCompactWindow: DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
      claudeAutoCompactWindowConfigured: false,
    };
  }
  return cachedSettings;
}

export function saveServerSettings(settings: ServerSettings): ServerSettings {
  ensureStoreDir();
  const previous = loadServerSettings();
  cachedSettings = {
    codexDriver: normalizeDriver(settings.codexDriver ?? previous.codexDriver),
    defaultCwd: normalizeDefaultCwd(settings.defaultCwd ?? previous.defaultCwd),
    systemPrompt: normalizeSystemPrompt(settings.systemPrompt ?? previous.systemPrompt),
    systemPromptInitialized: settings.systemPromptInitialized ?? previous.systemPromptInitialized,
    claudeAutoCompactWindow: settings.claudeAutoCompactWindow === undefined
      ? previous.claudeAutoCompactWindow
      : normalizeClaudeAutoCompactWindow(settings.claudeAutoCompactWindow),
    claudeAutoCompactWindowConfigured:
      settings.claudeAutoCompactWindowConfigured
      ?? previous.claudeAutoCompactWindowConfigured
      ?? false,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cachedSettings, null, 2), "utf-8");
  return cachedSettings;
}

export function setDefaultCwd(defaultCwd: string): ServerSettings {
  return saveServerSettings({ ...loadServerSettings(), defaultCwd: normalizeDefaultCwd(defaultCwd) });
}

export function getDefaultCwd(): string {
  return loadServerSettings().defaultCwd;
}

export function setServerSystemPrompt(systemPrompt: string): ServerSettings {
  return saveServerSettings({
    ...loadServerSettings(),
    systemPrompt: normalizeSystemPrompt(systemPrompt),
    systemPromptInitialized: true,
  });
}

export function getServerSystemPrompt(): string {
  return loadServerSettings().systemPrompt;
}

export function isServerSystemPromptInitialized(): boolean {
  return loadServerSettings().systemPromptInitialized;
}

export function setClaudeAutoCompactWindow(window: number | null): ServerSettings {
  return saveServerSettings({
    ...loadServerSettings(),
    claudeAutoCompactWindow: normalizeClaudeAutoCompactWindow(window),
    claudeAutoCompactWindowConfigured: true,
  });
}

export function getClaudeAutoCompactWindow(): number | null {
  return loadServerSettings().claudeAutoCompactWindow;
}

export function getCodexDriversAvailable(): CodexDriver[] {
  const now = Date.now();
  if (cachedDriversAvailable && now - cachedDriversAvailable.checkedAt < CODEX_DRIVER_CACHE_MS) {
    return cachedDriversAvailable.value;
  }
  const cache = (value: CodexDriver[]): CodexDriver[] => {
    cachedDriversAvailable = { checkedAt: Date.now(), value };
    return value;
  };

  const codexVersion = buildCodexSpawn(["--version"]);
  const codexProbe = spawnSync(codexVersion.command, codexVersion.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    env: codexVersion.env,
    shell: codexVersion.shell,
    windowsHide: true,
  });
  if (codexProbe.status !== 0) {
    return cache([]);
  }

  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return cache([]);
  }

  try {
    const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
    const result = spawnSync(appServerHelp.command, appServerHelp.args, {
      encoding: "utf8",
      timeout: 3000,
      env: appServerHelp.env,
      shell: appServerHelp.shell,
      windowsHide: true,
    });
    return cache(result.status === 0 ? ["app-server"] : []);
  } catch {
    return cache([]);
  }
}

export function getBackendHealth(): BackendHealthInfo[] {
  const now = Date.now();
  if (cachedBackendHealth && now - cachedBackendHealth.checkedAt < BACKEND_HEALTH_CACHE_MS) {
    return cachedBackendHealth.value;
  }

  const value = [
    claudeHealth(),
    codexHealth(),
  ].map((entry) => backendHealthOverrides.get(entry.backend) ?? entry);
  cachedBackendHealth = { checkedAt: Date.now(), value };
  return value;
}

export function getAdvertisedServerSettings(): ServerSettings & {
  codexDriversAvailable: CodexDriver[];
  backendHealth: BackendHealthInfo[];
} {
  const settings = loadServerSettings();
  const codexDriversAvailable = getCodexDriversAvailable();
  return {
    codexDriver: DEFAULT_CODEX_DRIVER,
    defaultCwd: settings.defaultCwd,
    systemPrompt: settings.systemPrompt,
    systemPromptInitialized: settings.systemPromptInitialized,
    claudeAutoCompactWindow: settings.claudeAutoCompactWindow,
    codexDriversAvailable,
    backendHealth: getBackendHealth(),
  };
}
