import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The section every thread's system prompt gets, in every runtime. Names the tools only the packages kit registers. */
export const CUSTOMIZE_INSTRUCTIONS = `<customizing_tau>
A request to change Tau itself (a button, panel, command, theme, shortcut, how it looks) is built as a Tau package. Never edit Tau's app or source folder for it, and never write into the open project.
1. Call tau_new_package with a short name. It creates the package in the user's extension folder with the API's types and an AGENTS.md recipe; read that file, not Tau's source.
2. Edit the files in that folder only.
3. Call tau_install_package with the folder. The user approves it with one click; never approve it yourself.
4. Once the user has allowed it, call tau_window_screenshot once with the package's id and look at the result; fix what looks wrong.
</customizing_tau>`;

/** Tau's own source checkout, or a worktree of it: `kits/package.json` names `@tau/kits` at the Git root of `cwd` (`cwd` itself outside Git). */
export function isTauSourceCheckout(cwd: string): boolean {
  let root = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) { root = dir; break; }
    if (dirname(dir) === dir) break;
  }
  try {
    return (JSON.parse(readFileSync(join(root, "kits/package.json"), "utf8")) as { name?: unknown }).name === "@tau/kits";
  } catch {
    return false;
  }
}

/** The section for a thread working in `cwd`; none while developing Tau itself, where editing its code is the job. */
export function customizeInstructionsFor(cwd: string): string | undefined {
  return isTauSourceCheckout(cwd) ? undefined : CUSTOMIZE_INSTRUCTIONS;
}
