import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { activateTab, activeTab, addPanelTabBehind, openPanelTab, panelTabId, stagedPanelIds, type StageState } from "../workbench/stage";
import { toolPlace } from "../workbench/center-layout";
import type { PanelContribution, WorkbenchActions } from "./extension-system";
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
  /** What a panel's `redirect` is handed. */
  actions?(): WorkbenchActions | undefined;
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
  /** A document opened on the stage: a wide tool beside the chat joins the tabs behind it. */
  documentOpened(): void;
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
    const panelOf = (id: string) => latest.current.panels.find((panel) => panel.id === id);
    const isStaged = (id: string) => stagedPanelIds(latest.current.stage).includes(id);
    const placeOf = (id: string, stageOpen: boolean, maximized = latest.current.maximized) => {
      const panel = panelOf(id);
      return toolPlace({ placement: panel?.placement, width: panel?.width, maximizable: panel?.maximizable, stageOpen, maximized });
    };
    const show = (id: string) => {
      const current = latest.current;
      if (placeOf(id, false) === "drawer") current.setDrawer(id);
      else { current.setActivePanel(id); current.setDockOpen(true); }
    };
    // The panel leaves the dock or the drawer for a tab in front.
    const stagePanel = (id: string) => {
      const current = latest.current;
      current.setStage((stage) => openPanelTab(stage, id));
      current.showStage();
      if (current.drawer === id) current.setDrawer(undefined);
      if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    const maximize = (id: string) => {
      if (!panelOf(id)?.maximizable) return;
      stagePanel(id);
      latest.current.setStageMaximized(true);
    };
    const openPanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.open(id)) return;
      const actions = current.actions?.();
      if (actions && panelOf(id)?.redirect?.(actions)) return;
      if (isStaged(id)) {
        current.setStage((stage) => activateTab(stage, panelTabId(id)));
        current.showStage();
        return;
      }
      if (placeOf(id, current.stage.tabs.length > 0) === "tab") stagePanel(id);
      else show(id);
    };
    const closePanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.close(id)) return;
      if (isStaged(id)) current.stageTabs.close(panelTabId(id));
      else if (current.drawer === id) current.setDrawer(undefined);
      else if (current.dockOpen && current.activePanel === id) current.setDockOpen(false);
    };
    // Lists go back where they were placed; beside open documents a wide tool stays a tab.
    const restore = (id?: string) => {
      const current = latest.current;
      const documents = current.stage.tabs.some((tab) => tab.kind !== "panel");
      const kept = stagedPanelIds(current.stage).filter((panelId) => placeOf(panelId, documents, false) === "tab");
      for (const panelId of stagedPanelIds(current.stage)) if (!kept.includes(panelId)) current.stageTabs.close(panelTabId(panelId));
      current.setStageMaximized(false);
      if (id && !kept.includes(id)) show(id);
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
    const documentOpened = () => {
      const current = latest.current;
      const id = current.activePanel;
      if (current.maximized || !current.dockOpen || !isWidePanel(current.panels, id)) return;
      if (placeOf(id, true) === "tab") current.setStage((stage) => addPanelTabBehind(stage, id));
      current.setDockOpen(false);
    };
    return { openPanel, closePanel, maximize, restore, maximizeStage, toggleMaximized, documentOpened };
  });
  return useMemo(() => ({ staged, ...layout }), [layout, staged]);
}
