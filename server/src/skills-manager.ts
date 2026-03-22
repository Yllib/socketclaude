import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SkillEntry {
  name: string;
  description: string;
  scope: "user" | "project" | "plugin";
  /** For plugin scope, which plugin it belongs to */
  pluginName?: string;
  /** Absolute path to the file */
  filePath: string;
  /** "command" (commands dir) or "skill" (skills dir with SKILL.md) */
  format: "command" | "skill";
  /** Parsed frontmatter fields */
  frontmatter: Record<string, string>;
  /** Body content (everything after frontmatter) */
  body: string;
}

/** Parse YAML frontmatter from a markdown file. Returns { frontmatter, body }. */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  let body = content;
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (match) {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        fm[key] = val;
      }
    }
    body = match[2];
  }
  return { frontmatter: fm, body };
}

/** Build markdown file content from frontmatter + body */
function buildFileContent(frontmatter: Record<string, string>, body: string): string {
  const fmLines = Object.entries(frontmatter)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  if (fmLines.length === 0) return body;
  return `---\n${fmLines.join("\n")}\n---\n\n${body}`;
}

/** Scan a commands directory for *.md files */
function scanCommandsDir(dir: string, scope: SkillEntry["scope"], pluginName?: string): SkillEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);
        entries.push({
          name: file.replace(/\.md$/, ""),
          description: frontmatter.description || "",
          scope,
          pluginName,
          filePath,
          format: "command",
          frontmatter,
          body,
        });
      } catch {}
    }
  } catch {}
  return entries;
}

/** Scan a skills directory for SKILL.md files in subdirectories */
function scanSkillsDir(dir: string, scope: SkillEntry["scope"], pluginName?: string): SkillEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  try {
    const subdirs = fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
    });
    for (const sub of subdirs) {
      const filePath = path.join(dir, sub, "SKILL.md");
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);
        entries.push({
          name: frontmatter.name || sub,
          description: frontmatter.description || "",
          scope,
          pluginName,
          filePath,
          format: "skill",
          frontmatter,
          body,
        });
      } catch {}
    }
  } catch {}
  return entries;
}

/** List all skills across user, project, and plugin scopes */
export function listSkills(projectCwd?: string): SkillEntry[] {
  const home = os.homedir();
  const results: SkillEntry[] = [];

  // User-level commands & skills
  results.push(...scanCommandsDir(path.join(home, ".claude", "commands"), "user"));
  results.push(...scanSkillsDir(path.join(home, ".claude", "skills"), "user"));

  // Project-level commands & skills
  if (projectCwd) {
    results.push(...scanCommandsDir(path.join(projectCwd, ".claude", "commands"), "project"));
    results.push(...scanSkillsDir(path.join(projectCwd, ".claude", "skills"), "project"));
  }

  // Plugin commands & skills
  const pluginsBase = path.join(home, ".claude", "plugins", "marketplaces");
  if (fs.existsSync(pluginsBase)) {
    try {
      for (const marketplace of fs.readdirSync(pluginsBase)) {
        const mpDir = path.join(pluginsBase, marketplace);
        // plugins/ subdirectory
        const pluginsDir = path.join(mpDir, "plugins");
        if (fs.existsSync(pluginsDir)) {
          for (const pluginDir of fs.readdirSync(pluginsDir)) {
            const pBase = path.join(pluginsDir, pluginDir);
            results.push(...scanCommandsDir(path.join(pBase, "commands"), "plugin", pluginDir));
            results.push(...scanSkillsDir(path.join(pBase, "skills"), "plugin", pluginDir));
          }
        }
        // external_plugins/ subdirectory
        const extDir = path.join(mpDir, "external_plugins");
        if (fs.existsSync(extDir)) {
          for (const pluginDir of fs.readdirSync(extDir)) {
            const pBase = path.join(extDir, pluginDir);
            results.push(...scanCommandsDir(path.join(pBase, "commands"), "plugin", pluginDir));
            results.push(...scanSkillsDir(path.join(pBase, "skills"), "plugin", pluginDir));
          }
        }
      }
    } catch {}
  }

  return results;
}

