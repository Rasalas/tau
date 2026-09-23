import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Matches Pi's own `ENV_SESSION_DIR` (`config.js`), which is not re-exported
 * by the package. Only Pi's CLI entry point reads this env var itself;
 * `getSessionsDir()` and every `SessionManager` default ignore it, so every
 * call that would otherwise fall back to Pi's default session directory must
 * pass this resolved value in explicitly for the override to take effect.
 */
const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * The session directory PI_CODING_AGENT_SESSION_DIR names, or undefined to
 * keep Pi's own default (a directory per project cwd under the agent dir's
 * `sessions/`). Callers pass the result straight through as the `sessionDir`
 * argument `SessionManager.create`/`continueRecent`/`listAll` already accept;
 * undefined reproduces their normal no-argument behavior exactly.
 */
export function resolvePiSessionsDirOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ENV_SESSION_DIR];
  return raw ? resolve(expandTilde(raw)) : undefined;
}
