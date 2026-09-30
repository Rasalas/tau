import { useCallback, useRef, useSyncExternalStore } from "react";
import { outsideRow, type ThreadSupervisionRow } from "../../workbench/thread-supervision";
import type { ExtensionRegistry, ThreadListEntry, ThreadListPlace, ThreadListSource } from "../extension-system";

export interface OutsideThreads {
  /** The entries as list rows, keyed by `key`. */
  rows: readonly ThreadSupervisionRow[];
  byKey: ReadonlyMap<string, ThreadListEntry>;
  /** Where this host's own threads run, from the first source that says. */
  here: ThreadListPlace | undefined;
}

const NONE: OutsideThreads = { rows: [], byKey: new Map(), here: undefined };

/** Every source's threads in one list; the same object until a source or its threads change. */
export function combineSources(sources: readonly ThreadListSource[], previous: { parts: unknown[]; value: OutsideThreads } | undefined): { parts: unknown[]; value: OutsideThreads } {
  const entries = sources.flatMap((source) => source.threads());
  const here = sources.map((source) => source.here?.()).find(Boolean);
  // By entry, not by list: a source that hands out a fresh array each time must not re-render the list forever.
  const parts: unknown[] = [here?.name, ...entries];
  if (previous && previous.parts.length === parts.length && previous.parts.every((part, index) => part === parts[index])) return previous;
  if (entries.length === 0 && !here) return { parts, value: NONE };
  return { parts, value: { rows: entries.map(outsideRow), byKey: new Map(entries.map((entry) => [entry.key, entry])), here } };
}

/** The threads kits list for elsewhere (`registerThreadListSource`), followed while the list shows. */
export function useThreadListSources(registry: ExtensionRegistry): OutsideThreads {
  const cache = useRef<{ parts: unknown[]; value: OutsideThreads }>(undefined);
  const subscribe = useCallback((listener: () => void) => {
    let stops: Array<() => void> = [];
    const follow = () => {
      for (const stop of stops) stop();
      stops = registry.getThreadListSources().map((source) => source.subscribe(listener));
    };
    follow();
    const stopRegistry = registry.subscribe(() => { follow(); listener(); });
    return () => { stopRegistry(); for (const stop of stops) stop(); };
  }, [registry]);
  const read = () => {
    cache.current = combineSources(registry.getThreadListSources(), cache.current);
    return cache.current.value;
  };
  return useSyncExternalStore(subscribe, read);
}