/** Read a single skill file by absolute path */
export function getSkill(filePath: string): SkillEntry | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const isSkill = path.basename(filePath) === "SKILL.md";
    const name = isSkill
      ? (frontmatter.name || path.basename(path.dirname(filePath)))
      : path.basename(filePath, ".md");
    return {
      name,
      description: frontmatter.description || "",
      scope: "user", // caller should know the real scope
      filePath,
      format: isSkill ? "skill" : "command",
      frontmatter,
      body,
    };
  } catch {
    return null;
  }
}

/** Create or update a skill/command file. Returns the written file path. */
export function saveSkill(opts: {
  filePath?: string;
  name: string;
  scope: "user" | "project";
  format: "command" | "skill";
  frontmatter: Record<string, string>;
  body: string;
  projectCwd?: string;
}): string {
  const home = os.homedir();
  let targetPath = opts.filePath;

  if (!targetPath) {
    // New file — compute path from scope + format + name
    const baseDir = opts.scope === "user"
      ? path.join(home, ".claude")
      : path.join(opts.projectCwd || process.cwd(), ".claude");

    if (opts.format === "skill") {
      const dir = path.join(baseDir, "skills", opts.name);
      fs.mkdirSync(dir, { recursive: true });
      targetPath = path.join(dir, "SKILL.md");
    } else {
      const dir = path.join(baseDir, "commands");
      fs.mkdirSync(dir, { recursive: true });
      targetPath = path.join(dir, `${opts.name}.md`);
    }
  }

  const content = buildFileContent(opts.frontmatter, opts.body);
  fs.writeFileSync(targetPath, content);
  return targetPath;
}

// ── Marketplace plugin management ──

export interface MarketplacePlugin {
  /** Unique ID: pluginName@marketplace */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Author name */
  author: string;
  /** Version */
  version: string;
  /** Absolute path to the plugin directory (if installed locally) */
  pluginPath: string;
  /** Which marketplace this comes from */
  marketplace: string;
  /** Category from marketplace.json */
  category: string;
  /** Whether this plugin is installed (present in enabledPlugins settings) */
  installed: boolean;
  /** Whether this plugin is enabled (installed + not false in enabledPlugins) */
  enabled: boolean;
  /** README.md content (if present and installed) */
  readme: string;
  /** Homepage URL */
  homepage: string;
}

/** Read enabledPlugins from ~/.claude/settings.json — the SDK's native plugin state */
function readEnabledPluginsSetting(): Record<string, any> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return settings.enabledPlugins || {};
    }
  } catch {}
  return {};
}

/** Resolve the local path for a plugin — check relative source paths and the SDK cache */
function resolvePluginPath(mpDir: string, pluginName: string, marketplace: string, source: any): string | null {
  // Relative path within the marketplace repo (internal plugins)
  if (typeof source === "string" && source.startsWith("./")) {
    const resolved = path.resolve(mpDir, source);
    if (fs.existsSync(resolved)) return resolved;
  }
  // SDK cache for installed external plugins: ~/.claude/plugins/cache/{marketplace}/{pluginName}/{version}/
  const cacheBase = path.join(os.homedir(), ".claude", "plugins", "cache", marketplace, pluginName);
  if (fs.existsSync(cacheBase)) {
    try {
      // Find the latest version directory
      const versions = fs.readdirSync(cacheBase).filter(f => {
        try { return fs.statSync(path.join(cacheBase, f)).isDirectory(); } catch { return false; }
      });
      if (versions.length > 0) {
        // Use the last one (highest version or most recent)
        return path.join(cacheBase, versions[versions.length - 1]);
      }
    } catch {}
  }
  return null;
}

