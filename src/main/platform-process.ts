import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { envValue, findExecutable } from "./shell-environment.js";

/** What to hand `spawn`/`execFile`: the program, its arguments, and on Windows how to pass them. */
export interface CommandInvocation {
  command: string;
  args: string[];
  /** Set for `cmd.exe`, whose command line is built here and must reach it unchanged. */
  windowsVerbatimArguments?: boolean;
}

export interface CommandInvocationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Resolves a bare command name; `findExecutable` by default. */
  resolve?: (name: string) => string | undefined;
}

/** Characters `cmd.exe` treats specially outside quotes; each gets a caret. */
const CMD_SPECIAL = /[()[\]%!^"`<>&|;, *?=]/gu;

/** One argument as a C runtime parses it back: quoted, with quotes and the backslashes before them escaped. */
function quoteArgument(arg: string): string {
  return `"${arg.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

/**
 * Escaped twice: once for the `cmd /c` line, once more for the batch file,
 * which re-parses its arguments when it forwards them with `%*`, as npm's
 * shims and VS Code's `code.cmd` do.
 */
export function batchArgument(arg: string): string {
  return quoteArgument(arg).replace(CMD_SPECIAL, "^$&").replace(CMD_SPECIAL, "^$&");
}

/**
 * How to start `command` with `args` on this platform. On Windows a bare name
 * is resolved through PATHEXT first, and a `.cmd` or `.bat` — npm's shims,
 * `code.cmd` — runs through `cmd.exe`: Node refuses to spawn one directly
 * (EINVAL since the fix for CVE-2024-27980). Elsewhere nothing changes.
 */
export function commandInvocation(command: string, args: readonly string[], options: CommandInvocationOptions = {}): CommandInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };
  const env = options.env ?? process.env;
  const bare = !command.includes("/") && !command.includes("\\");
  const resolve = options.resolve ?? ((name: string) => findExecutable(name, env, { platform }));
  const resolved = (bare ? resolve(command) : undefined) ?? command;
  const extension = win32.extname(resolved).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return { command: resolved, args: [...args] };
  const line = [`"${resolved}"`, ...args.map(batchArgument)].join(" ");
  return {
    command: envValue(env, "ComSpec", platform) || "cmd.exe",
    // /d skips AutoRun, /s strips exactly the outer quotes, /c runs and exits.
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Starts `taskkill`; tests hand in a recorder. */
  run?: (command: string, args: string[]) => void;
}

const runDetached = (command: string, args: string[]) => {
  execFile(command, args, { windowsHide: true }, () => undefined);
};

/**
 * Ends a process and what it started. POSIX signals the process group the
 * child leads (spawned `detached`), or the child alone when it leads none.
 * Windows has neither groups nor SIGTERM: `taskkill /T /F` ends the tree, so
 * a script run through `cmd.exe` does not leave its dev server behind.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", options: KillProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const env = options.env ?? process.env;
    const systemRoot = envValue(env, "SystemRoot", platform) || "C:\\Windows";
    (options.run ?? runDetached)(win32.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
