#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  Browser,
  BrowserTag,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} = require("@puppeteer/browsers");

function dataDir() {
  return process.env.SOCKET_AGENT_DATA_DIR
    || process.env.SOCKETAGENT_DATA_DIR
    || path.join(process.env.HOME || os.homedir(), ".socket-agent");
}

function runtimeDir() {
  return path.join(dataDir(), "browser-runtime");
}

function markerPath() {
  return path.join(runtimeDir(), "executable-path");
}

function systemCandidates() {
  const configured = process.env.SOCKETAGENT_BROWSER_BINARY?.trim();
  const candidates = configured ? [configured] : [];
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
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

function existingMarker() {
  try {
    return fs.readFileSync(markerPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function executableWorks(executable) {
  if (!executable || !fs.existsSync(executable)) return false;
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0;
}

function validateHeadlessLaunch(executable) {
  const profileRoot = process.platform === "linux"
    && (executable === "/usr/bin/chromium-browser" || executable === "/snap/bin/chromium")
    ? path.join(process.env.HOME || os.homedir(), "snap", "chromium", "common")
    : os.tmpdir();
  fs.mkdirSync(profileRoot, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(profileRoot, "socketagent-browser-check-"));
  try {
    const result = spawnSync(executable, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      "data:text/html,<title>SocketAgent</title><p>ok</p>",
    ], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !String(result.stdout || "").includes("<p>ok</p>")) {
      const detail = String(result.stderr || result.stdout || "Browser launch failed")
        .trim()
        .split(/\r?\n/)
        .slice(-4)
        .join(" ")
        .slice(0, 800);
      throw new Error(`Browser runtime could not start headless. ${detail}`);
    }
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function writeMarker(executable) {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir(), 0o700); } catch {}
  const tempPath = `${markerPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${executable}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, markerPath());
}

async function main() {
  const systemBrowser = systemCandidates().find(executableWorks);
  if (systemBrowser) {
    validateHeadlessLaunch(systemBrowser);
    console.log(`Browser runtime available: ${systemBrowser}`);
    return;
  }

  if (process.platform === "linux") {
    throw new Error(
      "No compatible system browser was found. Install the OS-packaged Chromium browser or set SOCKETAGENT_BROWSER_BINARY.",
    );
  }

  const markedBrowser = existingMarker();
  if (executableWorks(markedBrowser)) {
    validateHeadlessLaunch(markedBrowser);
    console.log(`Managed browser runtime available: ${markedBrowser}`);
    return;
  }

  const platform = detectBrowserPlatform();
  if (!platform || platform === "linux_arm") {
    throw new Error(
      "No compatible system browser was found, and Chrome for Testing is unavailable for this platform.",
    );
  }

  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  const installed = (await getInstalledBrowsers({ cacheDir: runtimeDir() }))
    .filter((browser) => browser.browser === Browser.CHROME && browser.platform === platform)
    .filter((browser) => executableWorks(browser.executablePath))
    .sort((left, right) => left.buildId.localeCompare(right.buildId, undefined, { numeric: true }))
    .at(-1);

  let browser = installed;
  if (!browser) {
    const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
    console.log(`Downloading Chrome for Testing ${buildId}...`);
    browser = await install({
      browser: Browser.CHROME,
      buildId,
      buildIdAlias: BrowserTag.STABLE,
      cacheDir: runtimeDir(),
      platform,
      downloadProgressCallback: "default",
    });
  }

  validateHeadlessLaunch(browser.executablePath);
  writeMarker(browser.executablePath);
  console.log(`Managed browser runtime installed: ${browser.executablePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
