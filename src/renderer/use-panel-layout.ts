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
  /** The stage fills the centre and the chat is its first tab. */
  maximized: boolean;
}

export interface PanelLayoutPorts extends PanelLayoutState {
  setStage: Dispatch<SetStateAction<StageState>>;
  stageTabs: StageTabController;
  setDockOpen(open: boolean): void;
  setActivePanel(id: string): void;
  setDrawer(id: string | undefined): void;
  /** A panel tab came to the front; a narrow centre then shows the stage, not the chat. */
  showStage(): void;
  /** The stage over the whole centre, the chat its first tab; a panel tab maximizes it too. */
  setStageMaximized(maximized: boolean): void;
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
  /** Leaves the maximized layout; `id` is the panel to show beside the chat again. */
  restore(id?: string): void;
  /** The documents beside the chat take the whole centre. */
  maximizeStage(): void;
  toggleMaximized(): void;
}

/** A panel that fills the space beside the chat; the rest float over it until they have something to show. */
export function isWidePanel(panels: readonly PanelContribution[], id: string | undefined): boolean {
  return panels.some((panel) => panel.id === id && panel.width === "wide" && panel.placement !== "drawer");
}

export type MaximizeTarget = { restore: true; panel?: string } | { maximize: string } | { stage: true } | Record<string, never>;

/** What the maximize command acts on: the maximized layout, else the panel the keyboard, the dock or the drawer has in front. */
export function maximizeTarget(state: PanelLayoutState, focused: string | undefined): MaximizeTarget {
  if (state.maximized) {
    const front = activeTab(state.stage);
    return front?.kind === "panel" ? { restore: true, panel: front.panelId } : { restore: true };
  }
  const can = (id: string | undefined) => Boolean(id) && state.panels.some((panel) => panel.id === id && panel.maximizable);
  if (can(focused)) return { maximize: focused! };
  const dockShows = state.dockOpen && state.panels.some((panel) => panel.id === state.activePanel && panel.placement !== "drawer");
  if (dockShows && isWidePanel(state.panels, state.activePanel) && can(state.activePanel)) return { maximize: state.activePanel };
  if (state.stage.tabs.length > 0) return { stage: true };
  if (dockShows && can(state.activePanel)) return { maximize: state.activePanel };
  if (can(state.drawer)) return { maximize: state.drawer! };
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
    const maximize = (id: string) => {
      const current = latest.current;
      if (!current.panels.some((panel) => panel.id === id && panel.maximizable)) return;
      current.setStage((stage) => openPanelTab(stage, id));
      current.showStage();
      current.setStageMaximized(true);
      // The panel left; what held it has nothing to show.
      if (current.drawer === id) current.setDrawer(undefined);
      if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    const openPanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.open(id)) return;
      if (isStaged(id)) {
        current.setStage((stage) => activateTab(stage, panelTabId(id)));
        current.showStage();
        return;
      }
      // While maximized, a tool that would fill the space beside the chat joins the tabs instead.
      if (current.maximized && isWidePanel(current.panels, id) && current.panels.some((panel) => panel.id === id && panel.maximizable)) { maximize(id); return; }
      show(id);
    };
    const closePanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.close(id)) return;
      if (isStaged(id)) current.stageTabs.close(panelTabId(id));
      else if (current.drawer === id) current.setDrawer(undefined);
      else if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    // Every panel tab goes back where it was placed; only one of them can be beside the chat.
    const restore = (id?: string) => {
      const current = latest.current;
      for (const panelId of stagedPanelIds(current.stage)) current.stageTabs.close(panelTabId(panelId));
      current.setStageMaximized(false);
      if (id) show(id);
    };
    const maximizeStage = () => {
      const current = latest.current;
      if (current.stage.tabs.length === 0) return;
      current.setStageMaximized(true);
      current.showStage();
      if (current.dockOpen && isWidePanel(current.panels, current.activePanel)) current.setDockOpen(false);
    };
    const toggleMaximized = () => {
      const target = maximizeTarget(latest.current, latest.current.focusedPanel?.());
      if ("restore" in target) restore(target.panel);
      else if ("maximize" in target) maximize(target.maximize);
      else if ("stage" in target) maximizeStage();
    };
    return { openPanel, closePanel, maximize, restore, maximizeStage, toggleMaximized };
  });
  return useMemo(() => ({ staged, ...layout }), [layout, staged]);
}
