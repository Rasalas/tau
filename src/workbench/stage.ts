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

/** Internal persisted resource authority. Workspace ids are opaque and host-owned. */
export interface WorkspaceResourceOrigin {
  readonly sessionId: string;
  readonly workspace: string;
  readonly sourceId: string;
}

export interface StageFileTab extends StageTabBase {
  /** Absent on legacy/local tabs; null means an explicit origin could not be determined. */
  resourceOrigin?: WorkspaceResourceOrigin | null;
  kind: "file";
  /** Absolute path inside the workspace. */
  path: string;
  view: StageView;
  /** The line to bring into view, 1-based; `reveal` counts the requests so the same line can be asked for again. */
  line?: number;
  reveal?: number;
  /** Opened by the agent, not the user (design 1a): it waits behind the tab in front until pinned. */
  trace?: boolean;
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
  /** The tab shown beside the active one while the stage is split. */
  splitId?: string | undefined;
  /** Tabs the user closed here, newest first; kept with the tabs, so each thread has its own. */
  closed?: ClosedStageTab[];
}

/**
 * A closed tab as "Reopen closed tab" brings it back: plain JSON, pinned, and
 * for an extension tab only what its kind's `reopenParams` kept.
 */
export interface ClosedStageTab {
  tab: StageTab;
  closedAt: number;
}

export const MAX_CLOSED_TABS = 20;

export const EMPTY_STAGE: StageState = { tabs: [] };

/**
 * The path a file tab is kept under: relative to its project where it lies
 * inside it. A link in a reply, the tree and a kit's list may name the same
 * file relatively or absolutely; both are one tab, and a relative one always
 * reads in the project of the stage it is on.
 */
export function stageFilePath(path: string, cwd: string | undefined): string {
  const bare = path.replace(/^\.\//u, "");
  if (!cwd) return bare;
  const root = cwd.replace(/[\\/]+$/u, "");
  return bare.startsWith(`${root}/`) ? bare.slice(root.length + 1) : bare;
}

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
  return { ...withClosed(state), tabs, activeId: tab.id };
}

/** The history rides along with every new shape of the stage. */
function withClosed(state: StageState): Pick<StageState, "closed"> {
  return state.closed?.length ? { closed: state.closed } : {};
}

function reopen(state: StageState, existing: StageTab, next: StageTab): StageState {
  return { ...activateTab(state, existing.id), tabs: state.tabs.map((tab) => tab.id === existing.id ? next : tab) };
}

