import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { activateTab, openPanelTab, panelTabId, stagedPanelIds, type StageState } from "../workbench/stage";
import { toolPlace } from "../workbench/center-layout";
import type { PanelContribution, WorkbenchActions } from "./extension-system";
import type { StageTabController } from "./stage-tab-controller";

export interface PanelLayoutState {
  panels: readonly PanelContribution[];
  stage: StageState;
  activePanel: string;
  drawer?: string;
  /** The stage fills the centre and the conversation is folded to its spine. */
  maximized: boolean;
}

export interface PanelLayoutPorts extends PanelLayoutState {
  setStage: Dispatch<SetStateAction<StageState>>;
  stageTabs: StageTabController;
  /** Remembers the tool last picked in the project. */
  setActivePanel(id: string): void;
  setDrawer(id: string | undefined): void;
  /** A tab came to the front: the stage unfolds, and a stacked centre shows it rather than the chat. */
  showStage(): void;
  setStageMaximized(maximized: boolean): void;
  /** The panel the keyboard is in, if any. */
  focusedPanel?(): string | undefined;
  /** A compact layout's sheets: each answers true when it took the call, and the stage is left alone. */
  sheets?: { open(id: string): boolean; close(id: string): boolean };
  /** What a panel's `redirect` is handed. */
  actions?(): WorkbenchActions | undefined;
}

export interface PanelLayout {
  /** Panels shown as stage tabs. */
  staged: ReadonlySet<string>;
  openPanel(id: string): void;
  closePanel(id: string): void;
  /** Moves the panel onto the stage and the stage over the whole centre. */
  maximize(id: string): void;
  /** Leaves the maximized layout; every tab stays. */
  restore(): void;
  maximizeStage(): void;
  toggleMaximized(): void;
  /** A document, a thread or a kit's tab opened: the stage shows it. */
  documentOpened(): void;
}

export type MaximizeTarget = { restore: true } | { maximize: string } | { stage: true } | Record<string, never>;

/** What the maximize command acts on: the maximized layout, else the drawer panel the keyboard is in, the stage, or the drawer. */
export function maximizeTarget(state: PanelLayoutState, focused: string | undefined): MaximizeTarget {
  if (state.maximized) return { restore: true };
  const inDrawer = (id: string | undefined) => Boolean(id) && id === state.drawer && state.panels.some((panel) => panel.id === id && panel.maximizable);
  if (inDrawer(focused)) return { maximize: focused! };
  if (state.stage.tabs.length > 0) return { stage: true };
  if (inDrawer(state.drawer)) return { maximize: state.drawer! };
  return {};
}

/**
 * Where each panel shows: a stage tab, or the drawer for a panel that asked
 * for it. Callbacks read the latest state through a ref, so the actions built
 * on them keep their identity.
 */
export function usePanelLayout(ports: PanelLayoutPorts): PanelLayout {
  const latest = useRef(ports);
  latest.current = ports;
  const staged = useMemo(() => new Set(stagedPanelIds(ports.stage)), [ports.stage]);
  const [layout] = useState(() => {
    const panelOf = (id: string) => latest.current.panels.find((panel) => panel.id === id);
    const isStaged = (id: string) => stagedPanelIds(latest.current.stage).includes(id);
    // The panel leaves the drawer for a tab in front.
    const stagePanel = (id: string) => {
      const current = latest.current;
      current.setStage((stage) => openPanelTab(stage, id));
      current.setActivePanel(id);
      current.showStage();
      if (current.drawer === id) current.setDrawer(undefined);
    };
    const maximize = (id: string) => {
      if (!panelOf(id)) return;
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
      if (toolPlace({ placement: panelOf(id)?.placement }) === "drawer") current.setDrawer(id);
      else stagePanel(id);
    };
    const closePanel = (id: string) => {
      const current = latest.current;
      if (current.sheets?.close(id)) return;
      if (isStaged(id)) current.stageTabs.close(panelTabId(id));
      else if (current.drawer === id) current.setDrawer(undefined);
    };
    const restore = () => latest.current.setStageMaximized(false);
    const maximizeStage = () => {
      const current = latest.current;
      if (current.stage.tabs.length === 0) return;
      current.setStageMaximized(true);
      current.showStage();
    };
    const toggleMaximized = () => {
      const target = maximizeTarget(latest.current, latest.current.focusedPanel?.());
      if ("restore" in target) restore();
      else if ("maximize" in target) maximize(target.maximize);
      else if ("stage" in target) maximizeStage();
    };
    const documentOpened = () => latest.current.showStage();
    return { openPanel, closePanel, maximize, restore, maximizeStage, toggleMaximized, documentOpened };
  });
  return useMemo(() => ({ staged, ...layout }), [layout, staged]);
}
