import type { ThreadActivitySnapshot, ThreadLineage, UiSession } from "tau";

/** A parent's rail row stays working while its descendants work; runtime state stays untouched. */
export function railActivity(
  activity: ThreadActivitySnapshot,
  threads: readonly UiSession[],
  lineage: ThreadLineage,
): ThreadActivitySnapshot {
  const parents = new Map(threads.flatMap((thread) => thread.parentThreadId ? [[thread.id, thread.parentThreadId] as const] : []));
  for (const [child, parent] of Object.entries(lineage.parents)) parents.set(child, parent);
  const running = new Set(activity.runningThreadIds);
  const starts = { ...activity.runningStartedAt };
  const inherit = (id: string, startedAt?: number) => {
    const visited = new Set<string>();
    let parent: string | undefined = id;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      running.add(parent);
      if (startedAt !== undefined) starts[parent] = Math.min(starts[parent] ?? startedAt, startedAt);
      parent = parents.get(parent);
    }
  };
  for (const id of activity.runningThreadIds) inherit(id, starts[id]);
  // Includes children on other machines, which the local runtime does not list.
  for (const [parent, count] of Object.entries(lineage.workingChildren)) {
    if (count > 0) inherit(parent);
  }
  return { ...activity, runningThreadIds: [...running], runningStartedAt: starts };
}
