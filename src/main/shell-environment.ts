import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

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
  "EDITOR",
  "VISUAL",
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
  /** Whether a directory exists; Windows adds well-known tool folders only when they do. */
  directoryExists?: (path: string) => boolean;
}

export interface ShellEnvironmentResult {
  /** Where PATH came from; "process" means the login shell (or registry) gave nothing. */
  pathSource: "login-shell" | "launchctl" | "registry" | "process";
  installed: string[];
}

/** The key a variable lives under; a copied Windows environment spells PATH `Path`. */
export function envKey(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper) ?? name;
}

/** A variable read the way the platform reads it: case-insensitively on Windows. */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return env[envKey(env, name, platform)];
}

const pathDelimiter = (platform: NodeJS.Platform) => platform === "win32" ? ";" : ":";

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

/** A PATH entry without the quotes Windows allows around one. */
const unquote = (entry: string) => entry.replace(/^"(.*)"$/u, "$1");

/** PATH entries in order, first occurrence wins; Windows compares them case- and slash-insensitively. */
export function mergePaths(paths: ReadonlyArray<string | undefined>, platform: NodeJS.Platform = process.platform): string | undefined {
  const delimiter = pathDelimiter(platform);
  const identity = platform === "win32"
    ? (entry: string) => unquote(entry).replace(/[\\/]+$/u, "").toLowerCase()
    : (entry: string) => entry;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const path of paths) {
    for (const raw of (path ?? "").split(delimiter)) {
      const entry = raw.trim();
      const key = identity(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
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

const REGISTRY_SCOPES = ["Machine", "User"] as const;
type RegistryScope = typeof REGISTRY_SCOPES[number];

/**
 * PowerShell that prints the registry's Machine and User PATH, expanded, one
 * marked line each. Base64 keeps non-ASCII paths intact whatever the console code page.
 */
export function windowsPathScript(): string {
  return `foreach ($scope in ${REGISTRY_SCOPES.map((scope) => `'${scope}'`).join(", ")}) { `
    + "$value = [Environment]::GetEnvironmentVariable('Path', $scope); "
    + "if ($value) { Write-Output ('__TAU_PATH_' + $scope + '__' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) } }";
}

export function parseWindowsPathOutput(output: string): Partial<Record<RegistryScope, string>> {
  const found: Partial<Record<RegistryScope, string>> = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^__TAU_PATH_(Machine|User)__([A-Za-z0-9+/=]+)\s*$/u.exec(line.trim());
    if (match) found[match[1] as RegistryScope] = Buffer.from(match[2]!, "base64").toString("utf8");
  }
  return found;
}

/**
 * Windows PowerShell ships with every Windows 10 and 11, at a fixed place,
 * so it is asked by absolute path; `pwsh` on PATH is the fallback.
 */
function powerShellCandidates(env: NodeJS.ProcessEnv): string[] {
  const systemRoot = envValue(env, "SystemRoot", "win32") || envValue(env, "windir", "win32") || "C:\\Windows";
  const pwsh = findExecutable("pwsh", env, { platform: "win32" });
  return [win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ...(pwsh ? [pwsh] : [])];
}

/** The PATH the registry holds now, which a long-running Explorer may not have passed on yet. */
export async function readWindowsRegistryPath(options: ShellEnvironmentOptions = {}): Promise<Partial<Record<RegistryScope, string>>> {
  const env = options.env ?? process.env;
  const run = options.run ?? runWithExecFile;
  const encoded = Buffer.from(windowsPathScript(), "utf16le").toString("base64");
  for (const shell of powerShellCandidates(env)) {
    try {
      const found = parseWindowsPathOutput(await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], options.timeoutMs ?? 5_000, env));
      if (found.Machine || found.User) return found;
    } catch {
      // Try the next PowerShell; the inherited PATH stays either way.
    }
  }
  return {};
}

/** Per-user tool folders installers add to PATH, which a stale environment may still lack. */
export function knownWindowsToolDirectories(env: NodeJS.ProcessEnv): string[] {
  const appData = envValue(env, "APPDATA", "win32");
  const localAppData = envValue(env, "LOCALAPPDATA", "win32");
  const profile = envValue(env, "USERPROFILE", "win32");
  return [
    ...(appData ? [win32.join(appData, "npm")] : []),
    ...(localAppData ? [win32.join(localAppData, "Volta", "bin"), win32.join(localAppData, "pnpm")] : []),
    ...(profile ? [win32.join(profile, ".local", "bin"), win32.join(profile, "scoop", "shims"), win32.join(profile, ".bun", "bin"), win32.join(profile, ".cargo", "bin")] : []),
  ];
}

