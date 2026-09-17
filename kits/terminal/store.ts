import { useSyncExternalStore } from "react";
import { HostUnavailableError, type HostExtensionClient } from "tau";
import { createTerminalHostClient, TERMINAL_LIST_EVENT, type UiTerminalSession } from "./protocol.js";

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
}

export class TerminalStore {
  private state: TerminalKitState = { sessions: [] };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TerminalKitState => this.state;

  setSessions(sessions: UiTerminalSession[]): void {
    this.publish({ ...this.state, sessions });
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
