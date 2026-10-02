import type { ClientStorage } from "./client-storage";
import { EMPTY_STAGE, type StageState, type StageTab } from "./stage";
import { dockStateKey, stageStateKey } from "./storage-keys";

/**
 * What a window puts back when it shows a thread or project it has seen
 * before: the stage's tabs and the dock's panels. Pure, so the pruning rules
 * can be tested without a window.
 *
 * The stage format is deliberately generic — a tab is stored the way it is
 * held, with only `id`, `kind` and `preview` required, so a kind added later
 * round-trips and an unreadable one is dropped rather than breaking the rest.
 */
export interface DockState {
  open: boolean;
  activePanel?: string;
  /** Panels that were mounted at least once; a panel keeps its state that way. */
  openedPanels: readonly string[];
  width?: number;
  /** The drawer panel shown below the conversation; absent while the drawer is closed. */
  drawer?: string;
}

export const EMPTY_DOCK: DockState = { open: false, openedPanels: [] };

/** The part of the dock each thread keeps: whether it is open, what it shows, and the drawer. */
export interface ThreadDockState {
  open: boolean;
  activePanel?: string;
  drawer?: string;
}

export function threadDock(dock: DockState): ThreadDockState {
  return {
    open: dock.open,
    ...(dock.activePanel ? { activePanel: dock.activePanel } : {}),
    ...(dock.drawer ? { drawer: dock.drawer } : {}),
  };
}

/** A thread's dock over its project's: a thread that kept none starts closed, on the panel last picked in the project. */
export function mergeDock(project: DockState, thread: ThreadDockState | undefined): DockState {
  const activePanel = thread?.activePanel ?? project.activePanel;
  return {
    open: thread?.open ?? false,
    openedPanels: project.openedPanels,
    ...(activePanel ? { activePanel } : {}),
    ...(project.width !== undefined ? { width: project.width } : {}),
    ...(thread?.drawer ? { drawer: thread.drawer } : {}),
  };
}

