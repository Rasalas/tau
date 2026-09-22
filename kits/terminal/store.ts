import { useSyncExternalStore } from "react";
import { HostUnavailableError, type HostExtensionClient, type PreferencesStore } from "tau";
import { createTerminalHostClient, TERMINAL_HOST_EXTENSION_ID, TERMINAL_LIST_EVENT, type TerminalFontDefaults, type UiTerminalSession } from "./protocol.js";
import { FONT_FAMILY_SETTING, FONT_SIZE_SETTING, resolveTerminalFont, type ResolvedTerminalFont, type TerminalFontSettings } from "./font.js";

let connection: HostExtensionClient | undefined;

export const terminalKit = createTerminalHostClient((command, input) => connection
  ? connection.invoke(command, input)
  : Promise.reject(new HostUnavailableError()));

export function onTerminalEvent(name: string, listener: (payload: unknown) => void): () => void {
  return connection?.onEvent(name, listener) ?? (() => undefined);
}

/** The host's session list and the thread on screen, for the panel to group by. */
export interface TerminalKitState {
  sessions: readonly UiTerminalSession[];
  activeSessionId?: string;
  /** Sessions a stage tab is drawing; the panel leaves those to it. */
  onStage: readonly string[];
}

export class TerminalStore {
  private state: TerminalKitState = { sessions: [], onStage: [] };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TerminalKitState => this.state;

  setSessions(sessions: UiTerminalSession[]): void {
    this.publish({ ...this.state, sessions });
  }

  /** A terminal opened as a stage tab, or that tab going away again. */
  setOnStage(id: string, onStage: boolean): void {
    const without = this.state.onStage.filter((entry) => entry !== id);
    if (onStage === this.state.onStage.includes(id)) return;
    this.publish({ ...this.state, onStage: onStage ? [...without, id] : without });
  }

  setActiveSession(activeSessionId: string | undefined): void {
    if (activeSessionId === this.state.activeSessionId) return;
    this.publish({ ...this.state, ...(activeSessionId ? { activeSessionId } : {}) });
  }

  private publish(next: TerminalKitState): void {
    this.state = next;
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
      terminalStore.setSessions([]);
    }
  };
}

export function useTerminalKit(): TerminalKitState {
  return useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot, terminalStore.getSnapshot);
}

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
