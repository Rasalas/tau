import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TerminalFontDefaults } from "./protocol.js";

/**
 * The font the user's Ghostty draws with, read from its config files and
 * never written. Only the keys a terminal font needs are understood; every
 * other line is skipped. Syntax: `key = value`, a value may be wrapped in
 * double quotes, a line starting with `#` is a comment, an empty value resets
 * the key, and `config-file` includes another file (a leading `?` makes it
 * optional) once the including file is done.
 */

/** How deep `config-file` may nest before the reader stops following it. */
const MAX_INCLUDE_DEPTH = 10;

export interface GhosttyFontState {
  families: string[];
  size?: number;
  /** Files that were read, in the order Ghostty applies them. */
  files: string[];
  problems: string[];
}

export type ReadText = (path: string) => string | undefined;

/** Where Ghostty looks for its configuration, in the order it applies them. */
export function ghosttyConfigPaths(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const paths = [join(xdg, "ghostty", "config"), join(xdg, "ghostty", "config.ghostty")];
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "com.mitchellh.ghostty");
    paths.push(join(support, "config"), join(support, "config.ghostty"));
  }
  return paths;
}

/** One `key = value` line, or nothing for a comment, a blank or a line without `=`. */
export function parseGhosttyLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const equals = trimmed.indexOf("=");
  if (equals <= 0) return undefined;
  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
  return { key, value };
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * Applies one file and then the files it includes, depth first. `seen` holds
 * every file already applied, so a cycle is read once and not followed again.
 */
function applyFile(
  state: GhosttyFontState,
  path: string,
  read: ReadText,
  home: string,
  seen: Set<string>,
  depth: number,
  optional: boolean,
): void {
  if (seen.has(path)) return;
  const text = read(path);
  if (text === undefined) {
    if (!optional) state.problems.push(`${path}: not found`);
    return;
  }
  seen.add(path);
  state.files.push(path);
  const includes: Array<{ path: string; optional: boolean }> = [];
  for (const line of text.split(/\r?\n/u)) {
    const entry = parseGhosttyLine(line);
    if (!entry) continue;
    if (entry.key === "font-family") {
      // Repeating the key adds a fallback; an empty value clears the list.
      if (entry.value) state.families.push(entry.value);
      else state.families = [];
    } else if (entry.key === "font-size") {
      if (!entry.value) {
        delete state.size;
        continue;
      }
      const size = Number(entry.value);
      if (Number.isFinite(size) && size > 0) state.size = size;
      else state.problems.push(`${path}: font-size "${entry.value}" is not a number`);
    } else if (entry.key === "config-file" && entry.value) {
      const optionalInclude = entry.value.startsWith("?");
      let target = optionalInclude ? entry.value.slice(1).trim() : entry.value;
      if (target.length >= 2 && target.startsWith("\"") && target.endsWith("\"")) target = target.slice(1, -1);
      target = expandHome(target, home);
      includes.push({ path: isAbsolute(target) ? target : resolve(dirname(path), target), optional: optionalInclude });
    }
  }
  for (const include of includes) {
    if (depth >= MAX_INCLUDE_DEPTH) {
      state.problems.push(`${include.path}: included too deeply`);
      continue;
    }
    applyFile(state, include.path, read, home, seen, depth + 1, include.optional);
  }
}

/** Reads the font Ghostty would use from the files at `paths`; missing default files are not a problem. */
export function readGhosttyFont(paths: readonly string[], read: ReadText, home = homedir()): GhosttyFontState {
  const state: GhosttyFontState = { families: [], files: [], problems: [] };
  const seen = new Set<string>();
  for (const path of paths) applyFile(state, path, read, home, seen, 0, true);
  return state;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The machine's Ghostty font, in the shape the desktop half resolves its font from. */
export function ghosttyFontDefaults(read: ReadText = readTextFile): TerminalFontDefaults {
  const state = readGhosttyFont(ghosttyConfigPaths(), read);
  return {
    families: state.families,
    ...(state.size === undefined ? {} : { size: state.size }),
    files: state.files,
    problems: state.problems,
  };
}
