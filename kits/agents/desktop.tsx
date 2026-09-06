import { useSyncExternalStore } from "react";
import { Bot, CornerUpLeft } from "lucide-react";
import { HostUnavailableError, useThreadStore, type DesktopExtension, type RegionProps } from "tau";
import { AGENTS_HOST_EXTENSION_ID, AGENTS_STATE_EVENT } from "./protocol.js";
import { AgentsPanel } from "./panel.js";
import { agentsHost, agentsStore, lineageOf } from "./store.js";

/** The way back from an agent's thread to the thread that started it. */
export function SpawnedBy({ snapshot, actions }: RegionProps) {
  const store = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const link = state?.links.find((entry) => entry.threadId === snapshot?.sessionId);
  // The thread index carries the link too, so the way back survives a run in
  // which nothing told this kit about the spawn.
  const indexed = navigation.threads.find((thread) => thread.id === snapshot?.sessionId)?.parentThreadId;
  const parentThreadId = link?.parentThreadId ?? indexed;
  if (!parentThreadId) return null;
  const parent = navigation.threads.find((thread) => thread.id === parentThreadId);
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
 * so it can keep them out of the rail and count the working ones (ADR 0013).
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
    // The panel's two worktree actions reach the host half through this.
    agentsHost.invoke = (command, input) => context.host.invoke(command, input);
    // A reloaded renderer missed every earlier spawn; ask the host what it has.
    void context.host.invoke("state").then(apply).catch((error: unknown) => {
      if (!(error instanceof HostUnavailableError)) console.warn("Agents Kit could not read the spawned threads", error);
    });
    context.registerPanel({ id: "agents", label: "Agents", Icon: Bot, order: 40, profiles: ["desktop", "web", "compact"], Component: AgentsPanel });
    context.registerRegion({ id: "agents.parent-link", placement: "transcript-header", order: 20, profiles: ["desktop", "web", "compact"], Component: SpawnedBy });
    context.registerCommand({
      id: "agents.open",
      label: "Show spawned agents",
      group: "Extensions",
      run: (app) => app.openPanel("agents"),
    });
    return () => {
      context.setThreadLineage(undefined);
      delete agentsHost.invoke;
      agentsStore.clear();
    };
  },
};

export default agentsExtension;
