import { isAgentsState, isBusyStatus, type AgentsState } from "../../shared/agents-kit-protocol";
import type { ThreadLineage } from "../extension-system";

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
