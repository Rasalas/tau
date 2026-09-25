import { useEffect, useState } from "react";
import { SettingRow, SettingsSection, useSetting, type UiEnvironment } from "tau";
import { MAX_WEIGHT, readWeights, weightOf } from "./choice.js";
import { ENVIRONMENTS_EXTENSION_ID, WEIGHTS_SETTING, type AgentMachines } from "./protocol.js";

function WeightInput({ name, value, onChange }: { name: string; value: number; onChange(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isInteger(next) && next >= 0 && next <= MAX_WEIGHT) { if (next !== value) onChange(next); }
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      className="settings-input narrow"
      aria-label={`Weight of ${name}`}
      min={0}
      max={MAX_WEIGHT}
      step={5}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
    />
  );
}

/**
 * Settings → Machines → Automatic: how strongly each machine is preferred
 * when Tau picks one ("Run on: Automatic", sub-agents on Automatic). Only
 * machines this computer's agents reach can be measured, so only they are listed.
 */
export function MachineWeights({ machines, agents }: { machines: readonly UiEnvironment[]; agents: AgentMachines }) {
  const setting = useSetting<string>(`values.${ENVIRONMENTS_EXTENSION_ID}.${WEIGHTS_SETTING}`, { defaultValue: "", read: (raw) => (typeof raw === "string" ? raw : undefined) });
  const weights = readWeights(setting.value);
  const listed = machines.filter((machine) => machine.local || agents.machines.some((agent) => agent.id === machine.id && !agent.readOnly));
  if (listed.length < 2) return null;
  const set = (id: string, value: number) => setting.set(JSON.stringify({ ...weights, [id]: value }));
  return (
    <SettingsSection title="Automatic">
      <p className="settings-group-note">
        When a new thread runs on Automatic, or a sub-agent does, it goes to the machine with the most room: weight × cores ×
        idle CPU × free memory. A machine is left out while its CPU is at 95 %, its memory is almost full, it runs a turn per
        core, or the thread&apos;s runtime is not ready there. 0 keeps a machine out; this computer starts at 20 so the others get work first.
      </p>
      {listed.map((machine) => {
        const value = weightOf(weights, machine.id, machine.local);
        return (
          <SettingRow
            key={machine.id}
            id={`machine-weight-${machine.id}`}
            title={machine.local ? `${machine.name} (this computer)` : machine.name}
            description={value === 0 ? "Never chosen automatically." : undefined}
            control={<WeightInput name={machine.name} value={value} onChange={(next) => set(machine.id, next)} />}
          />
        );
      })}
    </SettingsSection>
  );
}
