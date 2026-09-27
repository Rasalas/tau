import { useSyncExternalStore } from "react";
import { getClientStorage, HostUnavailableError, type HostExtensionClient, type PreferencesStore, type WorkbenchActions } from "tau";
import {
  createTerminalHostClient, TERMINAL_HOST_EXTENSION_ID, TERMINAL_LIST_EVENT, terminalOutputTopic,
  type TerminalFontDefaults, type TerminalFontService, type TerminalFontServiceState, type UiTerminalSession, type WorkspaceStoreMirror,
} from "./protocol.js";
import { EMPTY_LAYOUT, focusPane, paneIds, parseLayout, reconcileLayout, type TerminalLayout } from "./layout.js";
import type { ComposerContextChips, PreviewBrowserService } from "./protocol.js";
import {
  FONT_FAMILY_SETTING, FONT_SIZE_SETTING, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, resolveTerminalFont, splitFamilyList,
  type ResolvedTerminalFont, type TerminalFontSettings,
} from "./font.js";

let connection: HostExtensionClient | undefined;

export const terminalKit = createTerminalHostClient((command, input) => connection
  ? connection.invoke(command, input)
  : Promise.reject(new HostUnavailableError()));

export function onTerminalEvent(name: string, listener: (payload: unknown) => void): () => void {
  return connection?.onEvent(name, listener) ?? (() => undefined);
}

/** Asks the host for this shell's output until released; a client drawing no shell is sent none. */
export function watchTerminalOutput(id: string): () => void {
  return connection?.watch?.(terminalOutputTopic(id)) ?? (() => undefined);
}

/** Where the panel's layout is kept between reloads; shell ids are the host's, so one key serves every project. */
export const LAYOUT_STORAGE_KEY = "tau.terminal.layout.v1";

/** A pane to put the keyboard in once it is drawn; `seq` makes a repeated request for the same pane new. */
export interface FocusRequest {
  id: string;
  seq: number;
}

/** The host's session list, the thread on screen, and where the panel draws each shell. */
export interface TerminalKitState {
  sessions: readonly UiTerminalSession[];
  activeSessionId?: string;
  layout: TerminalLayout;
  focusRequest?: FocusRequest;
  /** The Terminal panel is on screen: mounted and the dock's active panel. */
  panelVisible: boolean;
}

function readStoredLayout(): TerminalLayout {
  try {
    const raw = getClientStorage()?.get(LAYOUT_STORAGE_KEY);
    return raw ? parseLayout(JSON.parse(raw)) : EMPTY_LAYOUT;
  } catch {
    return EMPTY_LAYOUT;
  }
}

export class TerminalStore {
  private state: TerminalKitState = { sessions: [], layout: EMPTY_LAYOUT, panelVisible: false };
  private readonly listeners = new Set<() => void>();
  /** Opens in flight: a shell they create is placed by them, not given a tab by reconcile. */
  private holds = 0;
  /** Whether `sessions` is the host's answer yet; until then the stored layout is left alone. */
  private known = false;
  private focusSeq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TerminalKitState => this.state;

  /** The layout the last session of this client left, before the host has answered. */
  loadLayout(): void {
    this.publish({ ...this.state, layout: readStoredLayout() });
  }

  setSessions(sessions: UiTerminalSession[]): void {
    this.known = true;
    this.publish({ ...this.state, sessions, layout: this.reconciled(this.state.layout, sessions) });
  }

  /** The host went away: nothing is drawn, and the stored layout waits for the next answer. */
  forgetSessions(): void {
    this.known = false;
    this.publish({ ...this.state, sessions: [] }, false);
  }

  /** Whether `sessions` is the host's answer yet. */
  isKnown(): boolean {
    return this.known;
  }

  /** A shell is being opened; its tab is not placed yet. */
  isOpening(): boolean {
    return this.holds > 0;
  }

