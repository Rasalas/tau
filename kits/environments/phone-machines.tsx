import { useMemo, useSyncExternalStore } from "react";
import { Plus } from "lucide-react";
import type { PlatformEnvironments, SettingsPageProps, UiEnvironments } from "tau";
import { withAgentMachines, type AgentMachinesStore } from "./page-machine.js";
import { MachineIcon, useEnvironments } from "./rail.js";
import { runOnDetail } from "./run-on.js";

/** The phone's paired machines and those the host on screen reaches with its agents' key. */
export function usePhoneMachines(environments: PlatformEnvironments, agents: AgentMachinesStore): { list: UiEnvironments; paired: ReadonlySet<string> } | undefined {
  const paired = useEnvironments(environments);
  const agentView = useSyncExternalStore(agents.subscribe, agents.get);
  return useMemo(() => paired && {
    list: withAgentMachines(paired, agentView),
    paired: new Set([paired.shown, ...paired.environments.map((machine) => machine.id)]),
  }, [paired, agentView]);
}

/**
 * Settings → Machines on a phone (design 1t): every machine the phone paired
 * with, its state and projects; a tap shows that one, one out of reach is
 * asked again. A machine only the host on screen reaches is listed, not opened.
 * Pairing another happens in the app's own host list.
 */
export function createPhoneMachinesPage(environments: PlatformEnvironments, agents: AgentMachinesStore) {
  return function PhoneMachines({ onNotify }: SettingsPageProps) {
    const machines = usePhoneMachines(environments, agents);
    const fail = (error: unknown) => onNotify(error instanceof Error ? error.message : String(error), "error");
    if (!machines) return null;
    const { list, paired } = machines;
    const via = list.environments.find((machine) => machine.id === list.shown)?.name;
    return <div className="settings-page machines-phone">
      <div className="run-on-rows" role="group" aria-label="Machines">
        {list.environments.map((machine) => {
          const projects = machine.projects.map((project) => project.name).join(", ");
          const body = <>
            <MachineIcon environment={machine} size={18} />
            <span><strong>{machine.name}</strong><small>{runOnDetail(machine, Date.now())}{paired.has(machine.id) || !via ? "" : ` · through ${via}`}{projects ? ` · ${projects}` : ""}</small></span>
            <i className={`machine-dot ${machine.status}`} aria-hidden="true" />
          </>;
          // The phone holds no key there: new threads reach it through Run on.
          if (!paired.has(machine.id)) return <div key={machine.id} className="run-on-row" role="note" aria-label={machine.name} data-status={machine.status} data-via="">{body}</div>;
          return <button
            key={machine.id}
            type="button"
            className="run-on-row"
            data-status={machine.status}
            aria-current={machine.id === list.shown ? "true" : undefined}
            onClick={() => { if (machine.id !== list.shown) void (machine.status === "connected" ? environments.open(machine.id) : environments.retry(machine.id)).catch(fail); }}
          >{body}</button>;
        })}
      </div>
      {via && list.environments.some((machine) => !paired.has(machine.id)) ? <p className="machines-hint">Machines marked “through {via}” take new threads from Run on. To open one here, pair the phone with it.</p> : null}
      <button type="button" className="machines-pair" onClick={() => { void environments.pair({}).catch(fail); }}>
        <Plus size={16} aria-hidden="true" />Pair a machine
      </button>
      <p className="machines-hint">Open Tau on the machine, Settings › Connections, and scan the code it shows.</p>
    </div>;
  };
}
