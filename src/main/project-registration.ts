import type { ProjectFactsCache } from "./project-facts-cache.js";
import type { ProjectHistory } from "./project-history.js";

/** Refreshes registration only. Runtime instances, sessions and the active thread stay untouched. */
export async function refreshProjectRegistration(cwd: string, projects: ProjectFactsCache, history: ProjectHistory): Promise<void> {
  const previous = history.list().find((project) => project.path === cwd);
  const hidden = history.isHidden(cwd);
  let evicted: ReturnType<ProjectHistory["list"]> = [];
  await projects.refresh(cwd);
  try {
    if (await projects.projectless(cwd) || await projects.nested(cwd)) history.forget(cwd);
    else if (!hidden) {
      const name = await projects.loadName(cwd);
      if (!previous || previous.name !== name) await history.remember(cwd, name, (entries) => { evicted = [...entries]; });
    }
    await history.flush();
  } catch (error) {
    if (previous) await history.remember(previous.path, previous.name);
    else history.forget(cwd);
    if (hidden) await history.remove(cwd);
    history.restoreEvicted(evicted);
    await history.flush();
    throw error;
  }
}
