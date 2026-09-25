import { useEffect, useState } from "react";
import { SettingRow, SettingsSection, errorMessage, useSetting, type HostExtensionClient, type SettingsPageProps } from "tau";
import {
  AGENTS_HOST_EXTENSION_ID,
  AUTO_MACHINE,
  LOCAL_MACHINE,
  MACHINE_SETTING,
  isAgentMachinesView,
  type AgentMachineOption,
  type AgentMachinesView,
} from "./protocol.js";

export const AGENTS_SETTINGS_PAGE = "agents.settings";

/** The value a choice writes: a machine's host id, `local` or `auto`. */
export function readMachineChoice(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** What the row says about the current choice. */
export function machineChoiceText(value: string, machines: readonly AgentMachineOption[]): string {
  if (value === LOCAL_MACHINE) return "Sub-agents run on this computer, in worktrees of their own.";
  if (value === AUTO_MACHINE) return "Tau picks the machine with the most room when each sub-agent starts; this computer until Machines can choose.";
  const machine = machines.find((entry) => entry.id === value || entry.name === value);
  if (!machine) return `Sub-agents go to a machine this computer's agents no longer reach; spawns fail until you choose again.`;
  const budget = machine.budget ? `${machine.budget} at a time (its cores)` : "as many at a time as it has cores";
  const status = machine.status === "connected" ? "" : ` ${machine.name} is ${machine.status} now, so spawns fail until it is back.`;
  return `Sub-agents run on ${machine.name}, ${budget}; the rest wait. Their work comes back here as a branch.${status}`;
}

/**
 * Settings → Agents: where a spawn that names no machine runs. It writes
 * `values.tau.agents.machine`; the host half reads it per spawn.
 */
export function createAgentsSettingsPage(host: HostExtensionClient) {
  return function AgentsSettingsPage(_props: SettingsPageProps) {
    const [view, setView] = useState<AgentMachinesView>();
    const [error, setError] = useState<string>();
    const setting = useSetting<string>(`values.${AGENTS_HOST_EXTENSION_ID}.${MACHINE_SETTING}`, {
      defaultValue: LOCAL_MACHINE,
      read: readMachineChoice,
      format: (value) => (value === LOCAL_MACHINE ? "This computer" : value === AUTO_MACHINE ? "Automatic" : view?.machines.find((machine) => machine.id === value)?.name ?? value),
    });
    useEffect(() => {
      let live = true;
      host.invoke("machines").then((answer) => { if (live && isAgentMachinesView(answer)) setView(answer); }, (reason: unknown) => { if (live) setError(errorMessage(reason)); });
      return () => { live = false; };
    }, []);
    const machines = view?.machines.filter((machine) => !machine.readOnly) ?? [];
    const choices = [
      { value: LOCAL_MACHINE, label: "This computer" },
      ...machines.map((machine) => ({ value: machine.id, label: machine.name })),
      // A choice that points at a machine no longer listed stays visible, so it can be changed.
      ...(setting.value !== LOCAL_MACHINE && setting.value !== AUTO_MACHINE && !machines.some((machine) => machine.id === setting.value) ? [{ value: setting.value, label: setting.value }] : []),
      { value: AUTO_MACHINE, label: "Automatic" },
    ];
    const none = view && !view.available ? "This host keeps no other machines for its agents." : view && machines.length === 0 ? "Pair a machine in Settings → Machines and let this computer's agents in to run sub-agents there." : undefined;
    return (
      <div className="settings-page agents-settings">
        <h3>Agents</h3>
        <SettingsSection title="Sub-agents">
          <SettingRow
            id="setting-agents-machine"
            title="Run sub-agents on"
            description={[machineChoiceText(setting.value, view?.machines ?? []), none ?? error].filter(Boolean).join(" ")}
            setting={setting}
            control={<div className="segmented" role="group" aria-label="Run sub-agents on">
              {choices.map((choice) => (
                <button key={choice.value} type="button" className={choice.value === setting.value ? "active" : ""} aria-pressed={choice.value === setting.value} onClick={() => setting.set(choice.value)}>{choice.label}</button>
              ))}
            </div>}
          />
        </SettingsSection>
      </div>
    );
  };
}
