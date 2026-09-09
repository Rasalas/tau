import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import type { UserTheme } from "../shared/contracts.js";

export interface UserThemePaths {
  globalThemesDir?: string;
  projectThemesDir?: (cwd: string) => string;
}

export function defaultGlobalThemesDir(home = homedir()): string {
  return process.env.TAU_THEMES_DIR || join(home, ".tau", "themes");
}

export function defaultProjectThemesDir(cwd: string): string {
  return join(cwd, ".tau", "themes");
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

function jsonToCss(id: string, parsed: Record<string, unknown>, base = "dark"): string {
  if (typeof parsed.css === "string") return parsed.css;
  const variables = (typeof parsed.variables === "object" && parsed.variables !== null)
    ? parsed.variables as Record<string, unknown>
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

  constructor(paths: UserThemePaths = {}) {
    this.globalDir = paths.globalThemesDir ?? defaultGlobalThemesDir();
    this.projectDirResolver = paths.projectThemesDir ?? defaultProjectThemesDir;
  }

  async list(cwd?: string): Promise<UserTheme[]> {
    const themesMap = new Map<string, UserTheme>();

    // 1. Read global themes
    const globalThemes = await this.readDir(this.globalDir);
    for (const theme of globalThemes) {
      themesMap.set(theme.id, theme);
    }

    // 2. Read project themes (takes precedence over global if same id)
    if (cwd) {
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
