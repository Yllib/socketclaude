#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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
  return Boolean(executable && fs.existsSync(executable));
}

function runBrowserCheck(executable, args, outputFd, errorFd) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", outputFd, errorFd],
    });
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, error, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGKILL");
      }
      setTimeout(() => finish(null, new Error("Browser launch timed out.")), 5_000);
    }, 30_000);
    child.once("error", (error) => finish(null, error));
    child.once("close", (status) => finish(status, undefined));
  });
}

async function validateHeadlessLaunch(executable) {
  const profileRoot = process.platform === "linux"
    && (executable === "/usr/bin/chromium-browser" || executable === "/snap/bin/chromium")
    ? path.join(process.env.HOME || os.homedir(), "snap", "chromium", "common")
    : os.tmpdir();
  fs.mkdirSync(profileRoot, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(profileRoot, "socketagent-browser-check-"));
  const outputPath = path.join(profileDir, "validation-output.txt");
  const errorPath = path.join(profileDir, "validation-error.txt");
  const outputFd = fs.openSync(outputPath, "w");
  const errorFd = fs.openSync(errorPath, "w");
  try {
    const result = await runBrowserCheck(executable, [
      "--headless",
      "--disable-gpu",
      "--disable-background-mode",
      "--disable-features=msEdgeFirstRunExperience",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      "data:text/html,<title>SocketAgent</title><p>ok</p>",
    ], outputFd, errorFd);
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    const output = fs.readFileSync(outputPath, "utf8");
    const errorOutput = fs.readFileSync(errorPath, "utf8");
    if (result.status !== 0 || !output.includes("<p>ok</p>")) {
      const detail = String(errorOutput || output || result.error?.message || (result.timedOut ? "Browser launch timed out." : "Browser launch failed"))
        .trim()
        .split(/\r?\n/)
        .slice(-4)
        .join(" ")
        .slice(0, 800);
      throw new Error(`Browser runtime could not start headless. ${detail}`);
    }
  } finally {
    try { fs.closeSync(outputFd); } catch {}
    try { fs.closeSync(errorFd); } catch {}
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
    try {
      await validateHeadlessLaunch(systemBrowser);
      console.log(`Browser runtime available: ${systemBrowser}`);
      return;
    } catch (error) {
      if (process.platform === "linux") throw error;
      console.warn(`System browser is not automation-compatible; installing a managed runtime. ${error.message}`);
    }
  }

  if (process.platform === "linux") {
    throw new Error(
      "No compatible system browser was found. Install the OS-packaged Chromium browser or set SOCKETAGENT_BROWSER_BINARY.",
    );
  }

  const markedBrowser = existingMarker();
  if (executableWorks(markedBrowser)) {
    await validateHeadlessLaunch(markedBrowser);
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

  await validateHeadlessLaunch(browser.executablePath);
  writeMarker(browser.executablePath);
  console.log(`Managed browser runtime installed: ${browser.executablePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
