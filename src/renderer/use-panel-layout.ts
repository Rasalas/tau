import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { activateTab, activeTab, openPanelTab, panelTabId, stagedPanelIds, type StageState } from "../workbench/stage";
import type { PanelContribution } from "./extension-system";
import type { StageTabController } from "./stage-tab-controller";

export interface PanelLayoutState {
  panels: readonly PanelContribution[];
  stage: StageState;
  dockOpen: boolean;
  activePanel: string;
  drawer?: string;
}

export interface PanelLayoutPorts extends PanelLayoutState {
  setStage: Dispatch<SetStateAction<StageState>>;
  stageTabs: StageTabController;
  setDockOpen(open: boolean): void;
  setActivePanel(id: string): void;
  setDrawer(id: string | undefined): void;
  /** A panel tab came to the front; a narrow centre then shows the stage, not the chat. */
  showStage(): void;
  /** The panel the keyboard is in, if any. */
  focusedPanel?(): string | undefined;
  /** A compact layout's sheets: each answers true when it took the call, and the dock is left alone. */
  sheets?: { open(id: string): boolean; close(id: string): boolean };
}

export interface PanelLayout {
  /** Panels maximized into a stage tab. */
  staged: ReadonlySet<string>;
  openPanel(id: string): void;
  closePanel(id: string): void;
  maximize(id: string): void;
  restore(id: string): void;
  toggleMaximized(): void;
}

/** The panel the dock, the keyboard or the drawer has in front, in that order of intent. */
export function maximizeTarget(state: PanelLayoutState, focused: string | undefined): { restore?: string; maximize?: string } {
  const front = activeTab(state.stage);
  if (front?.kind === "panel") return { restore: front.panelId };
  const staged = new Set(stagedPanelIds(state.stage));
  const can = (id: string | undefined) => Boolean(id) && !staged.has(id!) && state.panels.some((panel) => panel.id === id && panel.maximizable);
  if (can(focused)) return { maximize: focused };
  if (state.dockOpen && can(state.activePanel)) return { maximize: state.activePanel };
  if (can(state.drawer)) return { maximize: state.drawer };
  return {};
}

/**
 * Where each panel shows: the dock, the drawer, or a stage tab. Callbacks read
 * the latest state through a ref, so the actions built on them keep their identity.
 */
export function usePanelLayout(ports: PanelLayoutPorts): PanelLayout {
  const latest = useRef(ports);
  latest.current = ports;
  const staged = useMemo(() => new Set(stagedPanelIds(ports.stage)), [ports.stage]);
  const [layout] = useState(() => {
    const placementOf = (id: string) => latest.current.panels.find((panel) => panel.id === id)?.placement ?? "dock";
    const isStaged = (id: string) => stagedPanelIds(latest.current.stage).includes(id);
    const show = (id: string) => {
      const current = latest.current;
      if (placementOf(id) === "drawer") current.setDrawer(id);
      else { current.setActivePanel(id); current.setDockOpen(true); }
    };
    const openPanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.open(id)) return;
      if (!isStaged(id)) { show(id); return; }
      current.setStage((stage) => activateTab(stage, panelTabId(id)));
      current.showStage();
    };
    const closePanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.close(id)) return;
      if (isStaged(id)) current.stageTabs.close(panelTabId(id));
      else if (current.drawer === id) current.setDrawer(undefined);
      else if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    const maximize = (id: string) => {
      const current = latest.current;
      if (!current.panels.some((panel) => panel.id === id && panel.maximizable)) return;
      current.setStage((stage) => openPanelTab(stage, id));
      current.showStage();
      // The panel left; what held it has nothing to show.
      if (current.drawer === id) current.setDrawer(undefined);
      if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    const restore = (id: string) => {
      latest.current.stageTabs.close(panelTabId(id));
      show(id);
    };
    const toggleMaximized = () => {
      const target = maximizeTarget(latest.current, latest.current.focusedPanel?.());
      if (target.restore) restore(target.restore);
      else if (target.maximize) maximize(target.maximize);
    };
    return { openPanel, closePanel, maximize, restore, toggleMaximized };
  });
  return useMemo(() => ({ staged, ...layout }), [layout, staged]);
}
