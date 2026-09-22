import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_FILE, SCRIPT_ICONS, type ProjectFileProblem, type ProjectScript, type ProjectScriptsState, type ScriptIcon } from "./protocol.js";

export const MAX_SCRIPTS = 50;
const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const SCRIPT_KEYS = new Set(["id", "name", "command", "icon", "keybinding", "runOnWorktreeCreate", "async", "previewUrl", "autoOpenPreview"]);
/** The id the old top-level `runOnWorktreeCreate` string runs under. */
export const LEGACY_SETUP_ID = "setup";

export interface ParsedProjectFile {
  scripts: ProjectScript[];
  problems: ProjectFileProblem[];
}

/** Lowercase, dashes for anything else; what a script without an `id` is called. */
export function scriptSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
}

/**
 * Reads the text of a project file. A bad script is skipped with a problem
 * and the rest still load; a file that is not a JSON object loads nothing.
 * The top-level `runOnWorktreeCreate` string is the old spelling and becomes
 * a blocking setup script, so a repository that has it keeps working.
 */
export function parseProjectFile(text: string, source: string): ParsedProjectFile {
  const problems: ProjectFileProblem[] = [];
  const error = (message: string) => problems.push({ source, message, level: "error" });
  const warning = (message: string) => problems.push({ source, message, level: "warning" });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (failure) {
    error(`Not valid JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
    return { scripts: [], problems };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("The file must hold a JSON object.");
    return { scripts: [], problems };
  }
  const file = raw as Record<string, unknown>;
  const scripts: ProjectScript[] = [];
  const legacy = file.runOnWorktreeCreate;
  if (legacy !== undefined) {
    if (typeof legacy === "string" && legacy.trim()) {
      scripts.push({ id: LEGACY_SETUP_ID, name: "Setup", command: legacy.trim(), icon: "configure", runOnWorktreeCreate: true, async: false, autoOpenPreview: false });
      warning(`"runOnWorktreeCreate" as a string is the old spelling; it still runs, as a script "${LEGACY_SETUP_ID}". Move it into "scripts" with "runOnWorktreeCreate": true.`);
    } else if (typeof legacy !== "string") {
      error(`"runOnWorktreeCreate" at the top level must be a command string; it was ignored.`);
    }
  }
  if (file.scripts === undefined) return { scripts, problems };
  if (!Array.isArray(file.scripts)) {
    error(`"scripts" must be an array.`);
    return { scripts, problems };
  }
  if (file.scripts.length > MAX_SCRIPTS) warning(`Only the first ${MAX_SCRIPTS} scripts are read.`);
  file.scripts.slice(0, MAX_SCRIPTS).forEach((entry, index) => {
    const at = `scripts[${index}]`;
    const script = parseScript(entry, at, error, warning);
    if (!script) return;
    if (scripts.some((other) => other.id === script.id)) {
      error(`${at}: the id "${script.id}" is taken by an earlier script; give it an "id" of its own.`);
      return;
    }
    scripts.push(script);
  });
  return { scripts, problems };
}

function parseScript(
  entry: unknown,
  at: string,
  error: (message: string) => void,
  warning: (message: string) => void,
): ProjectScript | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    error(`${at} must be an object.`);
    return undefined;
  }
  const script = entry as Record<string, unknown>;
  const name = nonEmpty(script.name);
  const command = nonEmpty(script.command);
  if (!name) error(`${at}: "name" is missing or empty.`);
  if (!command) error(`${at}: "command" is missing or empty.`);
  if (!name || !command) return undefined;
  const label = `${at} ("${name}")`;
  for (const key of Object.keys(script)) {
    if (!SCRIPT_KEYS.has(key)) warning(`${label}: unknown field "${key}" was ignored.`);
  }
  const id = script.id === undefined ? scriptSlug(name) : nonEmpty(script.id);
  if (!id || !SCRIPT_ID.test(id)) {
    error(script.id === undefined
      ? `${label}: no id can be made from the name; add an "id" of lowercase letters, digits and dashes.`
      : `${label}: "id" must be lowercase letters, digits and dashes, at most 40.`);
    return undefined;
  }
  let icon: ScriptIcon = "play";
  if (script.icon !== undefined) {
    if (SCRIPT_ICONS.includes(script.icon as ScriptIcon)) icon = script.icon as ScriptIcon;
    else warning(`${label}: "icon" must be one of ${SCRIPT_ICONS.join(", ")}; "play" is used.`);
  }
  const keybinding = script.keybinding === undefined ? undefined : nonEmpty(script.keybinding);
  if (script.keybinding !== undefined && !keybinding) warning(`${label}: "keybinding" must be a chord such as "mod+shift+r"; it was ignored.`);
  let previewUrl: string | undefined;
  if (script.previewUrl !== undefined) {
    previewUrl = httpUrl(script.previewUrl);
    if (!previewUrl) warning(`${label}: "previewUrl" must be an http or https URL; it was ignored.`);
  }
  const flag = (key: string, fallback: boolean): boolean => {
    const value = script[key];
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    warning(`${label}: "${key}" must be true or false; ${String(fallback)} is used.`);
    return fallback;
  };
  const runOnWorktreeCreate = flag("runOnWorktreeCreate", false);
  const async = flag("async", true);
  if (script.async !== undefined && !runOnWorktreeCreate) warning(`${label}: "async" only matters with "runOnWorktreeCreate": true.`);
  const autoOpenPreview = flag("autoOpenPreview", true);
  return {
    id,
    name,
    command,
    icon,
    ...(keybinding ? { keybinding } : {}),
    runOnWorktreeCreate,
    async,
    ...(previewUrl ? { previewUrl } : {}),
    autoOpenPreview: Boolean(previewUrl) && autoOpenPreview,
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The project file of one checkout; a missing file is no problem, an unreadable one is. */
export async function readProjectScripts(directory: string): Promise<ProjectScriptsState> {
  const file = join(directory, PROJECT_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    const problems: ProjectFileProblem[] = code === "ENOENT" || code === "ENOTDIR"
      ? []
      : [{ source: file, message: `Could not read the file: ${failure instanceof Error ? failure.message : String(failure)}`, level: "error" }];
    return { directory, file, exists: false, scripts: [], problems };
  }
  return { directory, file, exists: true, ...parseProjectFile(text, file) };
}
