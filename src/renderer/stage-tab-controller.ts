import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  activeTab,
  closeTab,
  extensionTabId,
  openExtensionTab,
  otherTabIds,
  setExtensionTabDirty,
  setExtensionTabTitle,
  splitStage,
  splitTab,
  stageParamsKey,
  tabIdsToTheRight,
  type StageState,
  type StageTab,
} from "../workbench/stage";
import type { ExtensionRegistry, StageTabHandle } from "./extension-system";

export interface StageTabPorts {
  registry: ExtensionRegistry;
  /** The stage as of now; the controller never holds a rendered copy of it. */
  stage(): StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  /** Asks the user about a tab that says it has unsaved work; true closes it. */
  confirmDiscard(title: string): boolean;
  /** A tab was opened, so the stage comes forward. */
  onOpen?(): void;
}

interface HeldHandle {
  handle: StageTabHandle;
  listeners: Set<() => void>;
}

/**
 * Every stage tab a desktop extension draws, and the one door that closes a
 * tab of any kind: it asks about unsaved work, runs the tab's own `onClose`
 * listeners and forgets its handle. A kit that goes away takes its tabs with
 * it, and a tab that came back from storage is offered to its kind's
 * `restore` as soon as that kind is there to answer.
 *
 * Nothing here mutates the stage itself: it hands `setStage` a pure change,
 * so a repeated render never fires a listener twice.
 */
export class StageTabController {
  private readonly handles = new Map<string, HeldHandle>();

  /** Kinds seen registered: a tab whose kind was withdrawn goes, an unseen one waits. */
  private readonly seenKinds = new Set<string>();

  /** Tabs this controller opened or already offered to `restore`. */
  private readonly known = new Set<string>();

  constructor(private readonly ports: StageTabPorts) {}

  tabs = (): readonly StageTab[] => this.ports.stage().tabs;

  active = (): StageTab | undefined => activeTab(this.ports.stage());

  /** The handle a tab's content talks to core through; one per tab, kept while it lives. */
  handle = (id: string): StageTabHandle => {
    const held = this.handles.get(id);
    if (held) return held.handle;
    const listeners = new Set<() => void>();
    const handle: StageTabHandle = {
      id,
      setTitle: (title) => this.ports.setStage((current) => setExtensionTabTitle(current, id, title)),
      setDirty: (dirty) => this.ports.setStage((current) => setExtensionTabDirty(current, id, dirty)),
      onClose: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    this.handles.set(id, { handle, listeners });
    return handle;
  };

  open = (
    kind: string,
    params: Record<string, unknown> = {},
    options: { preview?: boolean; key?: string } = {},
  ): string => {
    const contribution = this.ports.registry.getStageTabKind(kind);
    if (!contribution) throw new Error(`Stage tab kind "${kind}" is not registered.`);
    const key = options.key ?? (contribution.singleton ? "" : stageParamsKey(params));
    const id = extensionTabId(kind, key);
    this.known.add(id);
    const title = contribution.title(params);
    const preview = options.preview === true;
    this.ports.setStage((current) => openExtensionTab(current, { tabKind: kind, key, params, title }, { preview }));
    this.ports.onOpen?.();
    return id;
  };

  /** Shows `id` beside the active tab; without one, splits off the active tab or joins the panes again. */
  split = (id?: string): void => this.ports.setStage((current) => splitStage(current, id ?? (splitTab(current) ? undefined : current.activeId)));

  close = (id: string): void => this.closeAll([id]);

  closeActive = (): void => {
    const activeId = this.ports.stage().activeId;
    if (activeId) this.closeAll([activeId]);
  };

  closeOthers = (id: string): void => this.closeAll(otherTabIds(this.ports.stage(), id));

  closeToTheRight = (id: string): void => this.closeAll(tabIdsToTheRight(this.ports.stage(), id));

  /**
   * Closes what the tab strip asked to close, in order, skipping a dirty tab
   * the user wants to keep. `force` is for tabs nobody can save any more,
   * because the extension that drew them is gone.
   */
  private closeAll(ids: readonly string[], force = false): void {
    const tabs = this.ports.stage().tabs;
    const closing = ids
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is StageTab => Boolean(tab))
      .filter((tab) => force || this.mayClose(tab));
    if (closing.length === 0) return;
    closing.forEach((tab) => this.release(tab.id));
    const closed = closing.map((tab) => tab.id);
    this.ports.setStage((current) => closed.reduce((state, id) => closeTab(state, id), current));
  }

  private mayClose(tab: StageTab): boolean {
    if (tab.kind !== "extension" || !tab.dirty) return true;
    return this.ports.confirmDiscard(tab.title);
  }

  private release(id: string): void {
    const held = this.handles.get(id);
    this.handles.delete(id);
    this.known.delete(id);
    if (!held) return;
    for (const listener of [...held.listeners]) {
      try { listener(); } catch (error) { console.error(`Stage tab ${id} failed on close`, error); }
    }
    held.listeners.clear();
  }

  /** Reconciles the open tabs with the kinds on offer; the hook runs it on every change. */
  syncKinds = (): void => {
    const gone: string[] = [];
    for (const tab of this.ports.stage().tabs) {
      if (tab.kind !== "extension") continue;
      const contribution = this.ports.registry.getStageTabKind(tab.tabKind);
      if (!contribution) {
        if (this.seenKinds.has(tab.tabKind)) gone.push(tab.id);
        continue;
      }
      if (this.known.has(tab.id)) continue;
      this.known.add(tab.id);
      if (contribution.restore && !contribution.restore(tab.params)) gone.push(tab.id);
    }
    for (const contribution of this.ports.registry.getStageTabKinds()) this.seenKinds.add(contribution.kind);
    if (gone.length > 0) this.closeAll(gone, true);
  };
}

function confirmDiscard(title: string): boolean {
  return window.confirm(`${title} has unsaved work. Close it anyway?`);
}

/**
 * The controller, bound to the stage state the workbench holds. Its identity
 * never changes, so an action built on it does not re-run an extension's effects.
 */
export function useStageTabs(ports: {
  registry: ExtensionRegistry;
  /** Bumps whenever contributions change, so a withdrawn kind is noticed. */
  registryVersion: number;
  stage: StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  confirmDiscard?: (title: string) => boolean;
  onOpen?: () => void;
}): StageTabController {
  const stage = useRef(ports.stage);
  stage.current = ports.stage;
  const confirm = useRef(ports.confirmDiscard);
  confirm.current = ports.confirmDiscard;
  const opened = useRef(ports.onOpen);
  opened.current = ports.onOpen;
  const [controller] = useState(() => new StageTabController({
    registry: ports.registry,
    stage: () => stage.current,
    setStage: ports.setStage,
    confirmDiscard: (title) => (confirm.current ?? confirmDiscard)(title),
    onOpen: () => opened.current?.(),
  }));
  useEffect(() => { controller.syncKinds(); }, [controller, ports.registryVersion, ports.stage]);
  return controller;
}
