import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type FormEvent } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Switch,
  type HostExtensionClient,
  NearbyMachineList,
  Select,
  SettingRow,
  SettingsPageSections,
  SettingsSection,
  SettingsState,
  TextField,
  errorMessage,
  tooltipProps,
  machineBehind,
  type DiscoveredHost,
  type EnvironmentPairInput,
  type EnvironmentPairResult,
  type PlatformEnvironments,
  type SettingsPageProps,
  type UiDiscoveredHosts,
  type UiEnvironment,
  type UiEnvironmentPairing,
  type UiEnvironments,
} from "tau";
import { MachineHealth } from "./health.js";
import { statusText } from "./machines.js";
import { AgentsSwitch, PairingStatus, useAgentMachines } from "./agents.js";
import { MachineSetup } from "./setup.js";
import { MACHINES_SETTINGS_PAGE, type AgentMachines, type MachineImportProps } from "./protocol.js";
import { MachineDot, MachineIcon, useEnvironments } from "./rail.js";
import { MachineWeights } from "./weights.js";
import { MachineUpdateLine } from "./update.js";

function MachineRow({ machine, shown, environments, now, onRemove, onProblem, agents, pairing, host, behind, ImportConversations }: {
  machine: UiEnvironment;
  shown: boolean;
  /** It runs an older Tau than it could (K103). */
  behind: boolean;
  environments: PlatformEnvironments;
  now: number;
  onRemove(): void;
  /** A change to the machine that did not go through, said on the page. */
  onProblem(message: string): void;
  /** Absent where this page cannot set up agents: another machine shown, or a host that keeps none. */
  agents?: AgentMachines;
  pairing?: UiEnvironmentPairing;
  /** This machine's host, which asks a machine its agents reach how it is doing. */
  host?: HostExtensionClient;
  ImportConversations?: ComponentType<MachineImportProps>;
}) {
  const [editing, setEditing] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [name, setName] = useState(machine.name);
  // Enter or Escape closes the field; a blur that follows must not save it again.
  const closed = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const agent = agents?.machines.find((entry) => entry.id === machine.id);
  // This machine answers its own host; another one only over its agents' connection.
  const health = host && agents && (machine.local || agent?.status === "connected");
  const details = [
    // The relay's bridge listens on this device's loopback; its address says nothing to the person.
    machine.local ? "This machine" : machine.via === "connect" ? "Tau Connect" : machine.address?.replace(/^wss?:\/\//u, "").replace(/\/$/u, ""),
    statusText(machine, now),
    machine.hostVersion ? `Tau ${machine.hostVersion}` : undefined,
    machine.threadCount ? `${machine.threadCount} thread${machine.threadCount === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  const save = (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (closed.current) return;
    closed.current = true;
    const next = name.trim();
    setEditing(false);
    if (next && next !== machine.name) {
      environments.rename(machine.id, next).catch((error: unknown) => onProblem(`${machine.name} was not renamed: ${errorMessage(error)}`));
    }
  };
  // Escape puts the name back without saving, and closes nothing else.
  useEffect(() => {
    const input = field.current;
    if (!editing || !input) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closed.current = true;
      setEditing(false);
    };
    input.addEventListener("keydown", onKeyDown);
    return () => input.removeEventListener("keydown", onKeyDown);
  }, [editing]);
  return (
    <div className="connection-row machine-row">
      <MachineDot environment={machine} now={now} />
      <div className="connection-row-text">
        {editing ? (
          <form onSubmit={save}>
            <span onBlur={save}>
              <TextField inputRef={field} label={`Name for ${machine.name}`} value={name} width="md" autoFocus onChange={(next) => setName(next.slice(0, 80))} />
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
        {settingUp && host ? <MachineSetup environments={environments} host={host} machine={machine} ImportConversations={ImportConversations} onDone={() => setSettingUp(false)} /> : null}
      </div>
      {machine.local ? null : (
        <>
          {machine.status === "offline" || machine.status === "refused" ? (
            <Button aria-label={`Try ${machine.name} again`} onClick={() => void environments.retry(machine.id)}>Try again</Button>
          ) : null}
          {host && environments.invokeExtension && !environments.shownElsewhere && machine.status === "connected" ? <Button aria-label={`Set up ${machine.name}`} onClick={() => setSettingUp(!settingUp)}>Set up</Button> : null}
          <Button aria-label={`Rename ${machine.name}`} onClick={() => { closed.current = false; setName(machine.name); setEditing(true); }}>Rename</Button>
          <Button variant="danger" aria-label={`Remove ${machine.name}`} onClick={onRemove}>Remove</Button>
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
        return { kind: "done", tone: "problem", message: `${result.environment.name} was added, but not this machine's agents: ${result.agents.message}` };
      }
      return { kind: "done", tone: "ok", message: `${result.environment.name} was added${result.agents?.added ? ", and this machine's agents may work there" : ""}. Its threads are listed at the foot of the thread rail.` };
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
        <p className="machine-nearby-note">Finds machines whose owner turned on Local network and Announce. This machine may ask to allow local network access.</p>
      ) : search.status === "error" ? (
        <p className="machine-add-result problem" role="status">Looking failed: {search.message}</p>
      ) : search.status === "done" ? (
        <NearbyMachineList result={search.result} action={action} />
      ) : null}
    </div>
  );
}

