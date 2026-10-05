import { Bot } from "lucide-react";
import { HostUnavailableError, type DesktopExtension } from "tau";
import { AGENTS_HOST_EXTENSION_ID, AGENTS_STATE_EVENT, REMOTE_AGENT_THREADS_SERVICE, SPAWN_TOOL, THREAD_SIBLINGS_SERVICE, tauToolName, type ThreadSiblingsService } from "./protocol.js";
import { AgentLineage, CompactLineage, type WorkspaceSummaryService } from "./lineage.js";
import { AGENTS_SETTINGS_PAGE, createAgentsSettingsPage } from "./settings.js";
import { SpawnCard } from "./spawn-card.js";
import { AgentsSpine } from "./spine.js";
import { agentsHost, agentsStore, definitionsStore, lineageOf, remoteAgentThreads, siblingsSource } from "./store.js";

/**
 * Agents Kit's desktop half. The spawned threads live in the project card; the navigator only learns which threads are agents,
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

    // A definition that cannot be used is listed in Settings → Inspector, per file.
    const offDefinitions = definitionsStore.subscribe(() => {
      const problems = definitionsStore.getSnapshot().state?.problems ?? [];
      context.setProblems(problems.map(({ file, message, level }) => ({ source: file, message, level })));
    });
    const loadDefinitions = (read: Promise<void>) => {
      read.catch((error: unknown) => {
        if (!(error instanceof HostUnavailableError)) console.warn("Agents Kit could not read the agent definitions", error);
      });
    };
    loadDefinitions(definitionsStore.refresh());
    const offWorkspace = context.events.on("workspace-changed", () => loadDefinitions(definitionsStore.refresh()));
    context.useService<WorkspaceSummaryService>("tau.workspace/store", (workspace) =>
      workspace.registerWorkspaceSummarySection?.(AgentLineage, "footer"));
    context.registerRegion({ id: "agents.lineage-touch", placement: "thread-details", order: 30, profiles: ["compact"], Component: CompactLineage });
    context.registerRegion({ id: "agents.spine", placement: "spine", profiles: ["desktop", "web"], Component: AgentsSpine });
    // A spawn is not a tool call to skim past: the card is the way into the
    // threads it started, so it never folds with the rest of the turn.
    context.registerToolCard({
      id: "agents.spawn",
      match: (tool) => tauToolName(tool.name) === SPAWN_TOOL,
      profiles: ["desktop", "web", "compact"],
      Component: SpawnCard,
    });
    context.registerSettingsPage({
      id: AGENTS_SETTINGS_PAGE,
      label: "Agents",
      description: "Where the sub-agents a thread starts do their work: on this computer or on another machine.",
      group: "threads",
      Icon: Bot,
      order: 45.2,
      profiles: ["desktop", "web"],
      keywords: ["sub-agents", "subagents", "spawn", "machine", "remote machine", "other computer", "automatic"],
      rows: [{ id: "setting-agents-machine", label: "Run sub-agents on", keywords: ["sub-agents", "spawn", "machine", "other computer", "automatic", "this computer"] }],
      Component: createAgentsSettingsPage(context.host),
    });
    // The Machines rail leaves out the threads other machines run for this host's agents.
    context.provideService(REMOTE_AGENT_THREADS_SERVICE, remoteAgentThreads(agentsStore));
    context.useService<ThreadSiblingsService>(THREAD_SIBLINGS_SERVICE, (service) => {
      siblingsSource.set(service);
      return () => siblingsSource.set(undefined);
    });
    context.registerCommand({
      id: "agents.definitions.reload",
      label: "Read agent definitions again",
      group: "Extensions",
      access: "read",
      run: (app) => {
        const active = app.activeThread();
        loadDefinitions(definitionsStore.load(active?.draftPending ? undefined : active?.sessionId));
      },
    });
    return () => {
      offWorkspace();
      offDefinitions();
      definitionsStore.clear();
      context.setThreadLineage(undefined);
      delete agentsHost.invoke;
      agentsStore.clear();
    };
  },
};

export default agentsExtension;