/** List all marketplace plugins by reading marketplace.json registries */
export function listMarketplacePlugins(): MarketplacePlugin[] {
  const home = os.homedir();
  const pluginsBase = path.join(home, ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(pluginsBase)) return [];

  const enabledSettings = readEnabledPluginsSetting();
  const results: MarketplacePlugin[] = [];

  try {
    for (const marketplace of fs.readdirSync(pluginsBase)) {
      const mpDir = path.join(pluginsBase, marketplace);
      if (!fs.statSync(mpDir).isDirectory()) continue;

      // Read marketplace.json — the source of truth for available plugins
      const marketplaceJsonPath = path.join(mpDir, ".claude-plugin", "marketplace.json");
      if (!fs.existsSync(marketplaceJsonPath)) continue;

      let registry: any;
      try {
        registry = JSON.parse(fs.readFileSync(marketplaceJsonPath, "utf-8"));
      } catch { continue; }

      const plugins = registry.plugins || [];
      for (const entry of plugins) {
        const name = entry.name || "";
        if (!name) continue;

        const id = `${name}@${marketplace}`;
        const description = entry.description || "";
        const author = entry.author?.name || registry.owner?.name || "";
        const version = entry.version || "";
        const category = entry.category || "";
        const homepage = entry.homepage || "";

        // Check install/enable state from settings.json enabledPlugins
        const settingValue = enabledSettings[id];
        const installed = settingValue !== undefined;
        const enabled = installed && settingValue !== false;

        // Resolve local path (from marketplace repo or SDK cache)
        const localPath = resolvePluginPath(mpDir, name, marketplace, entry.source);

        // Read README from local install if available
        let readme = "";
        if (localPath) {
          const readmePath = path.join(localPath, "README.md");
          if (fs.existsSync(readmePath)) {
            try { readme = fs.readFileSync(readmePath, "utf-8"); } catch {}
          }
        }

        results.push({
          id, name, description, author, version,
          pluginPath: localPath || "",
          marketplace, category, installed, enabled,
          readme, homepage,
        });
      }
    }
  } catch {}

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Marketplace CRUD ──

export interface MarketplaceInfo {
  /** Directory name (used as identifier) */
  name: string;
  /** Remote git URL (if available) */
  url: string;
  /** Number of plugins in this marketplace */
  pluginCount: number;
  /** Owner/author from marketplace.json */
  owner: string;
  /** Description from marketplace.json */
  description: string;
}

function getMarketplacesDir(): string {
  return path.join(os.homedir(), ".claude", "plugins", "marketplaces");
}

/** List all installed marketplaces with metadata */
export function listMarketplaces(): MarketplaceInfo[] {
  const base = getMarketplacesDir();
  if (!fs.existsSync(base)) return [];

  const { execSync } = require("child_process") as typeof import("child_process");
  const results: MarketplaceInfo[] = [];

  for (const name of fs.readdirSync(base)) {
    const mpDir = path.join(base, name);
    try { if (!fs.statSync(mpDir).isDirectory()) continue; } catch { continue; }

    let url = "";
    try {
      url = execSync("git remote get-url origin", { cwd: mpDir, stdio: "pipe", timeout: 5000 }).toString().trim();
    } catch {}

    let pluginCount = 0;
    let owner = "";
    let description = "";
    const jsonPath = path.join(mpDir, ".claude-plugin", "marketplace.json");
    try {
      if (fs.existsSync(jsonPath)) {
        const registry = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        pluginCount = (registry.plugins || []).length;
        owner = registry.owner?.name || "";
        description = registry.description || "";
      }
    } catch {}

    results.push({ name, url, pluginCount, owner, description });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Add a marketplace by cloning a git repo */
export async function addMarketplace(url: string): Promise<MarketplaceInfo> {
  const { exec } = require("child_process") as typeof import("child_process");
  const base = getMarketplacesDir();
  fs.mkdirSync(base, { recursive: true });

  // Derive directory name from URL (e.g. "https://github.com/user/my-plugins.git" → "my-plugins")
  const urlName = url.replace(/\.git$/, "").split("/").pop() || "marketplace";

  // Ensure unique name
  let dirName = urlName;
  let i = 2;
  while (fs.existsSync(path.join(base, dirName))) {
    dirName = `${urlName}-${i++}`;
  }

  const target = path.join(base, dirName);

  return new Promise((resolve, reject) => {
    exec(`git clone "${url}" "${target}"`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || stdout || err.message || "git clone failed"));
        return;
      }
      // Read back the marketplace info
      const all = listMarketplaces();
      const info = all.find(m => m.name === dirName);
      resolve(info || { name: dirName, url, pluginCount: 0, owner: "", description: "" });
    });
  });
}

