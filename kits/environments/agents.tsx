import { useEffect, useState } from "react";
import { Button, Switch, errorMessage, tooltipProps, type HostExtensionClient, type PlatformEnvironments, type UiEnvironment, type UiEnvironmentPairing } from "tau";
import { formatDigits } from "./machines.js";
import { AGENTS_EVENT, type AgentMachine, type AgentMachines } from "./protocol.js";

/** The machines this computer's host holds the agents' key for, as its Machines host half reports them. */
export function useAgentMachines(host: HostExtensionClient | undefined): AgentMachines | undefined {
  const [agents, setAgents] = useState<AgentMachines>();
  useEffect(() => {
    if (!host) return undefined;
    let live = true;
    const stop = host.onEvent(AGENTS_EVENT, (payload) => { if (live) setAgents(payload as AgentMachines); });
    host.invoke("agents").then((value) => { if (live) setAgents(value as AgentMachines); }, () => undefined);
    return () => { live = false; stop(); };
  }, [host]);
  return agents;
}

function agentsText(agent: AgentMachine | undefined, name: string): string {
  if (!agent) return `This computer's agents may not work on ${name}.`;
  const reach = agent.status === "connected" ? `connected${agent.roundTripMs !== undefined ? ` · ${agent.roundTripMs} ms` : ""}`
    : agent.status === "refused" ? `refused: ${agent.detail ?? "their key was revoked there"}`
    : agent.status === "offline" ? `offline${agent.detail ? `: ${agent.detail}` : ""}` : "connecting…";
  return `This computer's agents may work here${agent.readOnly ? " (Read only)" : ""} · ${reach}`;
}

/** The digits to compare while the other owner decides, with the way out. */
export function PairingStatus({ pairing, environments }: { pairing: UiEnvironmentPairing; environments: PlatformEnvironments }) {
  return (
    <div className="machine-pairing" role="status" aria-live="polite">
      {pairing.state === "waiting" && pairing.verification ? (
        <>
          <strong>Allow this computer on the other machine</strong>
          <p>Its window asks now. Allow it only if it shows the same code:</p>
          <code className="machine-pairing-code">{formatDigits(pairing.verification)}</code>
        </>
      ) : (
        <p>Connecting to {pairing.address}…</p>
      )}
      <Button variant="ghost" onClick={() => void environments.cancelPairing()}>Cancel</Button>
    </div>
  );
}

/**
 * The switch that lets this computer's agents work on a machine (ADR 0027).
 * On asks that machine's owner once more, for the agents alone; off forgets
 * their key here.
 */
export function AgentsSwitch({ machine, agent, environments, pairing }: {
  machine: UiEnvironment;
  agent: AgentMachine | undefined;
  environments: PlatformEnvironments & Required<Pick<PlatformEnvironments, "setAgents">>;
  pairing: UiEnvironmentPairing | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const on = agent !== undefined;
  const toggle = () => {
    setBusy(true);
    setProblem(undefined);
    environments.setAgents(machine.id, !on).then((result) => {
      if (result.state === "failed") setProblem(result.message);
      else if (result.state === "denied") setProblem(`${machine.name}'s owner declined.`);
      else if (result.state === "expired") setProblem(`Nobody answered on ${machine.name} in time.`);
    }, (error: unknown) => setProblem(errorMessage(error))).finally(() => setBusy(false));
  };
  return (
    <div className="machine-agents">
      <div className="machine-agents-line">
        <span {...tooltipProps(!on && machine.readOnly ? `${machine.name} paired this computer Read only.` : undefined)}>
          <Switch
            label={`This computer's agents may work on ${machine.name}`}
            checked={on}
            disabled={busy || (!on && (machine.status !== "connected" || machine.readOnly === true))}
            onChange={toggle}
          />
        </span>
        <small title={agent?.detail}>{agentsText(agent, machine.name)}</small>
      </div>
      {busy && pairing ? <PairingStatus pairing={pairing} environments={environments} /> : null}
      {problem ? <p className="machine-add-result problem" role="status">{problem}</p> : null}
    </div>
  );
}

