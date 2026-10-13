import type { HostExtensionClient, PlatformEnvironments, UiEnvironment, UiEnvironments } from "tau";
import { shownMachine } from "./machines.js";
import { AGENTS_EVENT, type AgentMachines } from "./protocol.js";

/**
 * The machine whose host serves this page and holds the agents' keys: this
 * machine in its own window, the host a phone shows. Undefined while a
 * window shows another machine.
 */
export function pageMachine(environments: Pick<PlatformEnvironments, "shownElsewhere">, list: UiEnvironments | undefined): UiEnvironment | undefined {
  if (!list || environments.shownElsewhere) return undefined;
  const shown = shownMachine(list);
  return shown && (shown.local || !list.environments.some((machine) => machine.local)) ? shown : undefined;
}

/**
 * The page's list with what its host's agents reach: a machine the page never
 * paired with, and the projects of one it has not read yet (a phone's).
 */
export function withAgentMachines(list: UiEnvironments, agents: AgentMachines | undefined): UiEnvironments {
  if (!agents?.machines.length) return list;
  const byId = new Map(agents.machines.map((agent) => [agent.id, agent]));
  let changed = false;
  const environments = list.environments.map((machine) => {
    const projects = byId.get(machine.id)?.projects;
    if (machine.projects.length || !projects?.length) return machine;
    changed = true;
    return { ...machine, projects };
  });
  const known = new Set([list.shown, ...list.environments.map((machine) => machine.id)]);
  for (const agent of agents.machines) {
    if (known.has(agent.id)) continue;
    changed = true;
    environments.push({
      id: agent.id, name: agent.name, local: false, status: agent.status,
      ...(agent.detail ? { detail: agent.detail } : {}),
      ...(agent.roundTripMs !== undefined ? { roundTripMs: agent.roundTripMs } : {}),
      ...(agent.readOnly ? { readOnly: true } : {}),
      threads: [], threadCount: 0, projects: agent.projects ?? [],
    });
  }
  return changed ? { ...list, environments } : list;
}

/** The machines the page's host reaches with its agents' key, followed while anyone listens. */
export function createAgentMachines(host: HostExtensionClient | undefined) {
  let agents: AgentMachines | undefined;
  let stop: (() => void) | undefined;
  let generation = 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const update = (value: AgentMachines) => { agents = value; listeners.forEach((notify) => notify()); };
  return {
    get: () => agents,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (host && !stop) {
        const current = ++generation;
        const asked = revision;
        stop = host.onEvent(AGENTS_EVENT, (value) => { revision += 1; if (current === generation) update(value as AgentMachines); });
        void host.invoke("agents").then(
          (value) => { if (current === generation && asked === revision) update(value as AgentMachines); },
          () => { if (current === generation && asked === revision) update({ available: false, machines: [] }); },
        );
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { stop?.(); stop = undefined; generation += 1; }
      };
    },
    /** The list as last heard, else asked for now. */
    async read(): Promise<AgentMachines | undefined> {
      if (agents || !host) return agents;
      return await host.invoke("agents").then((value) => value as AgentMachines, () => undefined);
    },
  };
}

export type AgentMachinesStore = ReturnType<typeof createAgentMachines>;