function parse(storage: ClientStorage, key: string): Record<string, unknown> | undefined {
  try {
    const raw = storage.get(key);
    const value = raw ? JSON.parse(raw) as unknown : undefined;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function write(storage: ClientStorage, key: string, value: unknown): void {
  try {
    storage.set(key, JSON.stringify(value));
  } catch {
    // Restoring the layout is a convenience; a full or blocked store is not worth surfacing.
  }
}

/** A stored tab is kept when it carries the three fields every kind has. */
function decodeTab(value: unknown): StageTab | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tab = value as Record<string, unknown>;
  if (typeof tab.id !== "string" || !tab.id) return undefined;
  if (typeof tab.kind !== "string" || !tab.kind) return undefined;
  if (typeof tab.preview !== "boolean") return undefined;
  if (tab.kind === "file" && (typeof tab.path !== "string" || (tab.view !== "source" && tab.view !== "diff"))) return undefined;
  if (tab.kind === "thread" && (typeof tab.sessionId !== "string" || (tab.machine !== undefined && typeof tab.machine !== "string"))) return undefined;
  if (tab.kind === "panel" && (typeof tab.panelId !== "string" || !tab.panelId)) return undefined;
  if (tab.kind === "file" && tab.resourceOrigin !== undefined && tab.resourceOrigin !== null) {
    const origin = tab.resourceOrigin as Record<string, unknown>;
    if (typeof origin !== "object" || ![origin.sessionId, origin.workspace, origin.sourceId].every((field) => typeof field === "string" && field.length > 0)) {
      return { ...tab, resourceOrigin: null } as unknown as StageTab;
    }
  }
  return tab as unknown as StageTab;
}

export function decodeStageState(value: unknown): StageState {
  const stored = value as { tabs?: unknown; activeId?: unknown; splitId?: unknown } | undefined;
  if (!Array.isArray(stored?.tabs)) return EMPTY_STAGE;
  const tabs = stored.tabs.flatMap((entry) => { const tab = decodeTab(entry); return tab ? [tab] : []; });
  if (tabs.length === 0) return EMPTY_STAGE;
  const activeId = typeof stored.activeId === "string" && tabs.some((tab) => tab.id === stored.activeId)
    ? stored.activeId
    : tabs[0].id;
  return { tabs, activeId, splitId: tabs.find((tab) => tab.id === stored.splitId && tab.id !== activeId)?.id };
}

/** The stage a project kept before stages were per thread (`tau.stage.v1`). */
export function readStageState(storage: ClientStorage, workspace: string): StageState {
  return decodeStageState(parse(storage, stageStateKey(workspace)));
}

export function decodeDockState(value: unknown): DockState {
  const stored = value as Record<string, unknown> | undefined;
  if (!stored) return EMPTY_DOCK;
  const openedPanels = Array.isArray(stored.openedPanels)
    ? stored.openedPanels.filter((id): id is string => typeof id === "string")
    : [];
  return {
    open: stored.open === true,
    ...(typeof stored.activePanel === "string" ? { activePanel: stored.activePanel } : {}),
    openedPanels,
    ...(typeof stored.width === "number" && Number.isFinite(stored.width) ? { width: stored.width } : {}),
    ...(typeof stored.drawer === "string" && stored.drawer ? { drawer: stored.drawer } : {}),
  };
}

export function readDockState(storage: ClientStorage, workspace: string): DockState {
  return decodeDockState(parse(storage, dockStateKey(workspace)));
}

/**
 * The project's part of the dock. `open` and `drawer` are each thread's now;
 * a record from before keeps them until a thread takes them over.
 */
export function writeDockState(storage: ClientStorage, workspace: string, state: DockState): void {
  const legacy = parse(storage, dockStateKey(workspace));
  write(storage, dockStateKey(workspace), {
    ...(legacy?.open === true ? { open: true } : {}),
    ...(typeof legacy?.drawer === "string" && legacy.drawer ? { drawer: legacy.drawer } : {}),
    ...(state.activePanel ? { activePanel: state.activePanel } : {}),
    openedPanels: state.openedPanels,
    ...(state.width !== undefined ? { width: state.width } : {}),
  });
}

/**
 * Hands a project's layout from before stages were per thread to one thread:
 * the old stage, and whether the dock and the drawer were open. Both are
 * removed from the project, so only one thread ever gets them.
 */
export function takeProjectLayout(storage: ClientStorage, workspace: string): { stage: StageState; dock: ThreadDockState } | undefined {
  const stage = readStageState(storage, workspace);
  const stored = parse(storage, dockStateKey(workspace));
  const dock = decodeDockState(stored);
  if (stage.tabs.length === 0 && !dock.open && !dock.drawer) return undefined;
  storage.remove(stageStateKey(workspace));
  if (stored) {
    const { open: _open, drawer: _drawer, ...rest } = stored;
    write(storage, dockStateKey(workspace), rest);
  }
  return { stage, dock: threadDock(dock) };
}

/**
 * The panel the dock shows: the chosen one once a kit offers it, the first
 * offered panel until then. The choice itself is left alone, so a panel
 * restored before its kit activates comes back when the kit does.
 */
export function shownPanel(chosen: string | undefined, offered: readonly string[]): string {
  return chosen && offered.includes(chosen) ? chosen : offered[0] ?? "";
}

export interface StagePruneOptions {
  /** The workspace the window is on; a file outside it belongs to another one. */
  workspacePath?: string;
  /** Threads the index knows. Absent while the index has not arrived yet. */
  knownThreadIds?: ReadonlySet<string>;
}

/**
 * Drops what a restored stage can no longer show: a file of another project
 * and a thread the index has forgotten. Silent on purpose — a tab that cannot
 * open is noise, not an error.
 */
export function pruneStageState(state: StageState, options: StagePruneOptions): StageState {
  const tabs = state.tabs.filter((tab) => {
    if (tab.kind === "file") return !options.workspacePath || isInside(options.workspacePath, tab.path);
    // Another machine's thread is not in this index; its tab says itself when it is gone.
    if (tab.kind === "thread") return tab.machine !== undefined || !options.knownThreadIds || options.knownThreadIds.has(tab.sessionId);
    return true;
  });
  if (tabs.length === state.tabs.length) return state;
  if (tabs.length === 0) return EMPTY_STAGE;
  return { ...state, tabs, activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : tabs[0].id };
}

/**
 * A document source may name a file relative to the workspace or absolutely.
 * Only an absolute path can be read as belonging to another project; a
 * relative one is this workspace's by construction.
 */
function isInside(root: string, path: string): boolean {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) return true;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
}
