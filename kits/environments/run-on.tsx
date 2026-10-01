import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Check, Scale } from "lucide-react";
import { SegmentedControl, SettingRow, useSetting, useThreadStore, type HostExtensionClient, type PlatformEnvironments, type UiEnvironment } from "tau";
import { autoApplies, autoRunOn, chooseInput, threadTargets, useAutoPreview, useAutoRunOn } from "./auto.js";
import { matchProject, useProjectMatches, type BringChoiceStore, type ProjectIdentities } from "./bring-project.js";
import { cannotStartReason, shownMachine, statusText } from "./machines.js";
import { MachineIcon, useEnvironments } from "./rail.js";
import { AGENTS_EVENT, ENVIRONMENTS_EXTENSION_ID, RUN_ON_DEFAULT_KEY, type AgentMachines, type DraftMachineProps, type DraftMachineSource, type RunOnDefault } from "./protocol.js";

const AUTO = "auto";
const NO_IDENTITIES: ProjectIdentities = {
  subscribe: () => () => undefined,
  getVersion: () => 0,
  ask: () => undefined,
  movable: () => false,
  match: (machine, projectPath) => matchProject(machine, projectPath, undefined, undefined),
};

/** A machine's line under its name in "Run on" (design 1k): this one or online, and how busy. `running` overrides its list's count. */
export function runOnDetail(machine: UiEnvironment, now: number, running = machine.threads.filter((thread) => thread.running).length): string {
  const load = running > 0 ? `${running} running` : "idle";
  if (machine.local) return `this machine · ${load}`;
  return machine.status === "connected" ? `online · ${load}` : statusText(machine, now);
}

/** The chip's tooltip while Automatic is chosen: what it does, and where it would go now. */
export function autoTooltip(preview: { answer?: { machine: string | null; reason: string }; error?: string }, names: ReadonlyMap<string, string>, targets: number): string {
  const head = "Automatic: when you send, the thread starts on the machine with the most room (Settings → Machines weighs them).";
  if (targets === 0) return `${head}\nNo other machine has this project and lets this computer's agents in, so it starts here.`;
  if (preview.error) return `${head}\nCould not ask: ${preview.error}`;
  if (!preview.answer) return `${head}\nChecking the machines…`;
  const where = preview.answer.machine ? names.get(preview.answer.machine) ?? preview.answer.machine : "this computer";
  return `${head}\nNow: ${where}. ${preview.answer.reason}`;
}

/** How "Run on" brings a project to a machine without a checkout of it (`bring-project.ts`). */
export interface RunOnBringing {
  identities: ProjectIdentities;
  choice: BringChoiceStore;
}

const noChoice = () => () => undefined;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? path;
}

/**
 * "Run on" for a new thread: which machine it starts on, as Workspace Kit's
 * pill and popover draw it (design 1k/1o). A machine with a checkout of the
 * project starts the draft there when sent, through this host's agents key.
 * A machine without a checkout takes the project along. Without an agents
 * connection, picking the machine still opens this window there.
 * A started thread stays where it runs.
 * "Automatic" leaves the choice to the moment the prompt is sent.
 */