/** Update a marketplace by pulling latest from git */
export async function updateMarketplace(name: string): Promise<MarketplaceInfo> {
  const { exec } = require("child_process") as typeof import("child_process");
  const mpDir = path.join(getMarketplacesDir(), name);
  if (!fs.existsSync(mpDir)) throw new Error(`Marketplace "${name}" not found`);

  return new Promise((resolve, reject) => {
    exec("git pull", { cwd: mpDir, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || stdout || err.message || "git pull failed"));
        return;
      }
      const all = listMarketplaces();
      const info = all.find(m => m.name === name);
      resolve(info || { name, url: "", pluginCount: 0, owner: "", description: "" });
    });
  });
}

/** Remove a marketplace directory */
export function removeMarketplace(name: string): void {
  const mpDir = path.join(getMarketplacesDir(), name);
  if (!fs.existsSync(mpDir)) throw new Error(`Marketplace "${name}" not found`);
  fs.rmSync(mpDir, { recursive: true, force: true });
}

/** Cached claude binary path */
let _claudeBinary: string | null = null;

/** Resolve the claude CLI binary path, caching the result */
function resolveClaudeBinary(): string {
  if (_claudeBinary) return _claudeBinary;

  const { execSync } = require("child_process") as typeof import("child_process");
  const isWindows = process.platform === "win32";

  // Try which/where first
  try {
    const cmd = isWindows ? "where claude" : "which claude";
    const result = execSync(cmd, { timeout: 5000, encoding: "utf-8" }).trim().split("\n")[0];
    if (result) {
      _claudeBinary = result;
      console.log(`[Plugin] Resolved claude binary via ${isWindows ? 'where' : 'which'}: ${result}`);
      return result;
    }
  } catch {}

  // Fall back to common locations
  const home = os.homedir();
  const candidates = isWindows
    ? [
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      _claudeBinary = candidate;
      console.log(`[Plugin] Resolved claude binary via fallback: ${candidate}`);
      return candidate;
    }
  }

  // Last resort — hope it's in PATH
  _claudeBinary = "claude";
  console.warn(`[Plugin] Could not resolve claude binary, using bare 'claude'`);
  return "claude";
}

/** Run a claude CLI plugin command. Returns stdout on success, throws on failure. */
export async function runPluginCommand(action: "install" | "uninstall" | "enable" | "disable", pluginId: string): Promise<string> {
  const { exec } = require("child_process") as typeof import("child_process");
  const claudeBin = resolveClaudeBinary();
  const cmd = `"${claudeBin}" plugin ${action} ${pluginId} --scope user`;
  console.log(`[Plugin] Running: ${cmd}`);
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 60000, env: { ...process.env, HOME: os.homedir() } }, (err: any, stdout: string, stderr: string) => {
      const output = (stdout || "") + (stderr || "");
      if (err) {
        console.error(`[Plugin] ${action} failed: ${output}`);
        reject(new Error(output || err.message || `${action} failed`));
      } else {
        console.log(`[Plugin] ${action} ok: ${output.slice(0, 200)}`);
        resolve(output);
      }
    });
  });
}

/** Delete a skill/command file. For skills, also removes the parent directory if empty. */
export function deleteSkill(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    // For SKILL.md, try to clean up the parent directory
    if (path.basename(filePath) === "SKILL.md") {
      const dir = path.dirname(filePath);
      try {
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0) fs.rmdirSync(dir);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}
