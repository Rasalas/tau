import { useCallback, useEffect, useMemo, useState, type SetStateAction } from "react";
import type { ClientStorage } from "../workbench/client-storage";
import { EMPTY_STAGE, type StageState } from "../workbench/stage";
import {
  EMPTY_DOCK,
  pruneStageState,
  readDockState,
  readStageState,
  shownPanel,
  writeDockState,
  writeStageState,
  type DockState,
} from "../workbench/workbench-layout-state";

/** Enough of a pause that a drag or a burst of tab work is one write. */
const WRITE_DELAY_MS = 400;

export interface WorkbenchLayoutStateOptions {
  storage: ClientStorage;
  /**
   * What the stored layout is keyed by: the workspace's identity where the
   * host mints one, its path otherwise. Nothing is restored or written
   * without either.
   */
  workspaceKey: string | undefined;
  /** The workspace's root, for dropping a restored file tab of another project. */
  workspacePath: string | undefined;
  /** Threads the index knows; empty while it has not arrived. */
  knownThreadIds: readonly string[];
  /** Dock panel ids the registry offers now; kits add theirs one by one at startup. */
  panelIds: readonly string[];
}

/**
 * The stage and the dock across restarts, per workspace. Restoring happens
 * when the workspace changes; writing is deferred, and only for the workspace
 * that was last restored, so opening one never overwrites another's layout.
 */
export function useWorkbenchLayoutState(options: WorkbenchLayoutStateOptions) {
  const { storage, workspaceKey, workspacePath, knownThreadIds, panelIds } = options;
  const [stage, setStage] = useState<StageState>(EMPTY_STAGE);
  const [dock, setDock] = useState<DockState>(EMPTY_DOCK);
  /** Which workspace the state on screen came from; state, so clearing it restores again. */
  const [restoredFor, setRestoredFor] = useState<string>();
  /** Counts calls that show, hide or pick a dock panel; a restore is not one. */
  const [dockAsks, setDockAsks] = useState(0);

  useEffect(() => {
    if (!workspaceKey || restoredFor === workspaceKey) return;
    setRestoredFor(workspaceKey);
    setStage(pruneStageState(readStageState(storage, workspaceKey), { ...(workspacePath ? { workspacePath } : {}) }));
    setDock(readDockState(storage, workspaceKey));
  }, [restoredFor, storage, workspaceKey, workspacePath]);

  // The index arrives after the first paint; a tab whose thread it does not
  // list was restored from a session that is gone.
  useEffect(() => {
    if (knownThreadIds.length === 0) return;
    const known = new Set(knownThreadIds);
    setStage((current) => pruneStageState(current, { knownThreadIds: known }));
  }, [knownThreadIds]);

  useEffect(() => {
    if (!workspaceKey || restoredFor !== workspaceKey) return;
    const timer = window.setTimeout(() => writeStageState(storage, workspaceKey, stage), WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [restoredFor, stage, storage, workspaceKey]);

  useEffect(() => {
    if (!workspaceKey || restoredFor !== workspaceKey) return;
    const timer = window.setTimeout(() => writeDockState(storage, workspaceKey, dock), WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dock, restoredFor, storage, workspaceKey]);

  const setDockOpen = useCallback((open: SetStateAction<boolean>) => {
    setDockAsks((count) => count + 1);
    setDock((current) => {
      const next = typeof open === "function" ? open(current.open) : open;
      return current.open === next ? current : { ...current, open: next };
    });
  }, []);
  const setActivePanel = useCallback((activePanel: string) => {
    setDockAsks((count) => count + 1);
    setDock((current) => {
      if (current.activePanel === activePanel) return current;
      const openedPanels = !activePanel || current.openedPanels.includes(activePanel)
        ? current.openedPanels
        : [...current.openedPanels, activePanel];
      return { ...current, activePanel, openedPanels };
    });
  }, []);
  const setDrawer = useCallback((drawer: string | undefined) => setDock((current) => {
    if (current.drawer === drawer) return current;
    const { drawer: _closed, ...rest } = current;
    return drawer ? { ...rest, drawer } : rest;
  }), []);
  const setDockWidth = useCallback((width: number) => setDock((current) => current.width === width ? current : { ...current, width }), []);
  // The stored panel stays the choice while its kit has not activated; the
  // stand-in shown meanwhile is never written back.
  const activePanel = shownPanel(dock.activePanel, panelIds);
  const openedPanels = useMemo(
    () => activePanel && !dock.openedPanels.includes(activePanel) ? [...dock.openedPanels, activePanel] : dock.openedPanels,
    [activePanel, dock.openedPanels],
  );

  return {
    stage, setStage,
    dockOpen: dock.open, setDockOpen, dockAsks,
    activePanel, setActivePanel,
    openedPanels,
    dockWidth: dock.width, setDockWidth,
    drawer: dock.drawer, setDrawer,
    /**
     * A project switch starts the stage over; the next restore fills it.
     * Forgetting what was restored is what keeps the empty stage from being
     * written over the workspace that is being left.
     */
    resetStage: useCallback(() => { setRestoredFor(undefined); setStage(EMPTY_STAGE); }, []),
  };
}
