import { useEffect, useState, useSyncExternalStore } from "react";
import type { ThreadStoreSnapshot } from "../../workbench/thread-store";
import type { ExtensionRegistry, PaletteItem, PaletteSearchContext, WorkbenchActions } from "../extension-system";

/** Compact reads the same contributed source, including its cancellation and status. */
export function useMessageSearch(registry: ExtensionRegistry, actions: WorkbenchActions, snapshot: ThreadStoreSnapshot, query: string) {
  const version = useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const [result, setResult] = useState<{ query: string; items: readonly PaletteItem[]; status?: string }>({ query: "", items: [] });
  useEffect(() => {
    if (query.trim().length < 3) return;
    const source = registry.getPaletteSources().find(entry => entry.id === "search.thread-content");
    if (!source) return;
    const controller = new AbortController();
    const context: PaletteSearchContext = { actions, scope: "threads", signal: controller.signal, index: {
      projects: snapshot.projects, threads: snapshot.threads, activeThreadId: snapshot.activeThreadId,
      running: snapshot.runningThreadIds, waiting: snapshot.waitingThreadIds,
    } };
    let sequence = 0;
    const read = () => {
      const ticket = ++sequence;
      void Promise.resolve(source.search(query, context)).then(items => {
        if (!controller.signal.aborted && ticket === sequence) setResult({ query, items, status: source.status?.(query, context) });
      }, () => { if (!controller.signal.aborted) setResult({ query, items: [], status: source.status?.(query, context) }); });
    };
    const stop = source.subscribeStatus?.(read);
    read();
    return () => { controller.abort(); stop?.(); };
  }, [actions, query, registry, snapshot, version]);
  return query.trim().length >= 3 && result.query === query ? result : { items: [], status: undefined };
}
