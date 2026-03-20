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
