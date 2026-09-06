import {
  AGENTS_HOST_EXTENSION_ID,
  AGENTS_STATE_EVENT,
  isAgentsState,
  type AgentsState,
} from "../../shared/agents-kit-protocol";
import { HostUnavailableError, type DesktopExtension, type ThreadLineage } from "../extension-system";

/** Marker the navigator puts on a row for a thread an agent started. */
export const AGENT_MARKER = "agent";

export function lineageOf(state: AgentsState): ThreadLineage {
  const parents: Record<string, string> = {};
  const markers: Record<string, string> = {};
  const workingChildren: Record<string, number> = {};
  for (const link of state.links) {
    parents[link.threadId] = link.parentThreadId;
    markers[link.threadId] = AGENT_MARKER;
    if (link.status === "running" || link.status === "waiting") {
      workingChildren[link.parentThreadId] = (workingChildren[link.parentThreadId] ?? 0) + 1;
    }
  }
  return { parents, markers, workingChildren };
}

/**
 * Agents Kit's desktop half. It draws nothing of its own: it publishes the
 * lineage of the threads its host half spawned, and whichever navigator is
 * active nests and counts them (ADR 0012).
 */
export const agentsExtension: DesktopExtension = {
  id: AGENTS_HOST_EXTENSION_ID,
  name: "Agents",
  activate(context) {
    const apply = (payload: unknown) => {
      if (isAgentsState(payload)) context.setThreadLineage(lineageOf(payload));
    };
    context.host.onEvent(AGENTS_STATE_EVENT, apply);
    // A reloaded renderer missed every earlier spawn; ask the host what it has.
    void context.host.invoke("state").then(apply).catch((error: unknown) => {
      if (!(error instanceof HostUnavailableError)) console.warn("Agents Kit could not read the spawned threads", error);
    });
    return () => context.setThreadLineage(undefined);
  },
};
