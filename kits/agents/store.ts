import type { ThreadLineage } from "tau";
import {
  isAgentDefinitionsState,
  isAgentsState,
  isBusyStatus,
  type AgentDefinitionsState,
  type AgentsState,
} from "./protocol.js";

/**
 * What the host half pushed about spawned threads, held once for the panel and
 * the navigator. The host is the only writer; nothing here polls a thread.
 */
export interface AgentsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AgentsState | undefined;
  set(state: unknown): void;
  clear(): void;
}

export function createAgentsStore(): AgentsStore {
  const listeners = new Set<() => void>();
  let state: AgentsState | undefined;
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    set: (value) => {
      if (!isAgentsState(value)) return;
      state = value;
      for (const listener of [...listeners]) listener();
    },
    clear: () => {
      state = undefined;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The store the bundled kit and its panel share; a package would own its own. */
export const agentsStore = createAgentsStore();

/**
 * How the panel reaches the kit's host half. A panel contribution is given the
 * workbench's actions, not its own extension's channel, so the desktop entry
 * lends it this one while the kit is active.
 */
export const agentsHost: { invoke?(command: string, input?: unknown): Promise<unknown> } = {};

export function lineageOf(state: AgentsState | undefined): ThreadLineage {
  const parents: Record<string, string> = {};
  const workingChildren: Record<string, number> = {};
  for (const link of state?.links ?? []) {
    if (link.threadId) parents[link.threadId] = link.parentThreadId;
    if (isBusyStatus(link.status)) {
      workingChildren[link.parentThreadId] = (workingChildren[link.parentThreadId] ?? 0) + 1;
    }
  }
  return { parents, workingChildren };
}

/** The agent definitions of the checkout on screen, as the host last read them. */
export interface DefinitionsView {
  /** The thread they were read for; absent for the open workspace. */
  sessionId?: string;
  state?: AgentDefinitionsState;
}

export interface DefinitionsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DefinitionsView;
  /**
   * Reads the definitions of a thread's checkout, or of the open workspace,
   * and keeps following that thread. Only the latest request lands, so
   * switching threads quickly never shows the one before.
   */
  load(sessionId?: string): Promise<void>;
  /** Reads again for the thread last asked about. */
  refresh(): Promise<void>;
  clear(): void;
}

export function createDefinitionsStore(host: { invoke?(command: string, input?: unknown): Promise<unknown> }): DefinitionsStore {
  const listeners = new Set<() => void>();
  let view: DefinitionsView = {};
  let focus: string | undefined;
  let latest = 0;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const load = async (sessionId?: string) => {
    focus = sessionId;
    if (!host.invoke) return;
    const request = ++latest;
    const state = await host.invoke("definitions", sessionId ? { sessionId } : {});
    if (request !== latest || !isAgentDefinitionsState(state)) return;
    view = { ...(sessionId ? { sessionId } : {}), state };
    notify();
  };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    load,
    refresh: () => load(focus),
    clear: () => {
      latest += 1;
      focus = undefined;
      view = {};
      notify();
    },
  };
}

export const definitionsStore = createDefinitionsStore(agentsHost);
