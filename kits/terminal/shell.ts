import { statSync } from "node:fs";
import { win32 } from "node:path";
import { findExecutable } from "tau/host-extension";

/** The shell a workspace's terminal starts in, and how to start it login-style. */

/**
 * The user's shell from the environment, or the platform default. Windows has
 * no `SHELL`: PowerShell 7 when it is on PATH, then Windows PowerShell, which
 * every Windows 10 and 11 has, then `ComSpec`.
 */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  find: (name: string) => string | undefined = (name) => findExecutable(name, env, { platform }),
): string {
  if (platform === "win32") {
    const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
    const systemRoot = value("SYSTEMROOT") || "C:\\Windows";
    return find("pwsh")
      ?? find(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
      ?? (value("COMSPEC") || "cmd.exe");
  }
  return env.SHELL && env.SHELL.trim() ? env.SHELL : "/bin/zsh";
}

/**
 * Login-interactive flags, so the terminal sees the PATH and aliases the user's
 * own shell start-up gives it. No `-c`: the shell keeps reading from the pty.
 * PowerShell loads its profile on its own; `-NoLogo` drops the banner.
 */
export function shellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return /^(pwsh|powershell)(\.exe)?$/iu.test(win32.basename(shell)) ? ["-NoLogo"] : [];
  return ["-il"];
}

/**
 * Whether the shell can be started: an absolute path that exists, or on
 * Windows a command name `CreateProcess` looks up itself. A missing one falls
 * back to `/bin/sh`.
 */
export function shellAvailable(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return true;
  if (!path.includes("/")) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
