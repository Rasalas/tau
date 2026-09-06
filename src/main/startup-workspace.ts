import { existsSync } from "node:fs";
import { homedir } from "node:os";

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
 * and the home directory when there is none.
 */
export function resolveStartupWorkspace(
  requested: string,
  recent: readonly RecentProject[],
  options: { exists?: (path: string) => boolean; home?: string } = {},
): StartupWorkspace {
  const exists = options.exists ?? existsSync;
  if (exists(requested)) return { cwd: requested };
  const fallback = [...recent]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .find((project) => project.path !== requested && exists(project.path));
  return { cwd: fallback?.path ?? options.home ?? homedir(), missing: requested };
}
