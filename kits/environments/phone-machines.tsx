import { useState } from "react";
import { Plus } from "lucide-react";
import type { PlatformEnvironments, SettingsPageProps } from "tau";
import { MachineIcon, useEnvironments } from "./rail.js";
import { runOnDetail } from "./run-on.js";

/**
 * Settings → Machines on a phone (design 1t): every machine the phone paired
 * with, its state and projects; a tap shows that one, one out of reach is
 * asked again. Pairing another happens in the app's own host list.
 */
export function createPhoneMachinesPage(environments: PlatformEnvironments) {
  return function PhoneMachines({ onNotify }: SettingsPageProps) {
    const list = useEnvironments(environments);
    const [now] = useState(Date.now);
    const fail = (error: unknown) => onNotify(error instanceof Error ? error.message : String(error));
    if (!list) return null;
    return <div className="settings-page machines-phone">
      <div className="run-on-rows" role="group" aria-label="Machines">
        {list.environments.map((machine) => {
          const projects = machine.projects.map((project) => project.name).join(", ");
          return <button
            key={machine.id}
            type="button"
            className="run-on-row"
            data-status={machine.status}
            aria-current={machine.id === list.shown ? "true" : undefined}
            onClick={() => {
              if (machine.id === list.shown) return;
              if (machine.status === "connected") void environments.open(machine.id).catch(fail);
              else void environments.retry(machine.id).catch(fail);
            }}
          >
            <MachineIcon environment={machine} size={18} />
            <span><strong>{machine.name}</strong><small>{runOnDetail(machine, now)}{projects ? ` · ${projects}` : ""}</small></span>
            <i className={`machine-dot ${machine.status}`} aria-hidden="true" />
          </button>;
        })}
      </div>
      <button type="button" className="machines-pair" onClick={() => { void environments.pair({}).then((result) => { if (result.state === "failed" && result.message) onNotify(result.message); }, fail); }}>
        <Plus size={16} aria-hidden="true" />Pair a machine
      </button>
      <p className="machines-hint">Open Tau on the machine, Settings › Connections, and scan the code it shows.</p>
    </div>;
  };
}

/** "2 online" beside Machines on a phone's Settings list. */
export function onlineCount(environments: PlatformEnvironments): string | undefined {
  const list = environments.getSnapshot();
  return list ? `${list.environments.filter((machine) => machine.status === "connected").length} online` : undefined;
}
