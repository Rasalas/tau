import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  activeTab,
  activateTab,
  closeTab,
  forgetClosedTab,
  recentlyClosed,
  rememberClosedTab,
  reopenClosedTab,
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
import type { ExtensionRegistry, StageTabHandle, WorkbenchActions } from "./extension-system";

/** What a kind's `reopenParams` may keep: plain JSON, small. */
const MAX_REOPEN_PARAMS = 4_096;

function plainParams(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_REOPEN_PARAMS) return undefined;
    const copy = JSON.parse(json) as Record<string, unknown>;
    // A function, a class instance or `undefined` would not survive the trip unchanged.
    return JSON.stringify(copy) === json && stageParamsKey(copy) === stageParamsKey(value as Record<string, unknown>) ? copy : undefined;
  } catch {
    return undefined;
  }
}

export interface StageTabPorts {
  registry: ExtensionRegistry;
  /** The stage as of now; the controller never holds a rendered copy of it. */
  stage(): StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  /** Asks the user about a tab that says it has unsaved work; true closes it. */
  confirmDiscard(title: string): boolean;
  /** A tab was opened, so the stage comes forward. */
  onOpen?(): void;
  /** What a kind's `reopen` is handed. */
  actions?(): WorkbenchActions | undefined;
  now?(): number;
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

  /** The registered source a resource reader must still belong to before file commands act. */
  documentSourceId = (): string | undefined => this.ports.registry.getDocumentSource()?.id;

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
    const closedAt = this.ports.now?.() ?? Date.now();
    // A tab nobody can save any more is not offered again; nor is one its kind keeps nothing of.
    const remembered = force ? [] : closing.flatMap((tab) => { const kept = this.reopenable(tab); return kept ? [kept] : []; });
    const closed = closing.map((tab) => tab.id);
    this.ports.setStage((current) => remembered.reduce(
      (state, tab) => rememberClosedTab(state, tab, closedAt),
      closed.reduce((state, id) => closeTab(state, id), current),
    ));
  }

  /** What history keeps of a closed tab, pinned; a panel goes back to its dock and is not closed at all. */
  private reopenable(tab: StageTab): StageTab | undefined {
    if (tab.kind === "panel") return undefined;
    if (tab.kind === "thread") return { ...tab, preview: false };
    if (tab.kind === "file") {
      const { line: _line, reveal: _reveal, trace: _trace, ...file } = tab;
      return { ...file, preview: false };
    }
    const kind = this.ports.registry.getStageTabKind(tab.tabKind);
    const params = plainParams(kind?.reopenParams?.(tab.params));
    if (!kind || !params) return undefined;
    // Id and title of the params it was opened with may name a process; the kept ones derive from what was kept.
    return { id: extensionTabId(tab.tabKind, stageParamsKey(params)), kind: "extension", tabKind: tab.tabKind, params, title: kind.title(params), preview: false };
  }

  /** What "Recently closed" lists, newest first. */
  closedTabs = (): readonly StageTab[] => recentlyClosed(this.ports.stage()).map((entry) => entry.tab);

  /**
   * Brings back the tab closed last, or the one `id` names: a file or thread
   * as it was, an extension tab through its kind (a terminal as a new shell).
   */
  reopen = (id?: string): boolean => {
    const entries = recentlyClosed(this.ports.stage());
    const entry = id === undefined ? entries[0] : entries.find((candidate) => candidate.tab.id === id);
    if (!entry) {
      // Listed but open again: only brought forward.
      if (id !== undefined && this.ports.stage().tabs.some((tab) => tab.id === id)) {
        this.ports.setStage((current) => activateTab(forgetClosedTab(current, id), id));
        return true;
      }
      return false;
    }
    const { tab } = entry;
    if (tab.kind !== "extension") {
      this.ports.setStage((current) => reopenClosedTab(current, tab));
      this.ports.onOpen?.();
      return true;
    }
    const contribution = this.ports.registry.getStageTabKind(tab.tabKind);
    this.ports.setStage((current) => forgetClosedTab(current, tab.id));
    if (!contribution) return false;
    const actions = this.ports.actions?.();
    if (contribution.reopen && actions) {
      void Promise.resolve(contribution.reopen(tab.params, actions)).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
      return true;
    }
    this.open(tab.tabKind, tab.params);
    return true;
  };

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
  actions?: () => WorkbenchActions | undefined;
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
    ...(ports.actions ? { actions: ports.actions } : {}),
  }));
  useEffect(() => { controller.syncKinds(); }, [controller, ports.registryVersion, ports.stage]);
  return controller;
}