const directoryExists = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/**
 * Windows: a GUI launch already inherits the registry environment, so the
 * inherited PATH keeps its order and only gains what the registry has since
 * added, then existing per-user tool folders. No POSIX shell and no profile
 * script runs (docs/windows.md).
 */
async function installWindowsEnvironment(env: NodeJS.ProcessEnv, options: ShellEnvironmentOptions): Promise<ShellEnvironmentResult> {
  const key = envKey(env, "PATH", "win32");
  const registry = await readWindowsRegistryPath({ ...options, env });
  const exists = options.directoryExists ?? directoryExists;
  const merged = mergePaths([env[key], registry.Machine, registry.User, knownWindowsToolDirectories(env).filter(exists).join(";")], "win32");
  const installed: string[] = [];
  if (merged && merged !== env[key]) { env[key] = merged; installed.push("PATH"); }
  return { pathSource: registry.Machine || registry.User ? "registry" : "process", installed };
}

/**
 * Merges the login shell's environment into `env` (the process by default).
 * The shell's PATH comes first, the inherited PATH stays behind it; other
 * variables only fill gaps. Locale gets a UTF-8 fallback on macOS, where a
 * Dock launch has none and child processes would decode output as MacRoman.
 * Windows reads the registry instead (`installWindowsEnvironment`).
 */
export async function installShellEnvironment(options: ShellEnvironmentOptions = {}): Promise<ShellEnvironmentResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return installWindowsEnvironment(env, options);
  const installed: string[] = [];
  const run = options.run ?? runWithExecFile;
  const shell = await captureLoginShellEnvironment(LOGIN_SHELL_ENV_NAMES, options);
  let pathSource: ShellEnvironmentResult["pathSource"] = shell.PATH ? "login-shell" : "process";
  let shellPath: string | undefined = shell.PATH || undefined;
  if (!shellPath && platform === "darwin") {
    shellPath = (await run("/bin/launchctl", ["getenv", "PATH"], options.timeoutMs ?? 2_000, env).catch(() => "")).trim() || undefined;
    if (shellPath) pathSource = "launchctl";
  }
  const merged = mergePaths([shellPath, env.PATH], platform);
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
  const path = envValue(env, "PATH");
  const lookup = gitLookup && gitLookup.path === path ? gitLookup : { path, executable: findExecutable("git", env) ?? "git" };
  gitLookup = lookup;
  return lookup.executable;
}

export interface FindExecutableOptions {
  platform?: NodeJS.Platform;
  /** Whether a candidate is a file that can run; tests hand in a fake file system. */
  isExecutable?: (path: string) => boolean;
}

/** What a process can start without a shell's help; PATHEXT may list more (`.ps1`, `.vbs`). */
const WINDOWS_RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

/** The names `command` may have on disk, in PATHEXT order; one with a runnable extension is taken as is. */
function windowsNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (WINDOWS_RUNNABLE.includes(win32.extname(command).toLowerCase())) return [command];
  const listed = (envValue(env, "PATHEXT", "win32") ?? "").split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => WINDOWS_RUNNABLE.includes(entry));
  return [...new Set(listed.length > 0 ? listed : WINDOWS_RUNNABLE)].map((extension) => `${command}${extension}`);
}

const isFile = (path: string) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

const isExecutableFile = (path: string) => {
  if (!isFile(path)) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};

/**
 * The absolute path `command` resolves to on PATH, or undefined; a path with a
 * separator is checked as is. On Windows this is the lookup `where.exe` does —
 * each PATH entry with each PATHEXT extension — done in-process, because
 * `findCommand` is synchronous and sits on hot paths such as `gitExecutable`.
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, options: FindExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  // Windows has no execute bit; the extension decides.
  const runnable = options.isExecutable ?? (windows ? isFile : isExecutableFile);
  const names = windows ? windowsNames(command, env) : [command];
  if (command.includes("/") || (windows && command.includes("\\"))) {
    const found = names.find(runnable);
    return found === undefined ? undefined : path.isAbsolute(found) ? found : path.join(process.cwd(), found);
  }
  for (const entry of (envValue(env, "PATH", platform) ?? "").split(pathDelimiter(platform))) {
    const dir = windows ? unquote(entry.trim()) : entry.trim();
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (runnable(candidate)) return candidate;
    }
  }
  return undefined;
}
