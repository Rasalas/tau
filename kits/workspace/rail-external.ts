import { useCallback, useRef, useSyncExternalStore } from "react";
import type { PaletteItem, UiSession } from "tau";
import type { RailExternalThread, RailThreadSource } from "./protocol.js";
import type { RailThreadSort } from "./rail-order.js";

const NONE: readonly RailExternalThread[] = [];

/** Every source's threads as one list, the same array until one of them changes. */
export function useRailExternalThreads(sources: readonly RailThreadSource[]): readonly RailExternalThread[] {
  const cache = useRef<{ parts: ReadonlyArray<readonly RailExternalThread[]>; all: readonly RailExternalThread[] }>({ parts: [], all: NONE });
  const subscribe = useCallback((listener: () => void) => {
    const stops = sources.map((source) => source.subscribe(listener));
    return () => { for (const stop of stops) stop(); };
  }, [sources]);
  const read = useCallback(() => {
    const parts = sources.map((source) => source.threads());
    const previous = cache.current;
    if (parts.length === previous.parts.length && parts.every((part, index) => part === previous.parts[index])) return previous.all;
    const all = parts.length === 0 ? NONE : parts.flat();
    cache.current = { parts, all };
    return all;
  }, [sources]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * Other machines' threads placed among this machine's by the rail's sort. The
 * rail's own order stays as it is (a thread moved up by hand stays there); an
 * outside thread goes before the first of them it is newer than.
 */
export function mergeByTime(local: readonly UiSession[], outside: readonly UiSession[], sort: RailThreadSort): UiSession[] {
  if (outside.length === 0) return local.slice();
  const key = sort === "created" ? (session: UiSession) => session.createdAt ?? session.modifiedAt : (session: UiSession) => session.modifiedAt;
  const pending = outside.slice().sort((left, right) => key(right) - key(left));
  const merged: UiSession[] = [];
  let next = 0;
  for (const session of local) {
    while (next < pending.length && key(pending[next]!) > key(session)) merged.push(pending[next++]!);
    merged.push(session);
  }
  return merged.concat(pending.slice(next));
}

/** Other machines' threads whose project, title or machine holds every word of `query`, for the palette. */
export function outsideThreadItems(sources: readonly RailThreadSource[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  return sources.flatMap((source) => source.threads())
    .filter(({ session, machine, unavailable }) => !unavailable && words.every((word) => `${session.projectName} ${session.title} ${machine.name}`.toLowerCase().includes(word)))
    .slice(0, 8)
    .map((thread) => ({
      id: thread.key,
      label: thread.session.title || "Untitled thread",
      detail: `${thread.session.projectName} · on ${thread.machine.name}`,
      icon: thread.machine.icon,
      access: "read",
      run: (actions) => thread.open(actions),
    }));
}
