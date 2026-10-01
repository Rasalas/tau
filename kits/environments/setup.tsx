import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import { Button, errorMessage, loadSignInUi, useWorkbenchShell, type HostExtensionClient, type HostReadiness, type PlatformEnvironments, type RuntimeReadiness, type UiEnvironment, type WorkbenchActions } from "tau";
import { AgentsSwitch, useAgentMachines } from "./agents.js";
import { machineKitClient } from "./machine-kit.js";
import { useEnvironments } from "./rail.js";
import type { MachineImportProps } from "./protocol.js";

const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));
/** Onboarding Kit's tools report (`kits/onboarding/protocol.ts`); kits name contracts without importing each other. */
interface ToolsReport { tools: Array<{ id: string; install: string }> }

export interface SetupRow { kind: string; label: string; here?: RuntimeReadiness; there?: RuntimeReadiness }

export function setupRows(here: HostReadiness | undefined, there: HostReadiness | undefined): SetupRow[] {
  const rows = new Map<string, SetupRow>();
  for (const runtime of here?.runtimes ?? []) rows.set(runtime.kind, { kind: runtime.kind, label: runtime.label, here: runtime });
  for (const runtime of there?.runtimes ?? []) {
    const row = rows.get(runtime.kind);
    if (row) row.there = runtime;
    else rows.set(runtime.kind, { kind: runtime.kind, label: runtime.label, there: runtime });
  }
  return [...rows.values()];
}

export function stateText(readiness: RuntimeReadiness | undefined): string {
  if (!readiness) return "unavailable";
  switch (readiness.state) {
    case "ready": return `ready${readiness.account ? ` (${readiness.account})` : ""}`;
    case "sign-in-required": return "not signed in";
    case "not-installed": return "not installed";
    case "unavailable": return readiness.note ?? "unavailable";
    case "checking": return "checking…";
  }
}

/** The mapping also used by Onboarding Kit (`kits/onboarding/flow.ts`). */
function backendKit(kind: string): { extensionId: string; instance?: string } {
  const at = kind.indexOf("@");
  return at < 0 ? { extensionId: `tau.${kind}` } : { extensionId: `tau.${kind.slice(0, at)}`, instance: kind.slice(at + 1) };
}

function useReadiness(host: HostExtensionClient, machine: string | undefined) {
  const [readiness, setReadiness] = useState<HostReadiness>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setReadiness(undefined);
    setError(undefined);
    if (machine) void host.invoke("readiness", { machine }).then(
      (value) => { if (live) setReadiness(value as HostReadiness); },
      (failure: unknown) => { if (live) setError(errorMessage(failure)); },
    );
    return () => { live = false; };
  }, [host, machine, round]);
  return { readiness, error, reload: () => setRound((value) => value + 1) };
}

function useShellActions(): WorkbenchActions | undefined {
  try { return useWorkbenchShell().actions; }
  catch { return undefined; }
}

function SetupAgent({ row, environments, machine, tools, actions }: {
  row: SetupRow; environments: PlatformEnvironments; machine: UiEnvironment; tools?: ToolsReport; actions?: WorkbenchActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const kit = backendKit(row.kind);
  const client = useMemo(() => machineKitClient(environments, machine.id, kit.extensionId), [environments, machine.id, kit.extensionId]);
  const copyText = (text: string) => actions?.copyText(text) ?? navigator.clipboard.writeText(text);
  const tool = tools?.tools.find((entry) => entry.id === row.kind.split("@")[0]);
  return <>
    <tr>
      <th scope="row">{row.label}</th>
      <td>{stateText(row.here)}</td>
      <td>{stateText(row.there)}</td>
      <td>
        {row.there?.state === "sign-in-required" ? row.kind === "pi"
          ? <small>Set up providers on {machine.name} in Settings → Models there</small>
          : <Button onClick={() => setExpanded(!expanded)}>Sign in on {machine.name}</Button>
          : row.there?.state === "not-installed" && tool ? <><code>{tool.install}</code> <Button onClick={() => void copyText(tool.install)}>Copy</Button></> : null}
      </td>
    </tr>
    {expanded ? <tr><td colSpan={4}><Suspense fallback={<p>Loading sign-in…</p>}>
      <SignIn host={client} {...(kit.instance ? { target: kit.instance } : {})} program={row.label} cardBadge={false}
        openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
        copyText={copyText} />
    </Suspense></td></tr> : null}
  </>;
}

function SetupAgents({ environments, host, machine, local }: { environments: PlatformEnvironments; host: HostExtensionClient; machine: UiEnvironment; local?: string }) {
  const here = useReadiness(host, local);
  const there = useReadiness(host, machine.id);
  const [tools, setTools] = useState<ToolsReport>();
  const actions = useShellActions();
  useEffect(() => {
    let live = true;
    void machineKitClient(environments, machine.id, "tau.onboarding").invoke("tools").then(
      (value) => { if (live) setTools(value as ToolsReport); }, () => undefined,
    );
    return () => { live = false; };
  }, [environments, machine.id]);
  const rows = setupRows(here.readiness, there.readiness);
  return <>
    {here.error || there.error ? <p role="status">{here.error ?? there.error}</p> : null}
    <table className="machine-setup-agents" aria-label={`Agents here and on ${machine.name}`}>
      <thead><tr><th>Agent</th><th>Here</th><th>{machine.name}</th><th>Action</th></tr></thead>
      <tbody>{rows.map((row) => <SetupAgent key={row.kind} row={row} environments={environments} machine={machine} {...(tools ? { tools } : {})} {...(actions ? { actions } : {})} />)}</tbody>
    </table>
    {!here.readiness && !here.error || !there.readiness && !there.error ? <p role="status">Checking agents…</p> : null}
    <small>API keys are entered for {machine.name} in its sign-in, never copied from here.</small>
    <Button variant="ghost" onClick={() => { here.reload(); there.reload(); }}>Check again</Button>
  </>;
}

export function MachineSetup({ environments, host, machine, onDone, ImportConversations }: { environments: PlatformEnvironments; host: HostExtensionClient; machine: UiEnvironment; onDone(): void; ImportConversations?: ComponentType<MachineImportProps> }) {
  const list = useEnvironments(environments);
  const agents = useAgentMachines(host);
  const agent = agents?.machines.find((entry) => entry.id === machine.id);
  const [busy, setBusy] = useState(false);
  const done = () => {
    setBusy(true);
    void machineKitClient(environments, machine.id, "tau.onboarding").invoke("complete").catch(() => undefined).then(onDone).finally(() => setBusy(false));
  };
  return <section className="machine-setup" aria-label={`Set up ${machine.name}`}>
    <div className="machine-setup-head"><strong>Set up {machine.name}</strong><Button busy={busy} onClick={done}>Done</Button></div>
    {agent?.status === "connected" ? <SetupAgents environments={environments} host={host} machine={machine} {...(list?.environments.find((entry) => entry.local)?.id ? { local: list.environments.find((entry) => entry.local)!.id } : {})} /> : <>
      <p>Let this computer's agents work on {machine.name} first; the setup reads the machine over their connection.</p>
      {environments.setAgents ? <AgentsSwitch machine={machine} agent={agent} environments={environments as PlatformEnvironments & Required<Pick<PlatformEnvironments, "setAgents">>} pairing={list?.pairing} /> : null}
    </>}
    {ImportConversations ? <ImportConversations key={machine.id} machine={machine.id} name={machine.name} /> : null}
  </section>;
}