const CONNECTION_METHODS = [
  { value: "link", label: "Pairing link or address" },
  { value: "ssh", label: "SSH" },
  { value: "wsl", label: "WSL distribution" },
] as const satisfies ReadonlyArray<{ value: string; label: string }>;

const NO_SECURE_STORAGE = "This machine offers Tau no encrypted storage (keychain or secret service), so it cannot keep another machine's key.";

function AddMachine({ environments, secureStorage, offerAgents, host, ImportConversations }: { environments: PlatformEnvironments; secureStorage: boolean; offerAgents: boolean; host?: HostExtensionClient; ImportConversations?: ComponentType<MachineImportProps> }) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [method, setMethod] = useState<"link" | "ssh" | "wsl">("link");
  const [distros, setDistros] = useState<string[]>([]);
  useEffect(() => {
    if (method !== "wsl") return;
    let active = true;
    void environments.listWsl?.().then((names) => { if (active) { setDistros(names); setText(names[0] ?? ""); } }, (error: unknown) => { if (active) setState({ kind: "done", tone: "problem", message: errorMessage(error) }); });
    return () => { active = false; };
  }, [method, environments]);
  const [withAgents, setWithAgents] = useState(true);
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [setupMachine, setSetupMachine] = useState<UiEnvironment>();
  const list = useEnvironments(environments);
  const pairing = list?.pairing;
  const run = (input: EnvironmentPairInput) => {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    setSetupMachine(undefined);
    void environments.pair(offerAgents ? { ...input, agents: withAgents } : input).then((result) => {
      if (result.state === "added" && input.text) setText("");
      if (result.state === "added" && !result.environment.local && environments.invokeExtension && !environments.shownElsewhere) setSetupMachine(result.environment);
      setState(pairOutcome(result));
    }, (error: unknown) => setState({ kind: "done", tone: "problem", message: errorMessage(error) }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) {
      run(method === "ssh" ? { ssh: text.trim() } : method === "wsl" ? { wsl: text } : { text });
      return;
    }
    // The button stays pressable with an empty field: a silent, disabled one read as broken.
    setState({ kind: "done", tone: "problem", message: "Paste the pairing link from the other machine, or type its address." });
    field.current?.focus();
  };
  const waiting = state.kind === "busy";
  const busy = waiting || !secureStorage;
  return (
    <><form className="machine-add" onSubmit={submit}>
      {list ? <NearbyMachines environments={environments} list={list} busy={busy} onAdd={(found) => run({ nearby: found.hostId })} /> : null}
      <div className="machine-add-field">
        <span>Connection method</span>
        <Select label="Connection method" value={method} options={CONNECTION_METHODS} disabled={busy} width="lg" onChange={(next) => { setMethod(next); setText(""); }} />
      </div>
      {method === "wsl" ? <div className="machine-add-field"><span>WSL distribution</span><Select label="WSL distribution" value={text} options={distros.map((distro) => ({ value: distro, label: distro }))} disabled={busy} width="lg" placeholder="Choose a distribution" onChange={setText} /><small>Requires WSL 2 with systemd enabled. Tau installs its signed release inside this distribution.</small></div> : <>
      <label className="machine-add-field">
        <span>{method === "ssh" ? "SSH target" : "Pairing link or address"}</span>
        <TextField
          inputRef={field}
          label={method === "ssh" ? "SSH target" : "Pairing link or address"}
          value={text}
          width="full"
          mono
          disabled={busy}
          placeholder={method === "ssh" ? "studio or user@hostname" : "Pairing link, Tau Connect link or studio.local:7788"}
          onChange={(next) => {
            setText(next);
            if (state.kind === "done" && state.tone === "problem") setState({ kind: "idle" });
          }}
        />
      </label>
      {method === "ssh" ? <p className="machine-nearby-note">Tau downloads and verifies its official release, installs a user service, and reconnects through SSH. Your SSH config, agent and known host keys apply. Set up key authentication in a terminal first.</p> : null}
      </>}
      {offerAgents ? (
        <SettingRow
          title="This machine's agents may work there"
          description="The same approval lets in this machine's agents as a second device, so they can start threads there while no window is open. Either device can be revoked there alone."
          control={(
            <Switch label="This machine's agents may work there" checked={withAgents} disabled={busy} onChange={setWithAgents} />
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
      {setupMachine && host ? <MachineSetup environments={environments} host={host} machine={setupMachine} ImportConversations={ImportConversations} onDone={() => setSetupMachine(undefined)} /> : null}
    </>
  );
}

/**
 * Settings → Machines: the machines this window shows threads of, and adding
 * one. Adding one asks that machine's owner, who compares a code (ADR 0024).
 */
export function createMachinesPage(environments: PlatformEnvironments, host?: HostExtensionClient, ImportConversations?: ComponentType<MachineImportProps>) {
  return function MachinesPage({ cwd, onNotify }: Partial<SettingsPageProps> = {}) {
    const list = useEnvironments(environments);
    const failure = useSyncExternalStore(environments.subscribe, () => environments.loadError?.());
    const [problem, setProblem] = useState<string>();
    // Agents are this machine's host's: only while the page shows this machine, and on a host that keeps machines.
    const agentMachines = useAgentMachines(environments.shownElsewhere ? undefined : host);
    const agents = agentMachines?.available ? agentMachines : undefined;
    const checkedOnboarding = useRef(new Set<string>());
    useEffect(() => {
      if (environments.shownElsewhere || !host || !environments.readExtension || !environments.invokeExtension) return;
      for (const machine of list?.environments ?? []) {
        if (machine.local || machine.status !== "connected" || (!machine.threadCount && machine.threads.length === 0) || checkedOnboarding.current.has(machine.id)) continue;
        checkedOnboarding.current.add(machine.id);
        // Machines paired before setup existed already have work; only their unfinished wizard needs closing.
        void environments.readExtension(machine.id, "tau.onboarding", "state").then((state) => {
          const onboarding = state as { completed?: boolean; firstStart?: boolean } | undefined;
          if (onboarding?.completed === false && onboarding.firstStart === false) {
            return environments.invokeExtension!(machine.id, "tau.onboarding", "complete");
          }
        }).catch(() => undefined);
      }
    }, [list, host]);
    const [now, setNow] = useState(() => Date.now());
    const [removing, setRemoving] = useState<UiEnvironment>();
    useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), 15_000);
      return () => window.clearInterval(timer);
    }, []);
    if (!list) {
      // Without `loadError` the list cannot say why it is missing; it used to mean only that the window keeps none.
      const none = !environments.loadError || failure?.unsupported;
      return (
        <div className="settings-page">
          <SettingsSection title="Machines">
            {none ? (
              <p className="settings-group-note">This window keeps no list of machines. A Tau desktop window on its own machine does.</p>
            ) : failure ? (
              <SettingsState kind="error" title="The machines did not load" description={failure.message} {...(environments.reload ? { onRetry: () => environments.reload!() } : {})} />
            ) : (
              <SettingsState kind="loading" title="Loading machines" />
            )}
          </SettingsSection>
        </div>
      );
    }
    // This machine's Tau is the one to catch up with (K103).
    const reference = list.environments.find((machine) => machine.local)?.hostVersion;
    return (
      <div className="settings-page machines-page">
        <SettingsSection title="Machines">
          {problem ? <p className="machine-add-result problem" role="alert">{problem}</p> : null}
          {list.environments.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              shown={machine.id === list.shown}
              behind={machineBehind(machine, reference)}
              environments={environments}
              now={now}
              ImportConversations={ImportConversations}
              onRemove={() => setRemoving(machine)}
              onProblem={setProblem}
              {...(agents ? { agents } : {})}
              {...(list.pairing ? { pairing: list.pairing } : {})}
              {...(!environments.shownElsewhere && host ? { host } : {})}
            />
          ))}
        </SettingsSection>
        {agents ? <MachineWeights machines={list.environments} agents={agents} /> : null}
        <SettingsSection title="Add a machine">
          <p className="settings-group-note">
            On the other machine, open Settings → Connections, turn on network access and create a pairing link; paste it here,
            or type that machine's address. Its owner allows this machine there after comparing a code. Its threads then show
            beside this machine's, and a new thread can start on it.
          </p>
          {list.secureStorage ? null : (
            <p className="settings-group-note machine-warning">{NO_SECURE_STORAGE}</p>
          )}
          <AddMachine environments={environments} secureStorage={list.secureStorage} offerAgents={agents !== undefined && environments.setAgents !== undefined} ImportConversations={ImportConversations} {...(!environments.shownElsewhere && host ? { host } : {})} />
        </SettingsSection>
        <SettingsSection title="At start">
          <SettingRow
            title="Show the last machine again"
            description="After a restart the window shows the machine it showed last, if it answers within a few seconds; otherwise this machine."
            control={(
              <Switch label="Show the last machine again" checked={list.reopenShown === true} onChange={(next) => void environments.setPreferences({ reopenShown: next })} />
            )}
          />
        </SettingsSection>
        {/* What other extensions attach: Remote work's ignored files and transfers (API 1.61.0). */}
        <SettingsPageSections page={MACHINES_SETTINGS_PAGE} onNotify={onNotify ?? (() => undefined)} {...(cwd ? { cwd } : {})} />
        {removing ? (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            message="This machine forgets the machine, its key and its agents' key. Its threads stay on it, and it lists this machine's devices until its owner revokes them; add it again to see them here."
            confirmLabel="Remove"
            destructive
            onConfirm={() => {
              const { id, name } = removing;
              setRemoving(undefined);
              setProblem(undefined);
              environments.remove(id).catch((error: unknown) => setProblem(`${name} was not removed: ${errorMessage(error)}`));
            }}
            onCancel={() => setRemoving(undefined)}
          />
        ) : null}
      </div>
    );
  };
}
