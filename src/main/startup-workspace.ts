import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isFilesystemRoot } from "../shared/filesystem-root.js";

export interface StartupWorkspace {
  cwd: string;
  /** The workspace that was asked for but is not on disk any more. */
  missing?: string;
}

interface RecentProject {
  path: string;
  lastOpenedAt: number;
}

/**
 * The workspace a host starts in. A folder that vanished since the last run (a
 * deleted scratch checkout, an unmounted volume) must not keep the app from
 * opening: the most recently opened project that still exists takes its place,
 * and the home directory when there is none. `/` in the history is where an
 * earlier version started from the Finder, not a project.
 */
export function resolveStartupWorkspace(
  requested: string | undefined,
  recent: readonly RecentProject[],
  options: { exists?: (path: string) => boolean; home?: string } = {},
): StartupWorkspace {
  const exists = options.exists ?? existsSync;
  if (requested && exists(requested)) return { cwd: requested };
  const fallback = [...recent]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .find((project) => project.path !== requested && !isFilesystemRoot(project.path) && exists(project.path));
  const cwd = fallback?.path ?? options.home ?? homedir();
  return requested ? { cwd, missing: requested } : { cwd };
}

/**
 * The folder a headless host was asked to start in, or undefined for the last
 * project. Only a host started by hand takes the folder it runs in: a service
 * runs from the home folder, and a window's host from wherever the window
 * was opened (`/` from the Finder).
 */
export function requestedHostWorkspace(input: { requested?: string | undefined; service: boolean; windowSpawned: boolean; cwd: string }): string | undefined {
  if (input.requested) return input.requested;
  if (input.service || input.windowSpawned || isFilesystemRoot(input.cwd)) return undefined;
  return input.cwd;
}
