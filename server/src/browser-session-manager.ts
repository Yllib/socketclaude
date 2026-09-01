import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import WebSocket from "ws";

type JsonRecord = Record<string, unknown>;

export interface BrowserSessionSummary {
  profile: string;
  label: string;
  running: boolean;
  sessionId?: string;
  url?: string;
  title?: string;
  lastUsedAt?: string;
}

export interface BrowserFrame {
  profile: string;
  imageBase64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  url: string;
  title: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name: string;
  type?: string;
  value?: string;
  disabled: boolean;
}

export interface BrowserSnapshot {
  profile: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
}

export type BrowserPhoneInput =
  | { action: "tap"; x: number; y: number }
  | { action: "text"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; deltaX?: number; deltaY: number }
  | { action: "navigate"; url: string }
  | { action: "reload" }
  | { action: "back" }
  | { action: "forward" };

interface CdpResponse {
  id?: number;
  result?: JsonRecord;
  error?: { message?: string };
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface RunningBrowserSession {
  profile: string;
  label: string;
  sessionId?: string;
  url: string;
  profileDir: string;
  process: ChildProcess;
  cdp: CdpClient;
  width: number;
  height: number;
  lastUsedAt: string;
  idleTimer?: NodeJS.Timeout;
}

const DEFAULT_WIDTH = 430;
const DEFAULT_HEIGHT = 860;
const IDLE_CLOSE_MS = 2 * 60 * 60_000;

function socketAgentDataDir(): string {
  return process.env.SOCKET_AGENT_DATA_DIR
    || process.env.SOCKETAGENT_DATA_DIR
    || path.join(process.env.HOME || os.homedir(), ".socket-agent");
}

export function browserDataDir(browserExecutable = resolveBrowserBinary()): string {
  if (process.platform === "linux"
    && (browserExecutable === "/usr/bin/chromium-browser" || browserExecutable === "/snap/bin/chromium")) {
    return path.join(process.env.HOME || os.homedir(), "snap", "chromium", "common", "socketagent-browser-sessions");
  }
  return path.join(socketAgentDataDir(), "browser-sessions");
}

function managedBrowserPath(): string {
  try {
    return fs.readFileSync(
      path.join(socketAgentDataDir(), "browser-runtime", "executable-path"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function restrictDirectory(target: string): void {
  try { fs.chmodSync(target, 0o700); } catch {}
}

/** Chromium can leave control files and singleton links behind after a crash. */
export function removeStaleBrowserControlFile(profileDir: string): void {
  const singletonLock = path.join(profileDir, "SingletonLock");
  try {
    const lockTarget = fs.readlinkSync(singletonLock);
    const pidMatch = /-(\d+)$/.exec(lockTarget);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      try {
        process.kill(pid, 0);
        throw new Error(`Browser profile is still owned by process ${pid}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT"
      && !String((error as Error).message).startsWith("Browser profile is still owned")) {
      throw new Error(`Could not inspect the browser profile lock: ${(error as Error).message}`);
    }
    if (String((error as Error).message).startsWith("Browser profile is still owned")) throw error;
  }

  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch (error) {
      throw new Error(
        `Could not remove stale browser control file ${name}: ${(error as Error).message}`,
      );
    }
  }
}

export function normalizeBrowserProfile(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("Browser profile names may contain lowercase letters, numbers, underscores, and hyphens.");
  }
  return normalized;
}

export function normalizeBrowserUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Browser URL is invalid."); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Browser URLs must use HTTP or HTTPS and cannot contain embedded credentials.");
  }
  return url.toString();
}

function browserCandidates(): string[] {
  const configured = process.env.SOCKETAGENT_BROWSER_BINARY?.trim();
  const managed = managedBrowserPath();
  const candidates = configured ? [configured] : [];
  if (managed) candidates.push(managed);
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/snap/bin/chromium",
    );
  }
  return candidates;
}

export function resolveBrowserBinary(): string {
  const candidate = browserCandidates().find((item) => item && fs.existsSync(item));
  if (!candidate) {
    throw new Error(
      "No supported Chrome, Chromium, or Edge installation was found. Install one or set SOCKETAGENT_BROWSER_BINARY.",
    );
  }
  return candidate;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (value: JsonRecord) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => this.rejectAll(new Error("Browser connection closed.")));
    socket.on("error", (error) => this.rejectAll(error));
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out.")), 15_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new CdpClient(socket);
  }

  async command(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Browser connection is not open.");
    const id = ++this.nextId;
    return await new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try { this.socket.close(); } catch {}
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(raw) as CdpResponse; }
    catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Browser command failed."));
    else pending.resolve(message.result || {});
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function readStringResult(result: JsonRecord): string {
  const nested = result.result;
  if (!nested || typeof nested !== "object") return "";
  const value = (nested as JsonRecord).value;
  return typeof value === "string" ? value : "";
}

function runtimeExceptionDescription(result: JsonRecord): string {
  const details = result.exceptionDetails;
  if (!details || typeof details !== "object") return "";
  const record = details as JsonRecord;
  const exception = record.exception;
  if (exception && typeof exception === "object") {
    const description = (exception as JsonRecord).description;
    if (typeof description === "string") return description.split("\n", 1)[0].slice(0, 300);
  }
  return typeof record.text === "string" ? record.text.slice(0, 300) : "";
}

function boundedLabel(value: string | undefined, profile: string): string {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 80);
  return label || profile;
}

export class BrowserSessionManager {
  private sessions = new Map<string, RunningBrowserSession>();

  async open(
    profileValue: string,
    rawUrl: string,
    labelValue?: string,
    sessionId?: string,
  ): Promise<BrowserSessionSummary> {
    const profile = normalizeBrowserProfile(profileValue);
    const url = normalizeBrowserUrl(rawUrl);
    const existing = this.sessions.get(profile);
    if (existing) {
      existing.label = boundedLabel(labelValue, profile);
      existing.sessionId = sessionId || existing.sessionId;
      existing.url = url;
      await existing.cdp.command("Page.navigate", { url });
      this.touch(existing);
      await wait(300);
      return await this.summary(existing);
    }

    const browserExecutable = resolveBrowserBinary();
    const root = browserDataDir(browserExecutable);
    const profileDir = path.join(root, profile);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    restrictDirectory(root);
    restrictDirectory(profileDir);
    removeStaleBrowserControlFile(profileDir);
    const processHandle = spawn(browserExecutable, [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-mode",
      "--disable-component-update",
      "--disable-features=Translate,OptimizationHints,msEdgeFirstRunExperience",
      "--password-store=basic",
      "about:blank",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      const port = await this.waitForDebuggingPort(profileDir, processHandle);
      const targets = await this.waitForPageTarget(port);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("Browser did not create an interactive page.");
      const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
      await Promise.all([
        cdp.command("Page.enable"),
        cdp.command("Runtime.enable"),
        cdp.command("DOM.enable"),
        cdp.command("Emulation.setDeviceMetricsOverride", {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        }),
      ]);
      const session: RunningBrowserSession = {
        profile,
        label: boundedLabel(labelValue, profile),
        ...(sessionId ? { sessionId } : {}),
        url,
        profileDir,
        process: processHandle,
        cdp,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        lastUsedAt: new Date().toISOString(),
      };
      processHandle.once("exit", () => {
        const current = this.sessions.get(profile);
        if (current === session) {
          if (current.idleTimer) clearTimeout(current.idleTimer);
          current.cdp.close();
          this.sessions.delete(profile);
        }
      });
      this.sessions.set(profile, session);
      await cdp.command("Page.navigate", { url });
      this.touch(session);
      await wait(500);
      return await this.summary(session);
    } catch (error) {
      processHandle.kill("SIGTERM");
      throw error;
    }
  }

  list(): BrowserSessionSummary[] {
    const root = browserDataDir();
    const saved = new Set<string>();
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)) saved.add(entry.name);
      }
    } catch {}
    for (const profile of this.sessions.keys()) saved.add(profile);
    return [...saved].sort().map((profile) => {
      const running = this.sessions.get(profile);
      return running
        ? {
            profile,
            label: running.label,
            running: true,
            sessionId: running.sessionId,
            url: running.url,
            lastUsedAt: running.lastUsedAt,
          }
        : { profile, label: profile, running: false };
    });
  }

  active(): BrowserSessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      profile: session.profile,
      label: session.label,
      running: true,
      sessionId: session.sessionId,
      url: session.url,
      lastUsedAt: session.lastUsedAt,
    }));
  }

  async status(profileValue: string): Promise<BrowserSessionSummary> {
    const profile = normalizeBrowserProfile(profileValue);
    const session = this.require(profile);
    return await this.summary(session);
  }

  async frame(profileValue: string): Promise<BrowserFrame> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    const [capture, location, title] = await Promise.all([
      session.cdp.command("Page.captureScreenshot", {
        format: "jpeg",
        quality: 72,
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      session.cdp.command("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      session.cdp.command("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
    ]);
    const imageBase64 = typeof capture.data === "string" ? capture.data : "";
    if (!imageBase64) throw new Error("Browser did not return a frame.");
    const url = readStringResult(location) || session.url;
    session.url = url;
    return {
      profile: session.profile,
      imageBase64,
      mimeType: "image/jpeg",
      width: session.width,
      height: session.height,
      url,
      title: readStringResult(title),
    };
  }

  async phoneInput(profileValue: string, input: BrowserPhoneInput): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    switch (input.action) {
      case "tap": {
        const x = Math.max(0, Math.min(session.width, Number(input.x)));
        const y = Math.max(0, Math.min(session.height, Number(input.y)));
        await session.cdp.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await session.cdp.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        break;
      }
      case "text":
        if (input.text.length > 16_384) throw new Error("Browser text input is too large.");
        await session.cdp.command("Input.insertText", { text: input.text });
        break;
      case "key":
        await this.pressKey(session, input.key);
        break;
      case "scroll":
        await session.cdp.command("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: session.width / 2,
          y: session.height / 2,
          deltaX: Math.max(-5000, Math.min(5000, Number(input.deltaX || 0))),
          deltaY: Math.max(-5000, Math.min(5000, Number(input.deltaY))),
        });
        break;
      case "navigate":
        await session.cdp.command("Page.navigate", { url: normalizeBrowserUrl(input.url) });
        break;
      case "reload":
        await session.cdp.command("Page.reload", { ignoreCache: false });
        break;
      case "back":
        await this.historyStep(session, -1);
        break;
      case "forward":
        await this.historyStep(session, 1);
        break;
    }
  }

  async snapshot(profileValue: string): Promise<BrowserSnapshot> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    const expression = String.raw`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      document.querySelectorAll('[data-socketagent-ref]').forEach((el) => el.removeAttribute('data-socketagent-ref'));
      const selector = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]';
      const elements = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 300).map((el, index) => {
        const ref = 'sa-' + (index + 1);
        el.setAttribute('data-socketagent-ref', ref);
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const secretHint = [type, el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
        const secret = type === 'password' || /(password|passcode|one-time|otp|mfa|token|secret|recovery|verification.code)/.test(secretHint);
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          name: String(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 240),
          type: type || undefined,
          value: secret ? undefined : (typeof el.value === 'string' ? el.value.slice(0, 500) : undefined),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
        };
      });
      return JSON.stringify({
        url: location.href,
        title: document.title,
        text: String(document.body && document.body.innerText || '').slice(0, 30000),
        elements
      });
    })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const serialized = readStringResult(result);
    if (!serialized) throw new Error("Browser page could not be inspected.");
    const parsed = JSON.parse(serialized) as Omit<BrowserSnapshot, "profile">;
    session.url = parsed.url || session.url;
    return { profile: session.profile, ...parsed };
  }

  async click(profileValue: string, ref: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const safeRef = String(ref).trim();
    if (!/^sa-[1-9][0-9]{0,3}$/.test(safeRef)) throw new Error("Browser element reference is invalid. Refresh the snapshot.");
    const expression = `(() => { const el = document.querySelector('[data-socketagent-ref="${safeRef}"]'); if (!el) return ''; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true });
    const serialized = readStringResult(result);
    if (!serialized) throw new Error("Browser element is no longer available. Refresh the snapshot.");
    const point = JSON.parse(serialized) as { x: number; y: number };
    await this.phoneInput(session.profile, { action: "tap", x: point.x, y: point.y });
  }

  async type(profileValue: string, ref: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const safeRef = String(ref).trim();
    if (!/^sa-[1-9][0-9]{0,3}$/.test(safeRef)) throw new Error("Browser element reference is invalid. Refresh the snapshot.");
    if (text.length > 16_384) throw new Error("Browser text input is too large.");
    const expression = `(() => { const el = document.querySelector('[data-socketagent-ref="${safeRef}"]'); if (!el) return false; const hint = [el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase(); if (/(password|passcode|one-time|otp|mfa|token|secret|recovery|verification.code)/.test(hint)) return 'password'; el.focus(); if ('select' in el) el.select(); return true; })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true });
    const nested = result.result as JsonRecord | undefined;
    if (nested?.value === "password") throw new Error("The agent cannot type into password fields. Open the protected phone browser.");
    if (nested?.value !== true) throw new Error("Browser element is no longer available. Refresh the snapshot.");
    await this.pressKey(session, "CTRL+A");
    await session.cdp.command("Input.insertText", { text });
  }

  async navigate(profileValue: string, rawUrl: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    session.url = normalizeBrowserUrl(rawUrl);
    await this.phoneInput(profileValue, { action: "navigate", url: rawUrl });
  }

  async key(profileValue: string, key: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    await this.pressKey(session, key);
  }

  async scroll(profileValue: string, deltaY: number): Promise<void> {
    await this.phoneInput(profileValue, { action: "scroll", deltaY });
  }

  async readClipboard(profileValue: string): Promise<string> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    await this.grantClipboardAccess(session);
    const result = await session.cdp.command("Runtime.evaluate", {
      expression: "navigator.clipboard.readText()",
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = runtimeExceptionDescription(result);
    if (exception) throw new Error(`The browser page did not allow clipboard access: ${exception}`);
    const text = readStringResult(result);
    if (text.length > 65_536) throw new Error("Browser clipboard text is too large.");
    this.touch(session);
    return text;
  }

  async writeClipboard(profileValue: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    if (text.length > 65_536) throw new Error("Browser clipboard text is too large.");
    await this.grantClipboardAccess(session);
    const result = await session.cdp.command("Runtime.evaluate", {
      expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = runtimeExceptionDescription(result);
    if (exception) {
      throw new Error(`The browser page did not allow clipboard access: ${exception}`);
    }
    this.touch(session);
  }

  async close(profileValue: string): Promise<void> {
    const profile = normalizeBrowserProfile(profileValue);
    const session = this.sessions.get(profile);
    if (!session) return;
    this.sessions.delete(profile);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cdp.close();
    session.process.kill("SIGTERM");
  }

  async clear(profileValue: string): Promise<void> {
    const profile = normalizeBrowserProfile(profileValue);
    await this.close(profile);
    const root = browserDataDir();
    const target = path.join(root, profile);
    if (path.dirname(target) !== root) throw new Error("Browser profile path is invalid.");
    fs.rmSync(target, { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((profile) => this.close(profile)));
  }

  private require(profile: string): RunningBrowserSession {
    const session = this.sessions.get(profile);
    if (!session) throw new Error(`Browser profile ${profile} is not running. Open it first.`);
    return session;
  }

  private touch(session: RunningBrowserSession): void {
    session.lastUsedAt = new Date().toISOString();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => void this.close(session.profile), IDLE_CLOSE_MS);
    session.idleTimer.unref?.();
  }

  private async summary(session: RunningBrowserSession): Promise<BrowserSessionSummary> {
    const [location, title] = await Promise.all([
      session.cdp.command("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      session.cdp.command("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
    ]);
    const url = readStringResult(location) || session.url;
    session.url = url;
    return {
      profile: session.profile,
      label: session.label,
      running: true,
      sessionId: session.sessionId,
      url,
      title: readStringResult(title),
      lastUsedAt: session.lastUsedAt,
    };
  }

  private async pressKey(session: RunningBrowserSession, rawKey: string): Promise<void> {
    const key = String(rawKey || "").trim().toUpperCase();
    const definitions: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }> = {
      ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      BACKSPACE: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      ESCAPE: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      "CTRL+A": { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
    };
    const definition = definitions[key];
    if (!definition) throw new Error("Supported browser keys are Enter, Tab, Backspace, Escape, and Ctrl+A.");
    await session.cdp.command("Input.dispatchKeyEvent", { type: "keyDown", ...definition });
    await session.cdp.command("Input.dispatchKeyEvent", { type: "keyUp", ...definition });
    this.touch(session);
  }

  private async grantClipboardAccess(session: RunningBrowserSession): Promise<void> {
    await session.cdp.command("Page.bringToFront");
    const location = await session.cdp.command("Runtime.evaluate", {
      expression: "location.origin",
      returnByValue: true,
    });
    const origin = readStringResult(location);
    if (!/^https?:\/\//.test(origin)) {
      throw new Error("Clipboard access requires an HTTP or HTTPS page.");
    }
    await session.cdp.command("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
  }

  private async historyStep(session: RunningBrowserSession, delta: number): Promise<void> {
    const result = await session.cdp.command("Page.getNavigationHistory");
    const currentIndex = Number(result.currentIndex);
    const entries = Array.isArray(result.entries) ? result.entries as JsonRecord[] : [];
    const target = entries[currentIndex + delta];
    if (target && typeof target.id === "number") {
      await session.cdp.command("Page.navigateToHistoryEntry", { entryId: target.id });
    }
  }

  private async waitForDebuggingPort(
    profileDir: string,
    processHandle: ChildProcess,
  ): Promise<number> {
    const activePortPath = path.join(profileDir, "DevToolsActivePort");
    for (let attempt = 0; attempt < 150; attempt++) {
      if (processHandle.exitCode !== null) throw new Error("Browser exited before its control channel opened.");
      try {
        const port = Number(fs.readFileSync(activePortPath, "utf8").split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      } catch {}
      await wait(100);
    }
    throw new Error("Browser control channel did not start within 15 seconds.");
  }

  private async waitForPageTarget(port: number): Promise<CdpTarget[]> {
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json() as CdpTarget[];
        if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return targets;
      } catch {}
      await wait(100);
    }
    throw new Error("Browser page did not become available within 15 seconds.");
  }
}

export const browserSessionManager = new BrowserSessionManager();
