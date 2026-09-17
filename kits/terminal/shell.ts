import { statSync } from "node:fs";

/** The shell a workspace's terminal starts in, and how to start it login-style. */

/** The user's shell from the environment, or the platform default. */
export function defaultShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : "/bin/zsh";
}

/**
 * Login-interactive flags, so the terminal sees the PATH and aliases the user's
 * own shell start-up gives it. No `-c`: the shell keeps reading from the pty.
 */
export function shellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [];
  void shell;
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