export function createRunOnSource(environments: PlatformEnvironments, host?: HostExtensionClient, bringing?: RunOnBringing, runOnDefault: () => RunOnDefault | undefined = () => undefined) {
  let agents: AgentMachines | undefined;
  let stopAgents: (() => void) | undefined;
  let generation = 0;
  let agentRevision = 0;
  const agentListeners = new Set<() => void>();
  const subscribeAgents = (listener: () => void) => {
    agentListeners.add(listener);
    if (host && !stopAgents) {
      const current = ++generation;
      const update = (value: unknown) => {
        if (current !== generation) return;
        agents = value as AgentMachines;
        agentListeners.forEach((notify) => notify());
      };
      const revision = agentRevision;
      stopAgents = host.onEvent(AGENTS_EVENT, (value) => { agentRevision += 1; update(value); });
      void host.invoke("agents").then((value) => { if (revision === agentRevision) update(value); }, () => {
        if (revision === agentRevision) update({ available: false, machines: [] });
      });
    }
    return () => {
      agentListeners.delete(listener);
      if (agentListeners.size === 0) { stopAgents?.(); stopAgents = undefined; generation += 1; }
    };
  };
  // The draft is on its way to another machine; the pill and the rows wait.
  const moving = {
    value: false,
    listeners: new Set<() => void>(),
    set(value: boolean) { moving.value = value; moving.listeners.forEach((listener) => listener()); },
    subscribe(listener: () => void) { moving.listeners.add(listener); return () => { moving.listeners.delete(listener); }; },
  };
  // A phone's list of its hosts holds no threads of the one on screen; its own thread list does.
  const useRunningHere = (): number | undefined => {
    const store = useThreadStore();
    const running = useSyncExternalStore(store.subscribeToActivity, () => store.getActivity().runningThreadIds.length);
    return environments.getSnapshot()?.environments.find((machine) => machine.id === environments.getSnapshot()?.shown)?.local ? undefined : running;
  };
  const useRunOn = ({ actions, snapshot }: DraftMachineProps) => {
    const threads = useThreadStore();
    useEffect(() => { bringing?.choice.bindThreads(threads); }, [threads]);
    const agentView = useSyncExternalStore(subscribeAgents, () => agents);
    const list = useEnvironments(environments);
    const auto = useAutoRunOn();
    const busy = useSyncExternalStore(moving.subscribe, () => moving.value);
    const runningHere = useRunningHere();
    const current = list ? shownMachine(list) : undefined;
    const active = actions?.activeThread();
    // A draft, or a thread nothing was sent in yet, may still move; a started one stays where it runs.
    const unstarted = (active?.draftPending ?? false) || (snapshot !== undefined && snapshot.messages.length === 0 && !snapshot.isStreaming);
    const offerAuto = host !== undefined && autoApplies(environments, list);
    // The choice is made when a draft's first prompt creates its thread; a thread that exists stays here.
    const isDraft = active?.draftPending ?? false;
    const automatic = auto && offerAuto && isDraft;
    const match = useProjectMatches(bringing?.identities ?? NO_IDENTITIES, list, active?.cwd);
    const targets = list && offerAuto ? threadTargets(list, active?.cwd, match) : new Map<string, string | undefined>();
    const preview = useAutoPreview(host, automatic && targets.size > 0 ? chooseInput(targets, active?.cwd, active?.backendKind, active?.model) : undefined);
    const chosen = useSyncExternalStore(bringing?.choice.subscribe ?? noChoice, () => bringing?.choice.get());
    if (!list || !current || !actions || !unstarted) return undefined;
    // Only this computer's own page starts work elsewhere with its project; its host holds the agents' keys there.
    const canRunThere = bringing !== undefined && isDraft && current.local && !environments.shownElsewhere;
    const canBring = canRunThere && bringing.identities.movable(active?.cwd);
    const hasAgents = (machine: UiEnvironment) => agentView?.machines?.some((entry) => entry.id === machine.id && entry.status === "connected" && !entry.readOnly) ?? false;
    const checkingAgents = canRunThere && host !== undefined && agentView === undefined;
    const bringTo = canRunThere && chosen && chosen.projectPath === active?.cwd && !automatic ? list.environments.find((machine) => machine.id === chosen.machine) : undefined;
    const names = new Map(list.environments.map((machine) => [machine.id, machine.name]));
    const project = active?.cwd ? folderName(active.cwd) : "this project";
    const tooltip = automatic ? autoTooltip(preview, names, targets.size)
      : bringTo ? chosen?.workspaceId ? `Run on ${bringTo.name}: starts there when you send; this window stays here` : `Run on ${bringTo.name}: ${project} is not there yet, so Tau takes it along (its commits and uncommitted work) when you send`
        : `Run on ${current.name}: the machine this thread starts on`;
    return { list, current, actions, active, busy, runningHere, offerAuto, isDraft, automatic, tooltip, match, canBring, canRunThere, hasAgents, checkingAgents, bringTo, project };
  };
  const move = (state: NonNullable<ReturnType<typeof useRunOn>>, id: string) => {
    const { list, current, actions, active } = state;
    bringing?.choice.set(undefined);
    if (id === AUTO) { autoRunOn.set(true); return; }
    autoRunOn.set(false);
    const machine = list.environments.find((environment) => environment.id === id);
    if (!machine || machine.id === current.id) return;
    const match = state.match(machine);
    if (state.canRunThere && state.hasAgents(machine) && active?.cwd && (match.found && match.workspaceId || !match.found && state.canBring)) {
      bringing!.choice.set({ machine: machine.id, machineName: machine.name, projectPath: active.cwd, ...(match.found && match.workspaceId ? { workspaceId: match.workspaceId } : {}) });
      return;
    }
    const draft = actions.composerDraft();
    moving.set(true);
    // The text goes along; left here it would be a second copy. The page reloads before `open` answers.
    actions.setComposerDraft?.("");
    // Its checkout of this project there, else the project that machine worked in last.
    const workspaceId = (match.found ? match.workspaceId : undefined) ?? machine.projects[0]?.workspaceId;
    void environments.open(machine.id, { newThread: { draft, ...(workspaceId ? { workspaceId } : {}) } })
      .catch((error: unknown) => {
        moving.set(false);
        actions.setComposerDraft?.(draft);
        actions.notify(error instanceof Error ? error.message : String(error));
      });
  };
  // Settings' Run on: This machine brings a new draft home once, as it opens.
  let homed = false;
  const source: DraftMachineSource = {
    // With one machine there is nothing to ask.
    openOnDraft: () => runOnDefault() === "ask" && (environments.getSnapshot()?.environments.length ?? 0) > 1,
    useMachine(props) {
      const state = useRunOn(props);
      const draft = state?.isDraft;
      useEffect(() => {
        if (!draft) { homed = false; return; }
        const home = state?.list.environments.find((machine) => machine.local);
        if (!homed && home && runOnDefault() === "this" && !state!.current.local) move(state!, home.id);
        homed = true;
        // oxlint-disable-next-line react-hooks/exhaustive-deps
      }, [draft]);
      if (!state) return undefined;
      const shown = state.bringTo ?? state.current;
      return {
        name: state.automatic ? "Automatic" : shown.name,
        icon: state.automatic ? <Scale size={13} aria-hidden /> : <MachineIcon environment={shown} />,
        tooltip: state.tooltip,
        moving: state.busy,
      };
    },
    Section: function RunOnRows({ touch, ...props }) {
      const state = useRunOn(props);
      // Once per opening: a machine out of reach is asked again, and turns pickable once it answers.
      useEffect(() => {
        const list = environments.getSnapshot();
        for (const machine of list?.environments ?? []) {
          if (machine.id !== list?.shown && machine.status !== "connected" && machine.status !== "refused") void environments.retry(machine.id).catch(() => undefined);
        }
      }, []);
      if (!state) return null;
      const { list, current, automatic, offerAuto, isDraft, runningHere, bringTo } = state;
      const now = Date.now();
      const selectedId = automatic ? undefined : bringTo?.id ?? current.id;
      // A machine without this project says what sending there does.
      const detailOf = (machine: UiEnvironment) => {
        if (machine.readOnly || machine.status === "refused") return cannotStartReason(machine, now)!;
        const detail = runOnDetail(machine, now, machine.id === current.id ? runningHere : undefined);
        if (!machine.local && state.checkingAgents) return `${detail} · checking agents…`;
        if (!machine.local && machine.status === "connected" && !state.hasAgents(machine)) return `${detail} · moves this window there`;
        return machine.id !== current.id && state.canBring && machine.status === "connected" && !state.match(machine).found ? `${detail} · Tau takes ${state.project} along` : detail;
      };
      const row = (id: string, name: string, icon: ReactNode, detail: string, selected: boolean, disabled: boolean, status?: string) => <button
        key={id}
        type="button"
        className="run-on-row"
        aria-pressed={selected}
        disabled={disabled || state.busy}
        data-status={status}
        data-touch={touch || undefined}
        onClick={() => move(state, id)}
      >
        {icon}
        <span><strong>{name}</strong><small>{detail}</small></span>
        {selected ? <Check size={13} aria-hidden /> : null}
      </button>;
      return <div className="run-on-rows" role="group" aria-label="Machines">
        {offerAuto ? row(AUTO, "Automatic", <Scale size={13} aria-hidden />, isDraft ? "The machine with the most room when you send" : "For a new thread's draft; this thread exists here already", automatic, !isDraft) : null}
        {list.environments.map((machine) => row(
          machine.id,
          machine.name,
          <MachineIcon environment={machine} />,
          // Offline reads as a state, as in the design; Read only and refused say why.
          detailOf(machine),
          machine.id === selectedId,
          machine.id !== current.id && (state.checkingAgents || cannotStartReason(machine, now) !== undefined),
          machine.status,
        ))}
      </div>;
    },
  };
  return source;
}

const RUN_ON_CHOICES: ReadonlyArray<{ value: RunOnDefault; label: string }> = [{ value: "this", label: "This machine" }, { value: "last", label: "Last used" }, { value: "ask", label: "Ask" }];

/** General's New threads card (design 2i): the machine a new thread starts on. */
export function RunOnDefaultRow() {
  const runOn = useSetting<RunOnDefault>(`values.${ENVIRONMENTS_EXTENSION_ID}.${RUN_ON_DEFAULT_KEY}`, { defaultValue: "last", read: (raw) => raw as RunOnDefault | undefined });
  return <SettingRow title="Run on" setting={runOn}
    control={<SegmentedControl label="Run on" value={runOn.value} options={RUN_ON_CHOICES} onChange={runOn.set} />} />;
}