  /** Holds reconcile back from giving new shells tabs until the returned release runs. */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.known) this.updateLayout((layout) => layout);
    };
  }

  updateLayout(change: (layout: TerminalLayout) => TerminalLayout): void {
    const layout = change(this.state.layout);
    this.publish({ ...this.state, layout: this.known ? this.reconciled(layout, this.state.sessions) : layout });
  }

  /** Puts the keyboard in a pane once it is drawn. */
  requestFocus(id: string): void {
    this.focusSeq += 1;
    this.publish({ ...this.state, layout: focusPane(this.state.layout, id), focusRequest: { id, seq: this.focusSeq } }, true);
  }

  /** A view took the keyboard for `seq`; the request is spent. */
  focusDone(seq: number): void {
    if (this.state.focusRequest?.seq !== seq) return;
    const { focusRequest: _done, ...rest } = this.state;
    this.publish(rest, false);
  }

  setPanelVisible(panelVisible: boolean): void {
    if (panelVisible === this.state.panelVisible) return;
    this.publish({ ...this.state, panelVisible }, false);
  }

  setActiveSession(activeSessionId: string | undefined): void {
    if (activeSessionId === this.state.activeSessionId) return;
    const { activeSessionId: _previous, ...rest } = this.state;
    this.publish(activeSessionId ? { ...rest, activeSessionId } : rest, false);
  }

  private reconciled(layout: TerminalLayout, sessions: readonly UiTerminalSession[]): TerminalLayout {
    const placed = new Set([...layout.groups, ...layout.stage].flatMap((group) => paneIds(group.root)));
    const held = this.holds > 0 ? new Set(sessions.map((session) => session.id).filter((id) => !placed.has(id))) : new Set<string>();
    return reconcileLayout(layout, sessions.map((session) => session.id), held);
  }

  private publish(next: TerminalKitState, persist = true): void {
    const layoutChanged = next.layout !== this.state.layout;
    this.state = next;
    if (persist && layoutChanged && this.known) {
      try { getClientStorage()?.set(LAYOUT_STORAGE_KEY, JSON.stringify(next.layout)); } catch { /* storage is a convenience */ }
    }
    this.listeners.forEach((listener) => listener());
  }
}

export const terminalStore = new TerminalStore();

export function isTerminalSessionList(value: unknown): value is UiTerminalSession[] {
  return Array.isArray(value) && value.every((entry) => {
    const session = entry as Partial<UiTerminalSession> | null;
    return Boolean(session && typeof session.id === "string" && typeof session.label === "string"
      && typeof session.cols === "number" && typeof session.rows === "number");
  });
}

export function connectTerminalHost(host: HostExtensionClient): () => void {
  connection = host;
  let revision = 0;
  let disposed = false;
  terminalStore.loadLayout();
  const stop = host.onEvent(TERMINAL_LIST_EVENT, (payload) => {
    if (isTerminalSessionList(payload)) {
      revision++;
      terminalStore.setSessions(payload);
    }
  });
  // The list the host already holds, for a client that reconnected; a push
  // that arrived first is newer and wins.
  void terminalKit.list().then((list) => {
    if (!disposed && revision === 0 && isTerminalSessionList(list)) terminalStore.setSessions(list);
  }).catch(() => undefined);
  return () => {
    disposed = true;
    stop();
    if (connection === host) {
      connection = undefined;
      terminalStore.forgetSessions();
    }
  };
}

export function useTerminalKit(): TerminalKitState {
  return useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot, terminalStore.getSnapshot);
}

/**
 * What the views reach beyond the kit: the chip service, the Preview's
 * service and the workbench's actions, as the last panel, tab or command
 * handed them over. Each is absent until something provides it.
 */
export const terminalServices: {
  chips?: ComposerContextChips;
  preview?: PreviewBrowserService;
  workspace?: WorkspaceStoreMirror;
  actions?: WorkbenchActions;
} = {};

export interface TerminalFontState {
  settings: TerminalFontSettings;
  /** What the host read from the user's Ghostty config; absent until it answered. */
  ghostty?: TerminalFontDefaults;
  resolved: ResolvedTerminalFont;
}

/** The font every terminal view draws with: the kit's settings over the user's Ghostty config. */
export class TerminalFontStore {
  private state: TerminalFontState = { settings: {}, resolved: resolveTerminalFont({}) };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TerminalFontState => this.state;

