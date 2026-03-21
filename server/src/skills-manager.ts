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
  /** Whether this plugin is currently enabled */
  enabled: boolean;
  /** Whether this plugin is installed locally on disk */
  installed: boolean;
  /** README.md content (if present and installed) */
  readme: string;
  /** Homepage URL */
  homepage: string;
}

const ENABLED_PLUGINS_PATH = path.join(os.homedir(), ".claude-assistant", "enabled-plugins.json");

function readEnabledPlugins(): Record<string, string> {
  try {
    if (fs.existsSync(ENABLED_PLUGINS_PATH)) {
      return JSON.parse(fs.readFileSync(ENABLED_PLUGINS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function writeEnabledPlugins(data: Record<string, string>): void {
  const dir = path.dirname(ENABLED_PLUGINS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ENABLED_PLUGINS_PATH, JSON.stringify(data, null, 2));
}

/** Resolve the local path for a plugin from its marketplace.json source entry */
function resolvePluginPath(mpDir: string, source: any): string | null {
  if (typeof source === "string" && source.startsWith("./")) {
    // Relative path within the marketplace repo
    const resolved = path.resolve(mpDir, source);
    return fs.existsSync(resolved) ? resolved : null;
  }
  // For external sources (github, url, npm, git-subdir), check the cache
  // The SDK installs these into ~/.claude/plugins/cache/{marketplace}/{pluginName}/{version}/
  return null;
}

/** List all marketplace plugins by reading marketplace.json registries */
export function listMarketplacePlugins(): MarketplacePlugin[] {
  const home = os.homedir();
  const pluginsBase = path.join(home, ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(pluginsBase)) return [];

  const enabled = readEnabledPlugins();
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

        // Check if installed locally
        const localPath = resolvePluginPath(mpDir, entry.source);
        const installed = localPath !== null;

        // Read README from local install if available
        let readme = "";
        if (localPath) {
          const readmePath = path.join(localPath, "README.md");
          if (fs.existsSync(readmePath)) {
            try { readme = fs.readFileSync(readmePath, "utf-8"); } catch {}
          }
        }

        results.push({
          id,
          name,
          description,
          author,
          version,
          pluginPath: localPath || "",
          marketplace,
          category,
          enabled: id in enabled,
          installed,
          readme,
          homepage,
        });
      }
    }
  } catch {}

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Toggle a marketplace plugin on/off. Returns updated plugin list. */
export function togglePlugin(pluginId: string, enable: boolean): MarketplacePlugin[] {
  const enabled = readEnabledPlugins();

  if (enable) {
    const all = listMarketplacePlugins();
    const plugin = all.find(p => p.id === pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    if (!plugin.installed || !plugin.pluginPath) throw new Error(`Plugin not installed locally: ${pluginId}`);
    enabled[pluginId] = plugin.pluginPath;
  } else {
    delete enabled[pluginId];
  }

  writeEnabledPlugins(enabled);
  return listMarketplacePlugins();
}

/** Get filesystem paths of all enabled plugins (for passing to SDK query options) */
export function getEnabledPluginPaths(): string[] {
  const enabled = readEnabledPlugins();
  return Object.values(enabled).filter(p => fs.existsSync(p));
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