export function openFileTab(state: StageState, path: string, options: { view?: StageView; pin?: boolean; line?: number; trace?: boolean; resourceOrigin?: WorkspaceResourceOrigin | null; localWorkspace?: string } = {}): StageState {
  const id = options.resourceOrigin && options.resourceOrigin.workspace === options.localWorkspace ? fileTabId(path) : options.resourceOrigin ? `${fileTabId(path)}:${JSON.stringify([options.resourceOrigin.sourceId, options.resourceOrigin.workspace])}` : options.resourceOrigin === null ? `${fileTabId(path)}:unavailable` : fileTabId(path);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (options.trace) {
    // One trace tab, after the others; never on an empty stage, never in front.
    if (existing || state.tabs.length === 0) return state;
    const tab: StageFileTab = { id, kind: "file", path, view: "source", preview: true, trace: true };
    const at = state.tabs.findIndex((entry) => entry.kind === "file" && entry.trace && entry.id !== state.activeId && entry.id !== state.splitId);
    return { ...state, tabs: at >= 0 ? state.tabs.map((entry, index) => index === at ? tab : entry) : [...state.tabs, tab] };
  }
  const line = options.line !== undefined && Number.isSafeInteger(options.line) && options.line > 0 ? options.line : undefined;
  // A line is always shown as source: a diff has no line of the file to go to.
  const view = line ? "source" : options.view;
  if (existing?.kind === "file") {
    const reveal = line ? { line, reveal: (existing.reveal ?? 0) + 1 } : {};
    return reopen(state, existing, { ...existing, view: view ?? existing.view, preview: existing.preview && !options.pin, ...(options.resourceOrigin !== undefined ? { resourceOrigin: options.resourceOrigin } : {}), ...reveal });
  }
  return openTab(state, { id, kind: "file", path, view: view ?? "source", preview: !options.pin, ...(options.resourceOrigin !== undefined ? { resourceOrigin: options.resourceOrigin } : {}), ...(line ? { line, reveal: 1 } : {}) });
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

/** A panel that was on screen before the tab in front: it joins at the strip's start, behind the active tab. */
export function addPanelTabBehind(state: StageState, panelId: string): StageState {
  const id = panelTabId(panelId);
  if (state.tabs.some((tab) => tab.id === id)) return state;
  return { ...withClosed(state), tabs: [{ id, kind: "panel", panelId, preview: false }, ...state.tabs], activeId: state.activeId ?? id };
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

/** The split tab is already on screen, so activating it changes nothing. */
export function activateTab(state: StageState, id: string): StageState {
  if (state.activeId === id || state.splitId === id || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id };
}

/** The tab beside the active one, when the stage is split. */
export function splitTab(state: StageState): StageTab | undefined {
  return state.splitId === state.activeId ? undefined : state.tabs.find((tab) => tab.id === state.splitId);
}

/**
 * Shows `id` beside the active tab, pinned; the active tab itself moves there
 * and its neighbour takes its place. Without `id` the stage is one pane again.
 */
export function splitStage(state: StageState, id?: string): StageState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || state.tabs.length < 2) return { ...state, splitId: undefined };
  const activeId = id === state.activeId ? (state.tabs[index - 1] ?? state.tabs[index + 1])!.id : state.activeId;
  return { ...withClosed(state), tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, preview: false } : tab), activeId, splitId: id };
}

export function closeTab(state: StageState, id: string): StageState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId !== id ? state.activeId : (tabs[index] ?? tabs[index - 1])?.id;
  // Without the split tab, or with it in front, the stage is one pane again.
  const { splitId } = state;
  return { ...withClosed(state), tabs, activeId, splitId: splitId !== id && splitId !== activeId ? splitId : undefined };
}

/** Remembers a tab the user closed, newest first; one entry per tab, at most twenty. */
export function rememberClosedTab(state: StageState, tab: StageTab, closedAt: number): StageState {
  const closed = [{ tab, closedAt }, ...(state.closed ?? []).filter((entry) => entry.tab.id !== tab.id)].slice(0, MAX_CLOSED_TABS);
  return { ...state, closed };
}

export function forgetClosedTab(state: StageState, id: string): StageState {
  if (!state.closed?.some((entry) => entry.tab.id === id)) return state;
  const closed = state.closed.filter((entry) => entry.tab.id !== id);
  const { closed: _closed, ...rest } = state;
  return closed.length > 0 ? { ...rest, closed } : rest;
}

/** What "Recently closed" lists: the newest first, without a tab that is open again. */
export function recentlyClosed(state: StageState): ClosedStageTab[] {
  return (state.closed ?? []).filter((entry) => !state.tabs.some((tab) => tab.id === entry.tab.id));
}

/**
 * Puts a closed file or thread tab back, pinned, after the active one; an
 * open one is only brought forward. Its entry leaves the history.
 */
export function reopenClosedTab(state: StageState, tab: StageTab): StageState {
  const rest = forgetClosedTab(state, tab.id);
  if (rest.tabs.some((entry) => entry.id === tab.id)) return activateTab(rest, tab.id);
  return openTab(rest, { ...tab, preview: false });
}

export function pinTab(state: StageState, id: string): StageState {
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id && tab.preview ? { ...tab, preview: false, ...(tab.kind === "file" ? { trace: false } : {}) } : tab) };
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

/** Walks the active pane's tabs; the split tab stays where it is. */
export function cycleTab(state: StageState, direction: 1 | -1): StageState {
  const tabs = state.tabs.filter((tab) => tab.id !== state.splitId);
  if (tabs.length <= 1) return state;
  const currentIndex = tabs.findIndex((tab) => tab.id === state.activeId);
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + tabs.length) % tabs.length;
  return { ...state, activeId: tabs[nextIndex]?.id };
}
