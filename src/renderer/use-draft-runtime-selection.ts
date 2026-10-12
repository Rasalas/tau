import { useCallback } from "react";
import type { HostClient } from "../workbench/host-client";
import type { NewThreadController } from "../workbench/new-thread-controller";
import type { ThreadCommands } from "../workbench/thread-commands";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { PreferencesStore } from "./preferences";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { runtimeCatalogStore } from "./use-runtime-catalog";

/** A composer choice belongs to the draft's runtime, including on the startup screen. */
export function useDraftRuntimeSelection({ beginStartDraft, newThread, preferences, view, commands, client }: {
  beginStartDraft(): void;
  newThread: NewThreadController;
  preferences: PreferencesStore;
  view: ThreadViewStore;
  commands: ThreadCommands;
  client: HostClient | undefined;
}) {
  const runtime = useCallback(() => effectiveNewThreadRuntime(newThread.current()?.runtime ?? preferences.getSnapshot().newThreadRuntime, view.getSnapshot()), [newThread, preferences, view]);
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
  const selectDraftRuntime = useCallback((kind: string) => {
    beginStartDraft();
    newThread.switchRuntime(runtime(), kind);
    preferences.setNewThreadRuntime(kind);
  }, [beginStartDraft, newThread, preferences, runtime]);
  return { setComposerModel, setComposerThinking, selectDraftRuntime };
}