  setSettings(settings: TerminalFontSettings): void {
    if (settings.family === this.state.settings.family && settings.size === this.state.settings.size) return;
    this.publish({ ...this.state, settings });
  }

  setGhostty(ghostty: TerminalFontDefaults | undefined): void {
    const { ghostty: _previous, ...rest } = this.state;
    this.publish(ghostty ? { ...rest, ghostty } : rest);
  }

  private publish(next: Omit<TerminalFontState, "resolved">): void {
    const resolved = resolveTerminalFont(next.settings, next.ghostty);
    const same = resolved.family === this.state.resolved.family && resolved.size === this.state.resolved.size
      && resolved.familySource === this.state.resolved.familySource && resolved.sizeSource === this.state.resolved.sizeSource;
    this.state = { ...next, resolved: same ? this.state.resolved : resolved };
    this.listeners.forEach((listener) => listener());
  }
}

export const terminalFont = new TerminalFontStore();

function fontSettingsOf(preferences: PreferencesStore): TerminalFontSettings {
  const family = preferences.value(TERMINAL_HOST_EXTENSION_ID, FONT_FAMILY_SETTING);
  const size = preferences.value(TERMINAL_HOST_EXTENSION_ID, FONT_SIZE_SETTING);
  return { ...(family ? { family } : {}), ...(size ? { size } : {}) };
}

/** Follows the kit's font settings and asks the host once for the Ghostty config. */
export function connectTerminalFont(preferences: PreferencesStore): () => void {
  terminalFont.setSettings(fontSettingsOf(preferences));
  const stop = preferences.subscribe(() => terminalFont.setSettings(fontSettingsOf(preferences)));
  void refreshGhosttyFont().catch(() => undefined);
  return stop;
}

/** Reads the Ghostty config again; the settings page asks when it opens. */
export async function refreshGhosttyFont(): Promise<void> {
  const defaults = await terminalKit.font();
  if (defaults && Array.isArray(defaults.families)) terminalFont.setGhostty(defaults);
}

export function useTerminalFont(): TerminalFontState {
  return useSyncExternalStore(terminalFont.subscribe, terminalFont.getSnapshot, terminalFont.getSnapshot);
}

function fontServiceState({ settings, ghostty, resolved }: TerminalFontState): TerminalFontServiceState {
  const ghosttyFace = ghostty?.families.flatMap(splitFamilyList)[0];
  return {
    family: settings.family ?? "",
    size: settings.size ?? "",
    resolved: {
      ...(resolved.face ? { face: resolved.face } : {}),
      stack: resolved.family, size: resolved.size, familySource: resolved.familySource, sizeSource: resolved.sizeSource,
    },
    ...(ghostty ? {
      ghostty: {
        ...(ghosttyFace ? { face: ghosttyFace } : {}),
        ...(ghostty.size ? { size: ghostty.size } : {}),
        files: ghostty.files,
        problems: ghostty.problems,
      },
    } : {}),
    sizeRange: { min: MIN_TERMINAL_FONT_SIZE, max: MAX_TERMINAL_FONT_SIZE },
  };
}

/** `tau.terminal/font`: the font store as another kit's settings row reads and writes it. */
export function createTerminalFontService(preferences: PreferencesStore): TerminalFontService {
  let cached: { state: TerminalFontState; snapshot: TerminalFontServiceState } | undefined;
  return {
    getSnapshot: () => {
      const state = terminalFont.getSnapshot();
      if (cached?.state !== state) cached = { state, snapshot: fontServiceState(state) };
      return cached.snapshot;
    },
    subscribe: terminalFont.subscribe,
    set: (change) => {
      if (change.family !== undefined) preferences.setValue(TERMINAL_HOST_EXTENSION_ID, FONT_FAMILY_SETTING, change.family.trim());
      if (change.size !== undefined) preferences.setValue(TERMINAL_HOST_EXTENSION_ID, FONT_SIZE_SETTING, change.size.trim());
    },
    refresh: refreshGhosttyFont,
  };
}
