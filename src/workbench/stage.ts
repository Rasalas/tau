/**
 * The stage is the document area beside the conversation. A tab is a file,
 * shown as source or as its working-tree diff, another thread's transcript,
 * a surface a desktop extension registered a kind for, or a dock panel moved
 * here by maximizing it.
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
  /** The line to bring into view, 1-based; `reveal` counts the requests so the same line can be asked for again. */
  line?: number;
  reveal?: number;
}

/** A thread read beside the conversation; the composer keeps addressing the active one. */
export interface StageThreadTab extends StageTabBase {
  kind: "thread";
  sessionId: string;
  /**
   * The machine the thread runs on, when it is not the one this page shows:
   * the tab reads it over the window's connection there (API 1.15.0).
   */
  machine?: string;
}

/**
 * A tab a desktop extension draws. Core keeps the strip, the placement and the
 * preview rules; the registered kind draws the content and names the title.
 * Every field is plain JSON, so a tab survives being written to storage.
 */
export interface StageExtensionTab extends StageTabBase {
  kind: "extension";
  /** The kind registered with `registerStageTab` that draws this tab. */
  tabKind: string;
  params: Record<string, unknown>;
  title: string;
  /** Unsaved work: the strip marks it and closing asks first. */
  dirty?: boolean;
}

/** A dock or drawer panel shown on the stage instead; closing the tab puts it back. */
export interface StagePanelTab extends StageTabBase {
  kind: "panel";
  panelId: string;
}

export type StageTab = StageFileTab | StageThreadTab | StageExtensionTab | StagePanelTab;

export interface StageState {
  tabs: StageTab[];
  activeId?: string;
}

export const EMPTY_STAGE: StageState = { tabs: [] };

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function threadTabId(sessionId: string, machine?: string): string {
  return machine ? `thread:${machine}:${sessionId}` : `thread:${sessionId}`;
}

export function panelTabId(panelId: string): string {
  return `panel:${panelId}`;
}

export function extensionTabId(tabKind: string, key: string): string {
  return `ext:${tabKind}:${key}`;
}

/**
 * The key of a tab whose opener named none: the same params mean the same tab.
 * Key order never decides identity, and `undefined` members read as absent.
 */
export function stageParamsKey(params: Record<string, unknown>): string {
  return stableJson(params);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => a < b ? -1 : 1);
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`).join(",")}}`;
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

export function openFileTab(state: StageState, path: string, options: { view?: StageView; pin?: boolean; line?: number } = {}): StageState {
  const id = fileTabId(path);
  const existing = state.tabs.find((tab) => tab.id === id);
  const line = options.line !== undefined && Number.isSafeInteger(options.line) && options.line > 0 ? options.line : undefined;
  // A line is always shown as source: a diff has no line of the file to go to.
  const view = line ? "source" : options.view;
  if (existing?.kind === "file") {
    const reveal = line ? { line, reveal: (existing.reveal ?? 0) + 1 } : {};
    return reopen(state, existing, { ...existing, view: view ?? existing.view, preview: existing.preview && !options.pin, ...reveal });
  }
  return openTab(state, { id, kind: "file", path, view: view ?? "source", preview: !options.pin, ...(line ? { line, reveal: 1 } : {}) });
}

export function openThreadTab(state: StageState, sessionId: string, options: { pin?: boolean; machine?: string } = {}): StageState {
  const id = threadTabId(sessionId, options.machine);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing?.kind === "thread") {
    return reopen(state, existing, { ...existing, preview: existing.preview && !options.pin });
  }
  return openTab(state, { id, kind: "thread", sessionId, ...(options.machine ? { machine: options.machine } : {}), preview: !options.pin });
}

/**
 * A tab of a registered kind. An extension tab is opened by a deliberate
 * action, so it is pinned unless its opener asks for the preview slot.
 */
export function openExtensionTab(
  state: StageState,
  tab: { tabKind: string; key: string; params: Record<string, unknown>; title: string },
  options: { preview?: boolean } = {},
): StageState {
  const id = extensionTabId(tab.tabKind, tab.key);
  const preview = options.preview ?? false;
  const existing = state.tabs.find((entry) => entry.id === id);
  if (existing?.kind === "extension") {
    return reopen(state, existing, { ...existing, params: tab.params, title: tab.title, preview: existing.preview && preview });
  }
  return openTab(state, { id, kind: "extension", tabKind: tab.tabKind, params: tab.params, title: tab.title, preview });
}

/** A maximized panel is a deliberate move, so its tab is always pinned. */
export function openPanelTab(state: StageState, panelId: string): StageState {
  const id = panelTabId(panelId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing) return activateTab(state, id);
  return openTab(state, { id, kind: "panel", panelId, preview: false });
}

/** Panel ids that sit on the stage now. */
export function stagedPanelIds(state: StageState): string[] {
  return state.tabs.flatMap((tab) => tab.kind === "panel" ? [tab.panelId] : []);
}

function mapExtensionTab(state: StageState, id: string, change: (tab: StageExtensionTab) => StageExtensionTab): StageState {
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing?.kind !== "extension") return state;
  const next = change(existing);
  if (next === existing) return state;
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id ? next : tab) };
}

/** What the tab is called; the content renames itself through its handle. */
export function setExtensionTabTitle(state: StageState, id: string, title: string): StageState {
  return mapExtensionTab(state, id, (tab) => tab.title === title ? tab : { ...tab, title });
}

export function setExtensionTabDirty(state: StageState, id: string, dirty: boolean): StageState {
  return mapExtensionTab(state, id, (tab) => Boolean(tab.dirty) === dirty ? tab : { ...tab, dirty });
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

/** The one preview slot moves to this tab; every other tab keeps its place, pinned. */
export function unpinTab(state: StageState, id: string): StageState {
  if (!state.tabs.some((tab) => tab.id === id && !tab.preview)) return state;
  return { ...state, tabs: state.tabs.map((tab) => ({ ...tab, preview: tab.id === id })) };
}

/** What the strip's "Close others" would remove, in order; closing them is the caller's. */
export function otherTabIds(state: StageState, id: string): string[] {
  if (!state.tabs.some((tab) => tab.id === id)) return [];
  return state.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);
}

/** What the strip's "Close to the right" would remove, in order. */
export function tabIdsToTheRight(state: StageState, id: string): string[] {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  return index < 0 ? [] : state.tabs.slice(index + 1).map((tab) => tab.id);
}

export function setFileView(state: StageState, id: string, view: StageView): StageState {
  if (!state.tabs.some((tab) => tab.id === id && tab.kind === "file")) return state;
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id && tab.kind === "file" ? { ...tab, view } : tab) };
}

export function cycleTab(state: StageState, direction: 1 | -1): StageState {
  if (state.tabs.length <= 1) return state;
  const currentIndex = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + state.tabs.length) % state.tabs.length;
  return { ...state, activeId: state.tabs[nextIndex]?.id };
}
