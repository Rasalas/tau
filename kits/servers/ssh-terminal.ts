import { SERVERS_SSH_CONFIG_ENV } from "./protocol.js";
import { shellQuote, sshBaseArgs, type SshTarget } from "./ssh-target.js";

export interface TerminalCommandInput {
  /** From `findCommand("ssh")`. */
  ssh: string;
  target: SshTarget;
  /** `remotePath`, resolved on the server by the connection. */
  root: string;
  /** The ControlMaster folder of the connection, so the terminal logs in on it. */
  controlDir?: string;
  /** The project, for relative key paths. */
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The line a terminal types to open a login shell in `remotePath`: the same
 * options as every other ssh call of the target, a terminal (`-t`), and the
 * connection Tau already holds. The user types into it; nothing gates it.
 */
export function sshTerminalCommand(input: TerminalCommandInput): string {
  const env = input.env ?? process.env;
  const configPath = env[SERVERS_SSH_CONFIG_ENV];
  const { args, destination } = sshBaseArgs(input.target, {
    ...(configPath ? { configPath } : {}),
    ...(input.controlDir ? { controlDir: input.controlDir } : {}),
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
    env,
  });
  const remote = `cd ${shellQuote(input.root)} && exec "$SHELL" -l`;
  return [input.ssh, ...args, "-t", "--", destination, remote].map(shellQuote).join(" ");
}
