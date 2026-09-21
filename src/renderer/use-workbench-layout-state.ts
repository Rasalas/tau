import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ClientStorage } from "../workbench/client-storage";
import { EMPTY_STAGE, type StageState } from "../workbench/stage";
import {
  EMPTY_DOCK,
  pruneStageState,
  readDockState,
  readStageState,
  writeDockState,
  writeStageState,
  type DockState,
} from "../workbench/workbench-layout-state";

/** Enough of a pause that a drag or a burst of tab work is one write. */
const WRITE_DELAY_MS = 400;

export interface WorkbenchLayoutStateOptions {
  storage: ClientStorage;
  /** Identity of the workspace on screen; nothing is restored or written without one. */
  workspaceId: string | undefined;
  /** The workspace's root, for dropping a restored file tab of another project. */
  workspacePath: string | undefined;
  /** Threads the index knows; empty while it has not arrived. */
  knownThreadIds: readonly string[];
}

/**
 * The stage and the dock across restarts, per workspace. Restoring happens
 * when the workspace changes; writing is deferred, and only for the workspace
 * that was last restored, so opening one never overwrites another's layout.
 */
export function useWorkbenchLayoutState(options: WorkbenchLayoutStateOptions) {
  const { storage, workspaceId, workspacePath, knownThreadIds } = options;
  const [stage, setStage] = useState<StageState>(EMPTY_STAGE);
  const [dock, setDock] = useState<DockState>(EMPTY_DOCK);
  const restoredFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!workspaceId || restoredFor.current === workspaceId) return;
    restoredFor.current = workspaceId;
    setStage(pruneStageState(readStageState(storage, workspaceId), { ...(workspacePath ? { workspacePath } : {}) }));
    setDock(readDockState(storage, workspaceId));
  }, [storage, workspaceId, workspacePath]);

  // The index arrives after the first paint; a tab whose thread it does not
  // list was restored from a session that is gone.
  useEffect(() => {
    if (knownThreadIds.length === 0) return;
    const known = new Set(knownThreadIds);
    setStage((current) => pruneStageState(current, { knownThreadIds: known }));
  }, [knownThreadIds]);

  useEffect(() => {
    if (!workspaceId || restoredFor.current !== workspaceId) return;
    const timer = window.setTimeout(() => writeStageState(storage, workspaceId, stage), WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [stage, storage, workspaceId]);

  useEffect(() => {
    if (!workspaceId || restoredFor.current !== workspaceId) return;
    const timer = window.setTimeout(() => writeDockState(storage, workspaceId, dock), WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dock, storage, workspaceId]);

  const setDockOpen = useCallback((open: SetStateAction<boolean>) => setDock((current) => {
    const next = typeof open === "function" ? open(current.open) : open;
    return current.open === next ? current : { ...current, open: next };
  }), []);
  const setActivePanel = useCallback((activePanel: string) => setDock((current) => {
    if (current.activePanel === activePanel) return current;
    const openedPanels = !activePanel || current.openedPanels.includes(activePanel)
      ? current.openedPanels
      : [...current.openedPanels, activePanel];
    return { ...current, activePanel, openedPanels };
  }), []);
  const setDockWidth = useCallback((width: number) => setDock((current) => current.width === width ? current : { ...current, width }), []);

  return {
    stage, setStage,
    dockOpen: dock.open, setDockOpen,
    activePanel: dock.activePanel ?? "", setActivePanel,
    openedPanels: dock.openedPanels,
    dockWidth: dock.width, setDockWidth,
    /** A project switch starts the stage over; the next restore fills it. */
    resetStage: useCallback(() => setStage(EMPTY_STAGE), []),
  };
}
