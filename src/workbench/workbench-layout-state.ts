import type { ClientStorage } from "./client-storage";
import { EMPTY_STAGE, type StageState, type StageTab } from "./stage";
import { dockStateKey, stageStateKey } from "./storage-keys";

/**
 * What a window puts back when it opens on a workspace it has seen before:
 * the stage's tabs and the dock's panels. Pure, so the pruning rules can be
 * tested without a window.
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
}

export const EMPTY_DOCK: DockState = { open: false, openedPanels: [] };

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
  if (tab.kind === "thread" && typeof tab.sessionId !== "string") return undefined;
  return tab as unknown as StageTab;
}

export function decodeStageState(value: unknown): StageState {
  const stored = value as { tabs?: unknown; activeId?: unknown } | undefined;
  if (!Array.isArray(stored?.tabs)) return EMPTY_STAGE;
  const tabs = stored.tabs.flatMap((entry) => { const tab = decodeTab(entry); return tab ? [tab] : []; });
  if (tabs.length === 0) return EMPTY_STAGE;
  const activeId = typeof stored.activeId === "string" && tabs.some((tab) => tab.id === stored.activeId)
    ? stored.activeId
    : tabs[0].id;
  return { tabs, activeId };
}

export function readStageState(storage: ClientStorage, workspace: string): StageState {
  return decodeStageState(parse(storage, stageStateKey(workspace)));
}

export function writeStageState(storage: ClientStorage, workspace: string, state: StageState): void {
  const key = stageStateKey(workspace);
  if (state.tabs.length === 0) { storage.remove(key); return; }
  write(storage, key, { tabs: state.tabs, ...(state.activeId ? { activeId: state.activeId } : {}) });
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
  };
}

export function readDockState(storage: ClientStorage, workspace: string): DockState {
  return decodeDockState(parse(storage, dockStateKey(workspace)));
}

export function writeDockState(storage: ClientStorage, workspace: string, state: DockState): void {
  write(storage, dockStateKey(workspace), state);
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
    if (tab.kind === "thread") return !options.knownThreadIds || options.knownThreadIds.has(tab.sessionId);
    return true;
  });
  if (tabs.length === state.tabs.length) return state;
  if (tabs.length === 0) return EMPTY_STAGE;
  return { tabs, activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : tabs[0].id };
}

function isInside(root: string, path: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
}
