import type { ThreadBackendKind } from "./contracts.js";

/**
 * Runtime instances: several setups of one program — a second Codex with its
 * own home and login, say — each registered as a backend of its own. The
 * default instance keeps the program's plain kind (`codex`), so threads from
 * before instances existed stay where they were; another is `<driver>@<id>`
 * (`codex@work`). Threads carry the kind, so a thread keeps its instance.
 */

export const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID = /^[a-z][a-z0-9_-]{0,47}$/u;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** One setup of a program, as the Providers page edits it and a kit keeps it. */
export interface RuntimeInstanceConfig {
  /** `default`, or a slug unique among the program's instances. */
  id: string;
  /** Shown on the instance's card and picker tab; the program's name when absent. */
  name?: string;
  /** The executable: a name on the PATH or a path. */
  command?: string;
  /** The program's home folder (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`); `~` is the user's home. */
  home?: string;
  /** Variables added to the program's environment. */
  env?: Record<string, string>;
  /** Extra arguments on every launch, as the user typed them. */
  args?: string;
}

/** The backend kind of a program's instance. */
export function runtimeInstanceKind(driver: string, id: string): ThreadBackendKind {
  return id === DEFAULT_INSTANCE_ID ? driver : `${driver}@${id}`;
}

/** The program a backend kind drives: `codex` for `codex@work` and for `codex`. */
export function runtimeDriver(kind: string): string {
  const at = kind.indexOf("@");
  return at < 0 ? kind : kind.slice(0, at);
}

/** The instance a backend kind names; `default` for a plain kind. */
export function runtimeInstanceId(kind: string): string {
  const at = kind.indexOf("@");
  return at < 0 ? DEFAULT_INSTANCE_ID : kind.slice(at + 1);
}

/** Whether `kind` is `driver` or one of its instances. */
export function isRuntimeInstanceOf(kind: string | undefined, driver: string): boolean {
  return kind !== undefined && runtimeDriver(kind) === driver;
}

/** A slug for an instance id from what the user called it: "Work account" → `work-account`. */
export function instanceIdFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  return /^[a-z]/u.test(slug) ? slug : slug ? `i-${slug}`.slice(0, 48) : "";
}

/** Why an id cannot name a new instance, or undefined when it can. */
export function instanceIdProblem(id: string, taken: Iterable<string>): string | undefined {
  if (!id) return "Give the instance a name.";
  if (id === DEFAULT_INSTANCE_ID) return "“default” is the instance Tau starts with.";
  if (!INSTANCE_ID.test(id)) return "An id starts with a letter and has only lowercase letters, digits, - and _.";
  for (const existing of taken) if (existing === id) return `An instance “${id}” exists already.`;
  return undefined;
}

/** `NAME=value` lines; blank lines and `#` comments are skipped. */
export function parseEnvironment(text: string): { env: Record<string, string>; problem?: string } {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const name = equals < 0 ? line : line.slice(0, equals).trim();
    if (equals < 0 || !VARIABLE_NAME.test(name)) return { env, problem: `Line ${index + 1} is not NAME=value.` };
    env[name] = line.slice(equals + 1).trim();
  }
  return { env };
}

export function formatEnvironment(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`).join("\n");
}

/** Splits arguments the way a shell would for plain words and quotes; no expansion. */
export function splitArguments(text: string | undefined): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < (text ?? "").length; index += 1) {
    const char = text![index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < text!.length) current += text![++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text!.length) {
      current += text![++index];
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
