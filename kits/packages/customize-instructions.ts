import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** The section every thread's system prompt gets, in every runtime. Names the tools only the packages kit registers. */
export const CUSTOMIZE_INSTRUCTIONS = `<customizing_tau>
A request to change Tau itself (a button, panel, command, theme, shortcut, how it looks) is built as a Tau package. Never edit Tau's app or source folder for it, and never write into the open project.
1. Call tau_new_package with a short name. It creates the package in the user's extension folder with the API's types and an AGENTS.md recipe; read that file, not Tau's source.
2. Edit the files in that folder only.
3. Call tau_install_package with the folder. The user approves it on a card in the thread and confirms in a dialog; never approve it yourself.
4. Once the user has allowed it, call tau_window_screenshot once with the package's id and look at the result; fix what looks wrong.
</customizing_tau>`;

/** The section for a thread in the "Tau customizations" project, whose folder holds the packages. */
export const CUSTOMIZE_PROJECT_INSTRUCTIONS = `<customizing_tau>
You are in the customization project: its folder is the user's Tau extension folder, and each folder in it is a Tau package. Every request here is a request to change Tau, so build it as a package. Never edit Tau's app or source folder.
1. If the request changes a package already in this folder, edit that package. Otherwise call tau_new_package with a short name; it adds the package here with the API's types and an AGENTS.md recipe. Read that file, not Tau's source.
2. Edit the files of that one package only.
3. Call tau_install_package with the package's folder. The user approves it on a card in the thread and confirms in a dialog; never approve it yourself.
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

function resolved(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Whether `cwd` is the extension folder or inside it (a link to it counts). */
export function isCustomizationProject(cwd: string, extensionsFolder: string): boolean {
  const inside = relative(resolved(extensionsFolder), resolved(cwd));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** The section for a thread working in `cwd`: the strong form in the customization project, none while developing Tau itself, where editing its code is the job. */
export function customizeInstructionsFor(cwd: string, extensionsFolder?: string): string | undefined {
  if (extensionsFolder && isCustomizationProject(cwd, extensionsFolder)) return CUSTOMIZE_PROJECT_INSTRUCTIONS;
  return isTauSourceCheckout(cwd) ? undefined : CUSTOMIZE_INSTRUCTIONS;
}
