import type { ThreadActivitySnapshot, ThreadLineage, UiSession } from "tau";

/** A parent's rail row stays working while its descendants work, and waiting while one asks; runtime state stays untouched. */
export function railActivity(
  activity: ThreadActivitySnapshot,
  threads: readonly UiSession[],
  lineage: ThreadLineage,
): ThreadActivitySnapshot {
  const parents = new Map(threads.flatMap((thread) => thread.parentThreadId ? [[thread.id, thread.parentThreadId] as const] : []));
  for (const [child, parent] of Object.entries(lineage.parents)) parents.set(child, parent);
  const running = new Set(activity.runningThreadIds);
  const starts = { ...activity.runningStartedAt };
  const waiting = new Set(activity.waitingThreadIds);
  const asked = { ...activity.waitingSince };
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
  // A question below waits on the user at every thread above it, even where only a kit knows the link.
  for (const id of activity.waitingThreadIds) {
    const visited = new Set([id]);
    for (let parent = parents.get(id); parent && !visited.has(parent); parent = parents.get(parent)) {
      visited.add(parent);
      waiting.add(parent);
      const since = asked[id];
      if (since !== undefined) asked[parent] = Math.min(asked[parent] ?? since, since);
    }
  }
  // Includes children on other machines, which the local runtime does not list.
  for (const [parent, count] of Object.entries(lineage.workingChildren)) {
    if (count > 0) inherit(parent);
  }
  return {
    ...activity,
    runningThreadIds: [...running],
    runningStartedAt: starts,
    waitingThreadIds: waiting.size === activity.waitingThreadIds.length ? activity.waitingThreadIds : [...waiting],
    ...(activity.waitingSince || Object.keys(asked).length > 0 ? { waitingSince: asked } : {}),
  };
}
