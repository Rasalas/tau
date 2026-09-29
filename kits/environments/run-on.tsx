import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Scale } from "lucide-react";
import { Menu, Sheet, tooltipProps, useThreadStore, type HostExtensionClient, type PlatformEnvironments, type RegionProps, type UiEnvironment } from "tau";
import { autoApplies, autoRunOn, chooseInput, threadTargets, useAutoPreview, useAutoRunOn } from "./auto.js";
import { cannotStartReason, shownMachine, statusText } from "./machines.js";
import { MachineIcon, useEnvironments } from "./rail.js";

const AUTO = "auto";

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

/**
 * "Run on" for a new thread, the environment selector: a pill under its
 * heading (`draft-actions`): which
 * machine the thread starts on. Another machine takes the draft's text with
 * it and opens this window there; a started thread stays where it runs.
 * "Automatic" leaves the choice to the moment the prompt is sent.
 */
export function createRunOnControl(environments: PlatformEnvironments, host?: HostExtensionClient, options: { sheet?: boolean } = {}) {
  const RunOnControl = ({ actions, snapshot, runningHere }: Partial<RegionProps> & { runningHere?: number }) => {
    const list = useEnvironments(environments);
    const auto = useAutoRunOn();
    const [open, setOpen] = useState(false);
    const [moving, setMoving] = useState(false);
    const current = list ? shownMachine(list) : undefined;
    const active = actions?.activeThread();
    // A draft, or a thread nothing was sent in yet, may still move; a started one stays where it runs.
    const unstarted = (active?.draftPending ?? false) || (snapshot !== undefined && snapshot.messages.length === 0 && !snapshot.isStreaming);
    const offerAuto = host !== undefined && autoApplies(environments, list);
    // The choice is made when a draft's first prompt creates its thread; a thread that exists stays here.
    const isDraft = active?.draftPending ?? false;
    const automatic = auto && offerAuto && isDraft;
    const targets = list && offerAuto ? threadTargets(list, active?.cwd) : new Map<string, string | undefined>();
    const preview = useAutoPreview(host, automatic && targets.size > 0 ? chooseInput(targets, active?.cwd, active?.backendKind, active?.model) : undefined);
    // Shown for every new thread, even with one machine: it says where the thread runs.
    if (!list || !current || !actions || !unstarted) return null;
    const now = Date.now();
    const move = (id: string) => {
      if (id === AUTO) { autoRunOn.set(true); return; }
      autoRunOn.set(false);
      const machine = list.environments.find((environment) => environment.id === id);
      if (!machine || machine.id === current.id) return;
      const draft = actions.composerDraft();
      setMoving(true);
      // The text goes along; left here it would be a second copy. The page reloads before `open` answers.
      actions.setComposerDraft?.("");
      // The project of the same name there, else the one that machine worked in last.
      const workspaceId = (threadTargets(list, active?.cwd).get(machine.id) ?? machine.projects[0]?.workspaceId);
      void environments.open(machine.id, { newThread: { draft, ...(workspaceId ? { workspaceId } : {}) } })
        .catch((error: unknown) => {
          setMoving(false);
          actions.setComposerDraft?.(draft);
          actions.notify(error instanceof Error ? error.message : String(error));
        });
    };
    const names = new Map(list.environments.map((machine) => [machine.id, machine.name]));
    const label = moving ? "Moving…" : automatic ? "Automatic" : current.name;
    const detail = (machine: UiEnvironment) => machine.readOnly || machine.status === "refused"
      ? cannotStartReason(machine, now)!
      : runOnDetail(machine, now, machine.id === current.id && runningHere !== undefined ? runningHere : undefined);
    const blocked = (machine: UiEnvironment) => machine.id !== current.id && cannotStartReason(machine, now) !== undefined;
    if (options.sheet) {
      return <>
        <button
          className="draft-pill machine-chip"
          aria-label={`Run on ${current.name}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={moving}
          onClick={() => setOpen(!open)}
        >
          <MachineIcon environment={current} />
          <span>{label}</span>
          <ChevronDown size={12} className="chev" />
        </button>
        {open ? <RunOnSheet
          machines={list.environments}
          current={current.id}
          detail={detail}
          blocked={blocked}
          onRefresh={(id) => void environments.retry(id).catch(() => undefined)}
          onPick={(id) => { setOpen(false); move(id); }}
          onClose={() => setOpen(false)}
        /> : null}
      </>;
    }
    return (
      <span className="menu-anchor run-on-anchor">
        <button
          className="draft-pill machine-chip"
          aria-label={`Run on ${automatic ? "Automatic" : current.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={moving}
          {...tooltipProps(automatic ? autoTooltip(preview, names, targets.size) : `Run on ${current.name}: the machine this thread starts on`)}
          onClick={() => setOpen(!open)}
        >
          {automatic ? <Scale size={13} aria-hidden /> : <MachineIcon environment={current} />}
          <span>{label}</span>
          <ChevronDown size={12} className="chev" />
        </button>
        {open ? (
          <Menu
            heading="Run on"
            items={[
              ...(offerAuto ? [{
                id: AUTO,
                label: "Automatic",
                icon: <Scale size={14} aria-hidden />,
                selected: automatic,
                description: isDraft ? "The machine with the most room when you send" : "For a new thread's draft; this thread exists here already",
                disabled: !isDraft,
              }] : []),
              ...list.environments.map((machine) => ({
                id: machine.id,
                label: machine.name,
                icon: <MachineIcon environment={machine} />,
                selected: !automatic && machine.id === current.id,
                // Offline reads as a state, as in the design; Read only and refused say why.
                description: detail(machine),
                disabled: blocked(machine),
              })),
            ]}
            onSelect={(id) => { setOpen(false); move(id); }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
  if (!options.sheet) return RunOnControl;
  // A phone's list of its hosts holds no threads of the one on screen; its own thread list does.
  return function RunOnSheetControl(props: Partial<RegionProps>) {
    const store = useThreadStore();
    const runningHere = useSyncExternalStore(store.subscribeToActivity, () => store.getActivity().runningThreadIds.length);
    return <RunOnControl {...props} runningHere={runningHere} />;
  };
}

/**
 * "Run on" as a phone's sheet (design 1o): a row per paired machine with its
 * state, the one in use ticked. A machine out of reach says why and cannot be
 * picked; opening the sheet asks those again, so a machine that came back
 * turns pickable while the sheet is open.
 */
function RunOnSheet({ machines, current, detail, blocked, onRefresh, onPick, onClose }: {
  machines: readonly UiEnvironment[];
  current: string;
  detail(machine: UiEnvironment): string;
  blocked(machine: UiEnvironment): boolean;
  onRefresh(id: string): void;
  onPick(id: string): void;
  onClose(): void;
}) {
  // Once per opening, not on every list change.
  useEffect(() => {
    for (const machine of machines) if (machine.id !== current && machine.status !== "connected" && machine.status !== "refused") onRefresh(machine.id);
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Sheet title="Run on" className="run-on-sheet" onClose={onClose}>
    <div className="run-on-rows" role="group" aria-label="Machines">
      {machines.map((machine) => {
        const selected = machine.id === current;
        const disabled = blocked(machine);
        return <button
          key={machine.id}
          type="button"
          className="run-on-row"
          aria-pressed={selected}
          disabled={disabled}
          data-status={machine.status}
          onClick={() => onPick(machine.id)}
        >
          <MachineIcon environment={machine} size={18} />
          <span><strong>{machine.name}</strong><small>{detail(machine)}</small></span>
          {selected ? <Check size={17} aria-hidden /> : null}
        </button>;
      })}
    </div>
  </Sheet>;
}
