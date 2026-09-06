/**
 * The stage is the document area beside the conversation. A tab is a file,
 * shown as source or as its working-tree diff, or another thread's transcript.
 * Pure so the preview/pin rules can be tested without React.
 */
export type StageView = "source" | "diff";

interface StageTabBase {
  id: string;
  /** A single-click preview is replaced by the next preview; pinned tabs stay. */
  preview: boolean;
}

export interface StageFileTab extends StageTabBase {
  kind: "file";
  /** Absolute path inside the workspace. */
  path: string;
  view: StageView;
}

/** A thread read beside the conversation; the composer keeps addressing the active one. */
export interface StageThreadTab extends StageTabBase {
  kind: "thread";
  sessionId: string;
}

export type StageTab = StageFileTab | StageThreadTab;

export interface StageState {
  tabs: StageTab[];
  activeId?: string;
}

export const EMPTY_STAGE: StageState = { tabs: [] };

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function threadTabId(sessionId: string): string {
  return `thread:${sessionId}`;
}

export function activeTab(state: StageState): StageTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}

/** The path of the tab on screen, when it is a file at all. */
export function stageTabPath(tab: StageTab | undefined): string | undefined {
  return tab?.kind === "file" ? tab.path : undefined;
}

function insertAfterActive(state: StageState, tab: StageTab): StageTab[] {
  const at = state.tabs.findIndex((entry) => entry.id === state.activeId);
  if (at < 0) return [...state.tabs, tab];
  return [...state.tabs.slice(0, at + 1), tab, ...state.tabs.slice(at + 1)];
}

/** The one preview slot is shared by every kind of tab, so it never piles up. */
function openTab(state: StageState, tab: StageTab): StageState {
  const previewIndex = tab.preview ? state.tabs.findIndex((entry) => entry.preview) : -1;
  const tabs = previewIndex >= 0
    ? state.tabs.map((entry, index) => index === previewIndex ? tab : entry)
    : insertAfterActive(state, tab);
  return { tabs, activeId: tab.id };
}

function reopen(state: StageState, existing: StageTab, next: StageTab): StageState {
  return { tabs: state.tabs.map((tab) => tab.id === existing.id ? next : tab), activeId: existing.id };
}

export function openFileTab(state: StageState, path: string, options: { view?: StageView; pin?: boolean } = {}): StageState {
  const id = fileTabId(path);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing?.kind === "file") {
    return reopen(state, existing, { ...existing, view: options.view ?? existing.view, preview: existing.preview && !options.pin });
  }
  return openTab(state, { id, kind: "file", path, view: options.view ?? "source", preview: !options.pin });
}

export function openThreadTab(state: StageState, sessionId: string, options: { pin?: boolean } = {}): StageState {
  const id = threadTabId(sessionId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing?.kind === "thread") {
    return reopen(state, existing, { ...existing, preview: existing.preview && !options.pin });
  }
  return openTab(state, { id, kind: "thread", sessionId, preview: !options.pin });
}

export function activateTab(state: StageState, id: string): StageState {
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id };
}

export function closeTab(state: StageState, id: string): StageState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { tabs, activeId: neighbour?.id };
}

export function pinTab(state: StageState, id: string): StageState {
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id && tab.preview ? { ...tab, preview: false } : tab) };
}

export function setFileView(state: StageState, id: string, view: StageView): StageState {
  if (!state.tabs.some((tab) => tab.id === id && tab.kind === "file")) return state;
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id && tab.kind === "file" ? { ...tab, view } : tab) };
}
