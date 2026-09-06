import { lazy, useSyncExternalStore } from "react";
import { CornerUpLeft } from "lucide-react";
import {
  AGENTS_HOST_EXTENSION_ID,
  AGENTS_STATE_EVENT,
} from "../../shared/agents-kit-protocol";
import { HostUnavailableError, type DesktopExtension, type RegionProps } from "../extension-system";
import { useThreadStore } from "../workbench-context";
import { agentsStore, lineageOf } from "./agents-store";

const LazyAgentsPanel = lazy(() => import("./agents-panel").then(({ AgentsPanel }) => ({ default: AgentsPanel })));

/** The way back from an agent's thread to the thread that started it. */
export function SpawnedBy({ snapshot, actions }: RegionProps) {
  const store = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const link = state?.links.find((entry) => entry.threadId === snapshot?.sessionId);
  if (!link) return null;
  const parent = navigation.threads.find((thread) => thread.id === link.parentThreadId);
  return (
    <button
      type="button"
      className="agent-parent-link"
      disabled={!parent}
      onClick={() => { if (parent) void actions.switchSession(parent.path); }}
    >
      <CornerUpLeft size={12} aria-hidden="true" />
      spawned by {parent?.title ?? "another thread"}
    </button>
  );
}

/**
 * Agents Kit's desktop half. The spawned threads live in their own dock panel
 * beside the conversation; the navigator only learns which threads are agents,
 * so it can keep them out of the rail and count the working ones (ADR 0012).
 */
export const agentsExtension: DesktopExtension = {
  id: AGENTS_HOST_EXTENSION_ID,
  name: "Agents",
  activate(context) {
    const apply = (payload: unknown) => {
      agentsStore.set(payload);
      context.setThreadLineage(lineageOf(agentsStore.getSnapshot()));
    };
    context.host.onEvent(AGENTS_STATE_EVENT, apply);
    // A reloaded renderer missed every earlier spawn; ask the host what it has.
    void context.host.invoke("state").then(apply).catch((error: unknown) => {
      if (!(error instanceof HostUnavailableError)) console.warn("Agents Kit could not read the spawned threads", error);
    });
    context.registerPanel({ id: "agents", label: "Agents", glyph: "agents", order: 40, Component: LazyAgentsPanel });
    context.registerRegion({ id: "agents.parent-link", placement: "transcript-header", order: 20, Component: SpawnedBy });
    context.registerCommand({
      id: "agents.open",
      label: "Show spawned agents",
      group: "Extensions",
      run: (app) => app.openPanel("agents"),
    });
    return () => {
      context.setThreadLineage(undefined);
      agentsStore.clear();
    };
  },
};
