import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, SettingsSection, SettingRow, compareVersions, errorMessage, hostIsReadOnly, type HostExtensionClient } from "tau";
import { MACHINE_TOOLS_STATE, MACHINE_TOOLS_UPDATE, type MachineTools } from "./protocol.js";

/** The shared manual action is separate from each machine's automatic-update preference. */
export function createMachineToolsSection(host: HostExtensionClient) {
  return function MachineToolsSection() {
    const [machines, setMachines] = useState<MachineTools[]>();
    const [problem, setProblem] = useState<string>();
    const [working, setWorking] = useState<string>();
    const mounted = useRef(true);
    const generation = useRef(0);
    const read = useCallback(() => {
      const request = ++generation.current;
      return host.invoke<MachineTools[]>(MACHINE_TOOLS_STATE).then((next) => {
        if (mounted.current && generation.current === request) { setMachines(next); setProblem(undefined); }
      }, (error: unknown) => { if (mounted.current && generation.current === request) setProblem(errorMessage(error)); });
    }, []);
    useEffect(() => {
      mounted.current = true;
      void read();
      return () => { mounted.current = false; };
    }, [read]);
    const running = machines?.some((machine) => machine.state?.tools.some((tool) => tool.state));
    useEffect(() => {
      const timer = setInterval(() => { if (!working) void read(); }, running ? 2_000 : 30_000);
      return () => clearInterval(timer);
    }, [running, working, read]);
    const change = (machine?: string) => {
      ++generation.current;
      setWorking(machine ?? "all");
      setProblem(undefined);
      void host.invoke<MachineTools[]>(MACHINE_TOOLS_UPDATE, machine ? { machine } : undefined).then((next) => {
        if (mounted.current) setMachines(next);
      }, (error: unknown) => { if (mounted.current) setProblem(errorMessage(error)); })
        .finally(() => { if (mounted.current) setWorking(undefined); });
    };
    const pending = (machine: MachineTools) => machine.state?.tools.filter((tool) => tool.update && tool.installed && tool.latest && compareVersions(tool.installed, tool.latest) < 0) ?? [];
    const available = machines?.filter((machine) => !machine.skipped && !machine.problem && pending(machine).some((tool) => !tool.state)) ?? [];
    const readOnly = hostIsReadOnly();
    return (
      <SettingsSection title="Agent tools across machines" id="setting-machine-agent-tools"
        headerAction={<Button variant="primary" disabled={readOnly || Boolean(working) || available.length === 0} busy={working === "all"} onClick={() => change()}>Update available tools</Button>}>
        <SettingRow title="Update connected machines" description="Uses each machine's installed package manager. Updates wait until its active turns finish. Disconnected, read-only and unsupported machines are skipped." disabledReason={readOnly ? "Read only: this needs a device with Full access." : undefined} />
        {machines?.map((machine) => {
          const active = machine.state?.tools.filter((tool) => tool.state) ?? [];
          const requesting = working === "all" || working === machine.id;
          const reason = machine.skipped ?? machine.problem;
          const updates = pending(machine);
          return <SettingRow key={machine.id} title={<>{machine.name}{machine.local ? " · This machine" : ""} {requesting ? <Badge tone="accent">Requesting…</Badge> : active.length ? <Badge tone="accent">{active.some((tool) => tool.state === "updating") ? "Updating…" : "Waiting for turns"}</Badge> : reason ? <Badge tone={machine.problem ? "danger" : "neutral"}>{machine.problem ? "Failed" : "Skipped"}</Badge> : <Badge tone={updates.length ? "accent" : "success"}>{updates.length ? `${updates.length} available` : machine.state?.tools.some((tool) => tool.update && (!tool.installed || !tool.latest)) ? "Version unavailable" : machine.state?.tools.some((tool) => tool.update) ? "Up to date" : "No managed tools"}</Badge>}</>}
            description={reason ?? updates.map((tool) => `${tool.label} ${tool.installed} → ${tool.latest}`).join(", ")}
            control={!machine.skipped && (updates.length > 0 || machine.problem) ? <Button disabled={readOnly || Boolean(working) || active.length > 0} onClick={() => change(machine.id)}>{machine.problem || machine.state?.log[0]?.outcome === "failed" ? "Retry" : "Update"}</Button> : null}>
            {machine.state?.log.slice(0, 3).map((entry, index) => <p className="settings-group-note" key={`${entry.at}-${index}`}>{entry.label}: {entry.outcome === "ok" ? "Done" : entry.outcome === "failed" ? "Failed" : entry.outcome === "waiting" ? "Waiting" : "Unchanged"}{entry.message ? ` · ${entry.message}` : ""}</p>)}
          </SettingRow>;
        })}
        {problem ? <p className="settings-group-note machine-warning" role="alert">{problem}</p> : null}
      </SettingsSection>
    );
  };
}
