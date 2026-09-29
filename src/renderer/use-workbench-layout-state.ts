import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { ClientStorage } from "../workbench/client-storage";
import { EMPTY_STAGE, type StageState } from "../workbench/stage";
import type { ThreadStages } from "../workbench/thread-stages";
import {
  EMPTY_DOCK,
  mergeDock,
  pruneStageState,
  readDockState,
  shownPanel,
  threadDock,
  writeDockState,
  type DockState,
} from "../workbench/workbench-layout-state";

/** Enough of a pause that a drag or a burst of tab work is one write. */
const WRITE_DELAY_MS = 400;

export interface WorkbenchLayoutStateOptions {
  storage: ClientStorage;
  /** Where each thread's and draft's layout is kept. */
  stages: ThreadStages;
  /** Whose layout is on screen (`stageOwner`); nothing is restored or written without one. */
  owner: string | undefined;
  /**
   * The owner's project: the workspace's identity where the host mints one,
   * its path otherwise. The dock's width and mounted panels are kept per project.
   */
  workspaceKey: string | undefined;
  /** The workspace's root, for dropping a restored file tab of another project. */
  workspacePath: string | undefined;
  /** Threads the index knows; empty while it has not arrived. */
  knownThreadIds: readonly string[];
  /** Dock panel ids the registry offers now; kits add theirs one by one at startup. */
  panelIds: readonly string[];
}

interface Restored {
  owner: string;
  workspace?: string;
}

/**
 * The stage and the dock across switches and restarts, per thread and per
 * draft. Switching writes what the one being left shows at once and restores
 * the next; changes are written deferred, only for the owner on screen, so
 * showing one never overwrites another's layout.
 */
export function useWorkbenchLayoutState(options: WorkbenchLayoutStateOptions) {
  const { storage, stages, owner, workspaceKey, workspacePath, knownThreadIds, panelIds } = options;
  const [stage, setStage] = useState<StageState>(EMPTY_STAGE);
  const [stageMaximized, setStageMaximized] = useState(false);
  const [stageFolded, setStageFolded] = useState(false);
  const [dock, setDock] = useState<DockState>(EMPTY_DOCK);
  /** Whose layout is on screen and its project; state, so the restore re-renders. */
  const [restored, setRestored] = useState<Restored>();
  /** Counts calls that show, hide or pick a dock panel; a restore is not one. */
  const [dockAsks, setDockAsks] = useState(0);
  const held = useRef({ restored, stage, stageMaximized, stageFolded, dock });
  held.current = { restored, stage, stageMaximized, stageFolded, dock };

  const persist = useCallback(() => {
    const { restored: at, stage: tabs, stageMaximized: maximized, stageFolded: folded, dock: shown } = held.current;
    if (!at) return;
    stages.write(at.owner, { stage: tabs, maximized, folded, dock: threadDock(shown) });
    if (at.workspace) writeDockState(storage, at.workspace, shown);
  }, [stages, storage]);

  useEffect(() => {
    if (!owner) return;
    const current = held.current.restored;
    // The same owner, or the thread a draft on screen just became: what is on screen stays.
    if (current && (current.owner === owner || stages.promotedTo(current.owner) === owner)) {
      if (current.owner === owner && (!workspaceKey || current.workspace === workspaceKey)) return;
      setRestored({ owner, ...(workspaceKey ?? current.workspace ? { workspace: workspaceKey ?? current.workspace } : {}) });
      if (!current.workspace && workspaceKey) setDock((shown) => mergeDock(readDockState(storage, workspaceKey), threadDock(shown)));
      return;
    }
    persist();
    const layout = stages.read(owner, workspaceKey);
    setRestored({ owner, ...(workspaceKey ? { workspace: workspaceKey } : {}) });
    setStage(pruneStageState(layout?.stage ?? EMPTY_STAGE, { ...(workspacePath ? { workspacePath } : {}) }));
    setStageMaximized(layout?.maximized ?? false);
    setStageFolded(layout?.folded ?? false);
    setDock(mergeDock(workspaceKey ? readDockState(storage, workspaceKey) : EMPTY_DOCK, layout?.dock));
  }, [owner, persist, stages, storage, workspaceKey, workspacePath]);

  // The index arrives after the first paint; a tab whose thread it does not
  // list was restored from a session that is gone.
  useEffect(() => {
    if (knownThreadIds.length === 0) return;
    const known = new Set(knownThreadIds);
    setStage((current) => pruneStageState(current, { knownThreadIds: known }));
  }, [knownThreadIds]);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(persist, WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dock, persist, restored, stage, stageFolded, stageMaximized]);

  // A window that closes inside the write delay still keeps what it showed.
  useEffect(() => {
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, [persist]);

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
  // The dock's old toggle shows or folds the stage now.
  const setStageShown = useCallback((shown: SetStateAction<boolean>) => {
    setStageFolded((folded) => !(typeof shown === "function" ? shown(!folded) : shown));
  }, []);
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
    /** The project of the stage on screen; it lags `workspaceKey` until the restore runs. */
    stageWorkspace: restored?.workspace,
    /** The documents fill the centre, the chat out of sight; kept with the thread, restored on a restart. */
    stageMaximized, setStageMaximized,
    /** The stage hidden; kept with the thread. */
    stageFolded, setStageFolded, setStageShown,
    dockOpen: dock.open, setDockOpen, dockAsks,
    activePanel, setActivePanel,
    openedPanels,
    dockWidth: dock.width, setDockWidth,
    drawer: dock.drawer, setDrawer,
  };
}
