import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HostClient } from "../workbench/host-client";
import type { NewThreadController } from "../workbench/new-thread-controller";
import type { ThreadCommands } from "../workbench/thread-commands";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { PreferencesStore } from "./preferences";
import { effectiveNewThreadRuntime, newThreadSetup } from "./new-thread-runtime";
import { runtimeCatalogStore, useRuntimeCatalogs } from "./use-runtime-catalog";

/** A composer choice belongs to the draft's runtime, including on the startup screen. */
export function useDraftRuntimeSelection({ beginStartDraft, newThread, preferences, view, commands, client }: {
  beginStartDraft(): void;
  newThread: NewThreadController;
  preferences: PreferencesStore;
  view: ThreadViewStore;
  commands: ThreadCommands;
  client: HostClient | undefined;
}) {
  const runtime = useCallback(() => effectiveNewThreadRuntime(newThread.current()?.runtime ?? preferences.getSnapshot().newThreadRuntime, view.getSnapshot(), runtimeCatalogStore(client)?.all()), [client, newThread, preferences, view]);
  const setComposerModel = useCallback((provider: string, id: string) => {
    beginStartDraft();
    return newThread.setModel(provider, id, commands.setModel, (p, mid) => {
      const entry = runtimeCatalogStore(client)?.get(runtime());
      const models = entry?.status === "ready" ? entry.catalog.models : view.getSnapshot()?.models;
      return models?.find((model) => model.provider === p && model.id === mid)?.name;
    }, runtime());
  }, [beginStartDraft, client, commands, newThread, runtime, view]);
  const setComposerThinking = useCallback((level: string) => {
    beginStartDraft();
    return newThread.setThinking(level, commands.setThinking, runtime());
  }, [beginStartDraft, commands, newThread, runtime]);
  // The empty thread the host opens at startup runs Pi. When Pi has no provider and another runtime is ready,
  // a draft on that runtime takes its place, since what is typed on the start screen goes to the thread on screen.
  const catalogs = useRuntimeCatalogs(true, false);
  const onScreen = useSyncExternalStore(view.subscribeToSnapshot, view.getSnapshot);
  const drafting = useSyncExternalStore(newThread.subscribe, newThread.current) !== undefined;
  useEffect(() => {
    if (drafting || !onScreen || !newThreadSetup(onScreen.backendKind ?? "pi", onScreen, catalogs)) return;
    if (!newThreadSetup(effectiveNewThreadRuntime(preferences.getSnapshot().newThreadRuntime, onScreen, catalogs), onScreen, catalogs)) beginStartDraft();
  }, [beginStartDraft, catalogs, drafting, onScreen, preferences]);
  const selectDraftRuntime = useCallback((kind: string) => {
    beginStartDraft();
    newThread.switchRuntime(runtime(), kind);
    preferences.setNewThreadRuntime(kind);
  }, [beginStartDraft, newThread, preferences, runtime]);
  return { setComposerModel, setComposerThinking, selectDraftRuntime };
}
