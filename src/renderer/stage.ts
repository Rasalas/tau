/**
 * The stage is the document area beside the conversation. Every tab is a
 * file shown as source or as its working-tree diff. Pure so the preview/pin
 * rules can be tested without React.
 */
export type StageView = "source" | "diff";

export interface StageTab {
  id: string;
  /** Absolute path inside the workspace. */
  path: string;
  view: StageView;
  /** A single-click preview is replaced by the next preview; pinned tabs stay. */
  preview: boolean;
}

export interface StageState {
  tabs: StageTab[];
  activeId?: string;
}

export const EMPTY_STAGE: StageState = { tabs: [] };

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function activeTab(state: StageState): StageTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}

function insertAfterActive(state: StageState, tab: StageTab): StageTab[] {
  const at = state.tabs.findIndex((entry) => entry.id === state.activeId);
  if (at < 0) return [...state.tabs, tab];
  return [...state.tabs.slice(0, at + 1), tab, ...state.tabs.slice(at + 1)];
}

export function openFileTab(state: StageState, path: string, options: { view?: StageView; pin?: boolean } = {}): StageState {
  const id = fileTabId(path);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing) {
    const next: StageTab = { ...existing, view: options.view ?? existing.view, preview: existing.preview && !options.pin };
    return { tabs: state.tabs.map((tab) => tab.id === id ? next : tab), activeId: id };
  }
  const tab: StageTab = { id, path, view: options.view ?? "source", preview: !options.pin };
  const previewIndex = tab.preview ? state.tabs.findIndex((entry) => entry.preview) : -1;
  const tabs = previewIndex >= 0
    ? state.tabs.map((entry, index) => index === previewIndex ? tab : entry)
    : insertAfterActive(state, tab);
  return { tabs, activeId: id };
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
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, view } : tab) };
}
