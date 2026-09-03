import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * A GUI launch inherits launchd's or the session manager's environment, not
 * the user's login shell: PATH lacks Homebrew, `~/.local/bin` and version
 * managers, so `git`, `claude`, editors and Pi's own tools go missing. Tau
 * reads the login shell once at startup and installs what it needs.
 */
export const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const LOCALE_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const FALLBACK_LC_CTYPE = "en_US.UTF-8";

export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<string>;

export interface ShellEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The login shell to ask; `$SHELL`, then /bin/zsh or /bin/bash. */
  shell?: string;
  run?: CommandRunner;
  timeoutMs?: number;
}

export interface ShellEnvironmentResult {
  /** Where PATH came from; "process" means the login shell gave nothing. */
  pathSource: "login-shell" | "launchctl" | "process";
  installed: string[];
}

const runWithExecFile: CommandRunner = (command, args, timeoutMs, env) => new Promise((resolve, reject) => {
  execFile(command, [...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

const startMarker = (name: string) => `__TAU_ENV_${name}_START__`;
const endMarker = (name: string) => `__TAU_ENV_${name}_END__`;

/** One shell command that prints every variable between markers; rc-file noise stays outside them. */
export function captureCommand(names: readonly string[]): string {
  return names
    .map((name) => `printf '%s\\n' '${startMarker(name)}'; printenv ${name} || true; printf '%s\\n' '${endMarker(name)}'`)
    .join("; ");
}

export function parseCapture(output: string, names: readonly string[]): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;
    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;
    const value = output.slice(valueStart, end).replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (value) captured[name] = value;
  }
  return captured;
}

function loginShellCandidates(env: NodeJS.ProcessEnv, shell?: string): string[] {
  const candidates = [shell, env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates)].filter((entry) => {
    try { accessSync(entry, constants.X_OK); return true; } catch { return false; }
  });
}

/** PATH entries in order, first occurrence wins. */
export function mergePaths(paths: ReadonlyArray<string | undefined>): string | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const path of paths) {
    for (const raw of (path ?? "").split(delimiter)) {
      const entry = raw.trim();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

/** Reads the variables from the user's login shell; empty when no shell answers. */
export async function captureLoginShellEnvironment(
  names: readonly string[] = LOGIN_SHELL_ENV_NAMES,
  options: ShellEnvironmentOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const run = options.run ?? runWithExecFile;
  const timeoutMs = options.timeoutMs ?? 5_000;
  for (const shell of loginShellCandidates(env, options.shell)) {
    try {
      // -i as well as -l: many setups add PATH entries in .zshrc/.bashrc, not the profile.
      const captured = parseCapture(await run(shell, ["-ilc", captureCommand(names)], timeoutMs, env), names);
      if (captured.PATH) return captured;
    } catch {
      // Try the next shell; a broken rc file must not keep Tau from starting.
    }
  }
  return {};
}

/**
 * Merges the login shell's environment into `env` (the process by default).
 * The shell's PATH comes first, the inherited PATH stays behind it; other
 * variables only fill gaps. Locale gets a UTF-8 fallback on macOS, where a
 * Dock launch has none and child processes would decode output as MacRoman.
 */
export async function installShellEnvironment(options: ShellEnvironmentOptions = {}): Promise<ShellEnvironmentResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const installed: string[] = [];
  if (platform === "win32") return { pathSource: "process", installed };
  const run = options.run ?? runWithExecFile;
  const shell = await captureLoginShellEnvironment(LOGIN_SHELL_ENV_NAMES, options);
  let pathSource: ShellEnvironmentResult["pathSource"] = shell.PATH ? "login-shell" : "process";
  let shellPath: string | undefined = shell.PATH || undefined;
  if (!shellPath && platform === "darwin") {
    shellPath = (await run("/bin/launchctl", ["getenv", "PATH"], options.timeoutMs ?? 2_000, env).catch(() => "")).trim() || undefined;
    if (shellPath) pathSource = "launchctl";
  }
  const merged = mergePaths([shellPath, env.PATH]);
  if (merged && merged !== env.PATH) { env.PATH = merged; installed.push("PATH"); }
  for (const name of LOGIN_SHELL_ENV_NAMES) {
    if (name === "PATH" || LOCALE_NAMES.includes(name as typeof LOCALE_NAMES[number])) continue;
    if (!env[name]?.trim() && shell[name]) { env[name] = shell[name]; installed.push(name); }
  }
  if (platform === "darwin" && LOCALE_NAMES.every((name) => !env[name]?.trim())) {
    // LC_ALL/LANG/LC_CTYPE form one precedence group: take the shell's set or none.
    for (const name of LOCALE_NAMES) {
      const value = shell[name];
      if (value) { env[name] = value; installed.push(name); }
    }
    if (LOCALE_NAMES.every((name) => !env[name]?.trim())) { env.LC_CTYPE = FALLBACK_LC_CTYPE; installed.push("LC_CTYPE"); }
  }
  return { pathSource, installed };
}

let gitLookup: { path: string | undefined; executable: string } | undefined;

/**
 * Absolute path of `git`, or the bare name when PATH has none. Spawning by
 * name is slow on macOS: libuv tries one spawn per PATH entry, which cost
 * ~110 ms per call with a 34-entry login-shell PATH and blocks the event loop.
 * The lookup is redone whenever PATH changes, e.g. after the login shell is installed.
 */
export function gitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const lookup = gitLookup && gitLookup.path === env.PATH ? gitLookup : { path: env.PATH, executable: findExecutable("git", env) ?? "git" };
  gitLookup = lookup;
  return lookup.executable;
}

/** The absolute path `command` resolves to on `env.PATH`, or undefined; a path with a slash is checked as is. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const executable = (path: string) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes("/")) return executable(command) ? (isAbsolute(command) ? command : join(process.cwd(), command)) : undefined;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}
