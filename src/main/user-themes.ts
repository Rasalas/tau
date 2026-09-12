import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import type { UserTheme } from "../shared/contracts.js";

export interface UserThemePaths {
  globalThemesDir?: string;
  projectThemesDir?: (cwd: string) => string;
  piGlobalThemesDir?: string;
  piProjectThemesDir?: (cwd: string) => string;
}

export function defaultGlobalThemesDir(home = homedir()): string {
  return process.env.TAU_THEMES_DIR || join(home, ".tau", "themes");
}

export function defaultProjectThemesDir(cwd: string): string {
  return join(cwd, ".tau", "themes");
}

export function defaultPiGlobalThemesDir(home = homedir()): string {
  return join(home, ".pi", "agent", "themes");
}

export function defaultPiProjectThemesDir(cwd: string): string {
  return join(cwd, ".pi", "themes");
}

function titleCase(input: string): string {
  return input
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractCssThemeName(css: string, fallback: string): string {
  const match = css.match(/\/\*\s*(?:theme|name):\s*([^*]+?)\s*\*\//i);
  return match?.[1]?.trim() || fallback;
}

/**
 * Translates a Pi CLI theme JSON (which defines `vars` and `colors`)
 * into CSS custom properties that match Tau's token contract.
 */
export function piThemeJsonToCss(id: string, parsed: Record<string, unknown>, base = "dark"): string {
  const vars = (typeof parsed.vars === "object" && parsed.vars !== null)
    ? (parsed.vars as Record<string, string>)
    : {};
  const colors = (typeof parsed.colors === "object" && parsed.colors !== null)
    ? (parsed.colors as Record<string, string>)
    : {};

  const resolveColor = (val: string | undefined): string | undefined => {
    if (!val) return undefined;
    if (val.startsWith("#") || val.startsWith("rgb") || val.startsWith("hsl")) return val;
    return vars[val] ?? val;
  };

  const text = resolveColor(colors.text) ?? resolveColor(vars.text);
  const muted = resolveColor(colors.muted) ?? resolveColor(vars.gray);
  const dim = resolveColor(colors.dim) ?? resolveColor(vars.dimGray);
  const accent = resolveColor(colors.accent) ?? resolveColor(vars.accent);
  const border = resolveColor(colors.border) ?? resolveColor(vars.blue);
  const borderMuted = resolveColor(colors.borderMuted) ?? resolveColor(vars.darkGray);
  const success = resolveColor(colors.success) ?? resolveColor(vars.green);
  const error = resolveColor(colors.error) ?? resolveColor(vars.red);
  const warning = resolveColor(colors.warning) ?? resolveColor(vars.yellow);
  const selectedBg = resolveColor(colors.selectedBg) ?? resolveColor(vars.selectedBg);
  const userMsgBg = resolveColor(colors.userMessageBg) ?? resolveColor(vars.userMsgBg);

  const lines: string[] = [
    `:root, :root[data-theme="${id}"] {`,
    `  color-scheme: ${base};`,
  ];

  if (text) lines.push(`  --ink-1: ${text};`);
  if (muted) lines.push(`  --ink-2: ${muted};`);
  if (dim) {
    lines.push(`  --ink-3: ${dim};`);
    lines.push(`  --ink-4: ${dim};`);
  }
  if (accent) {
    lines.push(`  --accent: ${accent};`);
    lines.push(`  --accent-hover: ${accent};`);
  }
  if (border) lines.push(`  --line: ${border};`);
  if (borderMuted) lines.push(`  --line-subtle: ${borderMuted};`);
  if (success) lines.push(`  --green: ${success};`);
  if (error) lines.push(`  --red: ${error};`);
  if (warning) lines.push(`  --amber: ${warning};`);
  if (selectedBg) {
    lines.push(`  --hover: ${selectedBg};`);
    lines.push(`  --thread-active: ${selectedBg};`);
  }
  if (userMsgBg) {
    lines.push(`  --raised: ${userMsgBg};`);
    lines.push(`  --sunken: ${userMsgBg};`);
  }

  lines.push("}");
  return lines.join("\n");
}

export function jsonToCss(id: string, parsed: Record<string, unknown>, base = "dark"): string {
  if (typeof parsed.css === "string") return parsed.css;

  // Detect Pi theme format (colors or vars present)
  if ((typeof parsed.colors === "object" && parsed.colors !== null) || (typeof parsed.vars === "object" && parsed.vars !== null)) {
    return piThemeJsonToCss(id, parsed, base);
  }

  const variables = (typeof parsed.variables === "object" && parsed.variables !== null)
    ? (parsed.variables as Record<string, unknown>)
    : parsed;

  const lines: string[] = [
    `:root, :root[data-theme="${id}"] {`,
    `  color-scheme: ${base};`,
  ];

  for (const [key, value] of Object.entries(variables)) {
    if (key === "name" || key === "base" || key === "variables") continue;
    if (typeof value === "string" || typeof value === "number") {
      const varName = key.startsWith("--") ? key : `--${key}`;
      lines.push(`  ${varName}: ${value};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

export class UserThemeResolver {
  private readonly globalDir: string;
  private readonly projectDirResolver: (cwd: string) => string;
  private readonly piGlobalDir: string;
  private readonly piProjectDirResolver: (cwd: string) => string;
  private activeTheme = "dark";
  private activeThemeObject: Record<string, unknown> = {};

  constructor(paths: UserThemePaths = {}) {
    this.globalDir = paths.globalThemesDir ?? defaultGlobalThemesDir();
    this.projectDirResolver = paths.projectThemesDir ?? defaultProjectThemesDir;
    this.piGlobalDir = paths.piGlobalThemesDir ?? defaultPiGlobalThemesDir();
    this.piProjectDirResolver = paths.piProjectThemesDir ?? defaultPiProjectThemesDir;
  }

  getActiveTheme(): string {
    return this.activeTheme;
  }

  setActiveTheme(name: string): void {
    this.activeTheme = name;
  }

  getActiveThemeObject(): Record<string, unknown> {
    return this.activeThemeObject;
  }

  setActiveThemeObject(themeObj: Record<string, unknown>): void {
    this.activeThemeObject = themeObj;
  }

  async list(cwd?: string): Promise<UserTheme[]> {
    const themesMap = new Map<string, UserTheme>();

    // 1. Read Pi global themes (~/.pi/agent/themes)
    const piGlobalThemes = await this.readDir(this.piGlobalDir);
    for (const theme of piGlobalThemes) {
      themesMap.set(theme.id, theme);
    }

    // 2. Read Tau global themes (~/.tau/themes)
    const globalThemes = await this.readDir(this.globalDir);
    for (const theme of globalThemes) {
      themesMap.set(theme.id, theme);
    }

    if (cwd) {
      // 3. Read Pi project themes (<project>/.pi/themes)
      const piProjectDir = this.piProjectDirResolver(cwd);
      const piProjectThemes = await this.readDir(piProjectDir);
      for (const theme of piProjectThemes) {
        themesMap.set(theme.id, theme);
      }

      // 4. Read Tau project themes (<project>/.tau/themes)
      const projectDir = this.projectDirResolver(cwd);
      const projectThemes = await this.readDir(projectDir);
      for (const theme of projectThemes) {
        themesMap.set(theme.id, theme);
      }
    }

    return Array.from(themesMap.values());
  }

  private async readDir(dir: string): Promise<UserTheme[]> {
    if (!existsSync(dir)) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const themes: UserTheme[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        if (ext !== ".css" && ext !== ".json") continue;

        const filePath = join(dir, entry.name);
        const id = basename(entry.name, ext);

        try {
          const content = await readFile(filePath, "utf8");
          if (ext === ".css") {
            const name = extractCssThemeName(content, titleCase(id));
            themes.push({
              id,
              name,
              css: content,
              sourcePath: filePath,
            });
          } else if (ext === ".json") {
            const parsed = JSON.parse(content) as Record<string, unknown>;
            const base = (parsed.base === "light" || parsed.base === "system") ? parsed.base : "dark";
            const name = typeof parsed.name === "string" && parsed.name ? parsed.name : titleCase(id);
            const css = jsonToCss(id, parsed, base);
            themes.push({
              id,
              name,
              base,
              css,
              sourcePath: filePath,
            });
          }
        } catch {
          // Ignore invalid theme files gracefully
        }
      }

      return themes;
    } catch {
      return [];
    }
  }
}

export const defaultUserThemeResolver = new UserThemeResolver();
