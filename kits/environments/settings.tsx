import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Switch,
  type HostExtensionClient,
  NearbyMachineList,
  SettingRow,
  SettingsSection,
  TextField,
  errorMessage,
  tooltipProps,
  machineBehind,
  type DiscoveredHost,
  type EnvironmentPairInput,
  type EnvironmentPairResult,
  type PlatformEnvironments,
  type UiDiscoveredHosts,
  type UiEnvironment,
  type UiEnvironmentPairing,
  type UiEnvironments,
} from "tau";
import { MachineHealth } from "./health.js";
import { formatDigits, statusText } from "./machines.js";
import { AGENTS_EVENT, type AgentMachine, type AgentMachines } from "./protocol.js";
import { MachineDot, MachineIcon, useEnvironments } from "./rail.js";
import { MachineWeights } from "./weights.js";
import { MachineUpdateLine } from "./update.js";

/** The machines this computer's host holds the agents' key for, as its Machines host half reports them. */
function useAgentMachines(host: HostExtensionClient | undefined): AgentMachines | undefined {
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
function PairingStatus({ pairing, environments }: { pairing: UiEnvironmentPairing; environments: PlatformEnvironments }) {
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
function AgentsSwitch({ machine, agent, environments, pairing }: {
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

function MachineRow({ machine, shown, environments, now, onRemove, agents, pairing, host, behind }: {
  machine: UiEnvironment;
  shown: boolean;
  /** It runs an older Tau than it could (K103). */
  behind: boolean;
  environments: PlatformEnvironments;
  now: number;
  onRemove(): void;
  /** Absent where this page cannot set up agents: another machine shown, or a host that keeps none. */
  agents?: AgentMachines;
  pairing?: UiEnvironmentPairing;
  /** This computer's host, which asks a machine its agents reach how it is doing. */
  host?: HostExtensionClient;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const agent = agents?.machines.find((entry) => entry.id === machine.id);
  // This computer answers its own host; another one only over its agents' connection.
  const health = host && agents && (machine.local || agent?.status === "connected");
  const details = [
    machine.local ? "This computer" : machine.address?.replace(/^wss?:\/\//u, "").replace(/\/$/u, ""),
    statusText(machine, now),
    machine.hostVersion ? `Tau ${machine.hostVersion}` : undefined,
    machine.threadCount ? `${machine.threadCount} thread${machine.threadCount === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  const save = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const next = name.trim();
    setEditing(false);
    if (next && next !== machine.name) void environments.rename(machine.id, next);
  };
  return (
    <div className="connection-row machine-row">
      <MachineDot environment={machine} now={now} />
      <div className="connection-row-text">
        {editing ? (
          <form onSubmit={save}>
            <span onBlur={save}>
              <TextField label={`Name for ${machine.name}`} value={name} width="md" autoFocus onChange={(next) => setName(next.slice(0, 80))} />
            </span>
          </form>
        ) : (
          <strong>
            <MachineIcon environment={machine} />
            {machine.name}
            {shown ? <Badge tone="accent">Shown here</Badge> : null}
            {machine.readOnly ? <Badge>Read only</Badge> : null}
          </strong>
        )}
        <small title={machine.detail}>{details.join(" · ")}</small>
        {agents && !machine.local && environments.setAgents ? (
          <AgentsSwitch machine={machine} agent={agent} environments={environments as PlatformEnvironments & Required<Pick<PlatformEnvironments, "setAgents">>} pairing={pairing} />
        ) : null}
        {health ? <MachineHealth host={host} machine={machine.id} name={machine.name} /> : null}
        <MachineUpdateLine machine={machine} environments={environments} behind={behind} />
      </div>
      {machine.local ? null : (
        <>
          {machine.status === "offline" || machine.status === "refused" ? (
            <Button onClick={() => void environments.retry(machine.id)}>Try again</Button>
          ) : null}
          <Button onClick={() => { setName(machine.name); setEditing(true); }}>Rename</Button>
          <Button variant="danger" onClick={onRemove}>Remove</Button>
        </>
      )}
    </div>
  );
}

type AddState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; message: string; tone: "ok" | "problem" };

function pairOutcome(result: EnvironmentPairResult): AddState {
  switch (result.state) {
    case "added":
      if (result.agents && !result.agents.added) {
        return { kind: "done", tone: "problem", message: `${result.environment.name} was added, but not this computer's agents: ${result.agents.message}` };
      }
      return { kind: "done", tone: "ok", message: `${result.environment.name} was added${result.agents?.added ? ", and this computer's agents may work there" : ""}. Its threads are listed at the foot of the thread rail.` };
    case "denied": return { kind: "done", tone: "problem", message: "The other machine's owner declined." };
    case "expired": return { kind: "done", tone: "problem", message: "Nobody answered on the other machine in time. Try again and allow it there." };
    case "cancelled": return { kind: "idle" };
    case "failed": return { kind: "done", tone: "problem", message: result.message };
  }
}

type Search =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; result: UiDiscoveredHosts }
  | { status: "error"; message: string };

/**
 * Machines that announce themselves on this network (Bonjour), each with
 * "Add". It looks only on a click: looking is what makes macOS ask about
 * local network access.
 */
function NearbyMachines({ environments, list, busy, onAdd }: {
  environments: PlatformEnvironments;
  list: UiEnvironments;
  busy: boolean;
  onAdd(host: DiscoveredHost): void;
}) {
  const [search, setSearch] = useState<Search>({ status: "idle" });
  const look = () => {
    setSearch({ status: "searching" });
    environments.discover().then(
      (result) => setSearch({ status: "done", result }),
      (error: unknown) => setSearch({ status: "error", message: errorMessage(error) }),
    );
  };
  const saved = new Set(list.environments.map((machine) => machine.id));
  const action = (host: DiscoveredHost) => {
    if (host.self) return null;
    if (saved.has(host.hostId)) return <Badge>Added</Badge>;
    return <Button disabled={busy} aria-label={`Add ${host.name}`} onClick={() => onAdd(host)}>Add</Button>;
  };
  return (
    <div className="machine-nearby" aria-busy={search.status === "searching"}>
      <div className="machine-nearby-head">
        <span>On this network</span>
        <Button busy={search.status === "searching"} onClick={look}>
          {search.status === "idle" ? "Find machines" : search.status === "searching" ? "Looking…" : "Search again"}
        </Button>
      </div>
      {search.status === "idle" ? (
        <p className="machine-nearby-note">Finds machines whose owner turned on Local network and Announce. This computer may ask to allow local network access.</p>
      ) : search.status === "error" ? (
        <p className="machine-add-result problem" role="status">Looking failed: {search.message}</p>
      ) : search.status === "done" ? (
        <NearbyMachineList result={search.result} action={action} />
      ) : null}
    </div>
  );
}

const NO_SECURE_STORAGE = "This computer offers Tau no encrypted storage (keychain or secret service), so it cannot keep another machine's key.";

function AddMachine({ environments, secureStorage, offerAgents }: { environments: PlatformEnvironments; secureStorage: boolean; offerAgents: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [withAgents, setWithAgents] = useState(true);
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const list = useEnvironments(environments);
  const pairing = list?.pairing;
  const run = (input: EnvironmentPairInput) => {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    void environments.pair(offerAgents ? { ...input, agents: withAgents } : input).then((result) => {
      if (result.state === "added" && input.text) setText("");
      setState(pairOutcome(result));
    }, (error: unknown) => setState({ kind: "done", tone: "problem", message: errorMessage(error) }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) {
      run({ text });
      return;
    }
    // The button stays pressable with an empty field: a silent, disabled one read as broken.
    setState({ kind: "done", tone: "problem", message: "Paste the pairing link from the other machine, or type its address." });
    field.current?.focus();
  };
  const waiting = state.kind === "busy";
  const busy = waiting || !secureStorage;
  return (
    <form className="machine-add" onSubmit={submit}>
      {list ? <NearbyMachines environments={environments} list={list} busy={busy} onAdd={(host) => run({ nearby: host.hostId })} /> : null}
      <label className="machine-add-field">
        <span>Pairing link or address</span>
        <TextField
          inputRef={field}
          label="Pairing link or address"
          value={text}
          width="full"
          mono
          disabled={busy}
          placeholder="https://studio.local:7788/#pair=… or studio.local:7788"
          onChange={(next) => {
            setText(next);
            if (state.kind === "done" && state.tone === "problem") setState({ kind: "idle" });
          }}
        />
      </label>
      {offerAgents ? (
        <SettingRow
          title="This computer's agents may work there"
          description="The same approval lets in this computer's host as a second device, so its agents can start threads there while no window is open. Either device can be revoked there alone."
          control={(
            <Switch label="This computer's agents may work there" checked={withAgents} disabled={busy} onChange={setWithAgents} />
          )}
        />
      ) : null}
      {pairing && waiting ? <PairingStatus pairing={pairing} environments={environments} /> : null}
      {state.kind === "done" ? <p className={`machine-add-result ${state.tone}`} role="status">{state.message}</p> : null}
      <div className="machine-add-actions">
        <span {...tooltipProps(secureStorage ? undefined : NO_SECURE_STORAGE)}>
          <Button type="submit" variant="primary" disabled={busy}>{waiting ? "Waiting…" : "Add machine"}</Button>
        </span>
      </div>
    </form>
  );
}

/**
 * Settings → Machines: the computers this window shows threads of, and adding
 * one. Adding one asks that machine's owner, who compares a code (ADR 0024).
 */
export function createMachinesPage(environments: PlatformEnvironments, host?: HostExtensionClient) {
  return function MachinesPage() {
    const list = useEnvironments(environments);
    // Agents are this computer's host's: only while the page shows this computer, and on a host that keeps machines.
    const agentMachines = useAgentMachines(environments.shownElsewhere ? undefined : host);
    const agents = agentMachines?.available ? agentMachines : undefined;
    const [now, setNow] = useState(() => Date.now());
    const [removing, setRemoving] = useState<UiEnvironment>();
    useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), 15_000);
      return () => window.clearInterval(timer);
    }, []);
    if (!list) {
      return (
        <div className="settings-page">
          <SettingsSection title="Machines">
            <p className="settings-group-note">This window keeps no list of machines. A desktop window beside its own host does.</p>
          </SettingsSection>
        </div>
      );
    }
    // This computer's Tau is the one to catch up with (K103).
    const reference = list.environments.find((machine) => machine.local)?.hostVersion;
    return (
      <div className="settings-page machines-page">
        <SettingsSection title="Machines">
          {list.environments.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              shown={machine.id === list.shown}
              behind={machineBehind(machine, reference)}
              environments={environments}
              now={now}
              onRemove={() => setRemoving(machine)}
              {...(agents ? { agents } : {})}
              {...(list.pairing ? { pairing: list.pairing } : {})}
              {...(agents && host ? { host } : {})}
            />
          ))}
        </SettingsSection>
        {agents ? <MachineWeights machines={list.environments} agents={agents} /> : null}
        <SettingsSection title="Add a machine">
          <p className="settings-group-note">
            On the other computer, open Settings → Connections, turn on network access and create a pairing link; paste it here,
            or type that computer's address. Its owner allows this computer there after comparing a code. Its threads then show
            beside this computer's, and a new thread can start on it.
          </p>
          {list.secureStorage ? null : (
            <p className="settings-group-note machine-warning">{NO_SECURE_STORAGE}</p>
          )}
          <AddMachine environments={environments} secureStorage={list.secureStorage} offerAgents={agents !== undefined && environments.setAgents !== undefined} />
        </SettingsSection>
        <SettingsSection title="At start">
          <SettingRow
            title="Show the last machine again"
            description="After a restart the window shows the machine it showed last, if it answers within a few seconds; otherwise this computer."
            control={(
              <Switch label="Show the last machine again" checked={list.reopenShown === true} onChange={(next) => void environments.setPreferences({ reopenShown: next })} />
            )}
          />
        </SettingsSection>
        {removing ? (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            message="This computer forgets the machine, its key and its agents' key. Its threads stay on it, and it lists this computer's devices until its owner revokes them; add it again to see them here."
            confirmLabel="Remove"
            destructive
            onConfirm={() => {
              const id = removing.id;
              setRemoving(undefined);
              void environments.remove(id);
            }}
            onCancel={() => setRemoving(undefined)}
          />
        ) : null}
      </div>
    );
  };
}
