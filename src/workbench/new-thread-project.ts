import type { UiProject, UiSession } from "../shared/contracts";
import { isFilesystemRoot } from "../shared/filesystem-root";
import { inProject } from "./thread-supervision";

/**
 * The project a new thread starts in when nobody named one: the one the
 * host's threads were last busy in, else the one it opened last. `/` never
 * counts; an app opened from the Finder once recorded it as a project.
 * Undefined means ask.
 */
export function lastUsedProject(projects: readonly UiProject[], threads: readonly UiSession[]): UiProject | undefined {
  const candidates = projects.filter((project) => !isFilesystemRoot(project.path));
  let best: { project: UiProject; at: number } | undefined;
  for (const project of candidates) {
    let at = project.lastOpenedAt;
    for (const thread of threads) {
      if (thread.messageCount > 0 && thread.modifiedAt > at && inProject(thread, project)) at = thread.modifiedAt;
    }
    if (!best || at > best.at) best = { project, at };
  }
  return best?.project;
}

/** The same projects with `/` moved to the end, so no list offers it first. */
export function rootLast<T extends Pick<UiProject, "path">>(projects: readonly T[]): T[] {
  return [...projects.filter((project) => !isFilesystemRoot(project.path)), ...projects.filter((project) => isFilesystemRoot(project.path))];
}
