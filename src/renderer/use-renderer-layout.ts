import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { layoutTransition, type LayoutAction, type LayoutPreferences } from "./workbench-layout";

interface RendererLayoutOptions {
  storage: ClientStorage;
  owner: string | undefined;
  restoredOwner: string | undefined;
  tabCount: number;
  stageFolded: boolean;
  stageMaximized: boolean;
  setStageFolded(folded: boolean): void;
  setStageMaximized(maximized: boolean): void;
}

export interface RendererLayout {
  preferences: LayoutPreferences;
  send(action: LayoutAction): void;
}

/** Renderer choices and transitions; ThreadStages still owns each saved stage. */
export function useRendererLayout(options: RendererLayoutOptions): RendererLayout {
  const [local, setLocal] = useState(() => ({
    chatFocused: false,
    spineWanted: options.storage.get(STORAGE_KEYS.spine) === "true",
    workspaceSummaryHidden: options.stageFolded,
  }));
  const preferences = useMemo(() => ({ ...local, stageFolded: options.stageFolded, stageMaximized: options.stageMaximized }),
    [local, options.stageFolded, options.stageMaximized]);
  const latest = useRef({ options, preferences });
  latest.current = { options, preferences };
  const [send] = useState(() => (action: LayoutAction) => {
    const current = latest.current;
    const patch = layoutTransition(current.preferences, action);
    current.preferences = { ...current.preferences, ...patch };
    if (patch.stageFolded !== undefined) current.options.setStageFolded(patch.stageFolded);
    if (patch.stageMaximized !== undefined) current.options.setStageMaximized(patch.stageMaximized);
    setLocal(({ chatFocused, spineWanted, workspaceSummaryHidden }) => ({
      chatFocused: patch.chatFocused ?? chatFocused,
      spineWanted: patch.spineWanted ?? spineWanted,
      workspaceSummaryHidden: patch.workspaceSummaryHidden ?? workspaceSummaryHidden,
    }));
  });
  useEffect(() => options.storage.set(STORAGE_KEYS.spine, String(local.spineWanted)), [local.spineWanted, options.storage]);

  const ownerShown = useRef(false);
  useEffect(() => {
    send({ type: "navigate", hadOwner: ownerShown.current });
    ownerShown.current = Boolean(options.owner);
  }, [options.owner, send]);

  // Initial restoration may still be pending. An empty first paint must keep the stored spine.
  const stageSeen = useRef(false);
  useEffect(() => {
    if (options.owner !== options.restoredOwner) return;
    if (options.tabCount > 0 && !options.stageFolded) stageSeen.current = true;
    else if (stageSeen.current) send({ type: "stage-unavailable", empty: options.tabCount === 0 });
    if (options.tabCount === 0 && options.stageMaximized) send({ type: "restore-stage" });
  }, [options.owner, options.restoredOwner, options.tabCount, options.stageFolded, options.stageMaximized, send]);
  return useMemo(() => ({ preferences, send }), [preferences, send]);
}
