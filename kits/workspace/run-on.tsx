import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, GitBranch, Laptop, Server } from "lucide-react";
import { Popover, Sheet, Switch, hostHasLocalFiles, tooltipProps, useHostName, useThreadStore, type RegionProps } from "tau";
import { RefList, ThreadBranch, useWorkspaceState } from "./branch-menu.js";
import type { BranchNaming, DraftMachineProps, DraftMachineSource } from "./protocol.js";

/** Where a branch the user names goes unless the name brings its own folder. */
export const BRANCH_PREFIX = "tau/";

function useRunning(): number {
  const threads = useThreadStore();
  return useSyncExternalStore(threads.subscribeToActivity, () => threads.getActivity().runningThreadIds.length);
}

/** The host itself, where Machines Kit adds no list (a browser, a phone's page). */
export const hostMachine: DraftMachineSource = {
  useMachine() {
    const name = useHostName();
    const draft = useWorkspaceState().state.draftPending;
    const local = hostHasLocalFiles();
    // A started thread stays where it runs.
    if (!draft) return undefined;
    return { name: name ?? (local ? "This machine" : "Host"), icon: local ? <Laptop size={13} aria-hidden /> : <Server size={13} aria-hidden /> };
  },
  Section: function HostRow({ touch }) {
    const machine = hostMachine.useMachine({});
    const running = useRunning();
    return <div className="run-on-rows" role="group" aria-label="Machines">
      <button type="button" className="run-on-row" aria-pressed data-touch={touch || undefined}>
        {machine?.icon}
        <span><strong>{machine?.name}</strong><small>{hostHasLocalFiles() && !touch ? "this machine" : "online"} · {running ? `${running} running` : "idle"}</small></span>
        <Check size={13} aria-hidden />
      </button>
    </div>;
  },
};

function useMachineSource(): DraftMachineSource {
  return useWorkspaceState().state.draftMachine ?? hostMachine;
}

/** `fetched 2m ago`, as "Based on" says of the default base. */
export function fetchedAgo(at: number | undefined, now: number): string | undefined {
  if (at === undefined) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "fetched just now";
  const [value, unit] = minutes < 60 ? [minutes, "m"] : minutes < 1440 ? [Math.floor(minutes / 60), "h"] : [Math.floor(minutes / 1440), "d"];
  return `fetched ${value}${unit} ago`;
}

/** A name with a folder of its own is taken whole; anything else goes under `tau/`. */
export function branchFromField(text: string): string {
  const name = text.trim();
  return !name ? "" : name.includes("/") ? name : `${BRANCH_PREFIX}${name}`;
}

function BranchField({ touch }: { touch: boolean }) {
  const { store, state } = useWorkspaceState();
  const value = state.draftBranch ?? "";
  const own = value && !value.startsWith(BRANCH_PREFIX);
  return <label className="run-on-field">
    <GitBranch size={13} aria-hidden />
    {own ? null : <span>{BRANCH_PREFIX}</span>}
    <input
      autoFocus={!touch}
      value={own ? value : value.slice(BRANCH_PREFIX.length)}
      placeholder="name it, or leave empty"
      aria-label="Branch name for the new worktree"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => store.setDraftBranch({ name: branchFromField(event.target.value) })}
      onKeyDown={(event) => event.stopPropagation()}
    />
  </label>;
}

function Naming({ touch }: { touch: boolean }) {
  const { store, state } = useWorkspaceState();
  const named = state.canNameWorktrees;
  const chosen: BranchNaming = named ? store.branchNaming() : "random";
  const option = (naming: BranchNaming, label: string) => <button
    type="button"
    role="radio"
    aria-checked={chosen === naming}
    disabled={naming === "prompt" && !named}
    {...(naming === "prompt" && !named ? tooltipProps("Worktree Names is off: Settings → Extensions") : {})}
    onClick={() => store.setBranchNaming(naming)}
  >{label}</button>;
  return <div className="run-on-naming" role="radiogroup" aria-label="If empty">
    <span>If empty:</span>
    {option("prompt", touch ? "From the prompt" : "Name from the prompt")}
    {option("random", "Random")}
  </div>;
}

/** The default base, origin's latest other branches, the branches other threads work on, and the rest behind "Other…". */
function Bases({ touch, onOther }: { touch: boolean; onOther(): void }) {
  const { store, state } = useWorkspaceState();
  const threads = useThreadStore();
  const base = state.worktreeBase;
  const chosen = state.draftBase ?? base?.ref;
  const rows: Array<{ ref: string; detail?: string | undefined }> = [];
  // Branches another worktree holds: most often the thread next to this one. Their copies on origin add nothing.
  const held = state.workspace?.refs.filter((entry) => entry.worktreePath && !entry.isCurrent).map((entry) => entry.name) ?? [];
  if (base) rows.push({ ref: base.ref, detail: touch ? "default" : ["default", fetchedAgo(base.fetchedAt, Date.now())].filter(Boolean).join(" · ") });
  for (const ref of (base?.others ?? []).filter((name) => !held.includes(name.replace(/^origin\//u, ""))).slice(0, 2)) rows.push({ ref });
  for (const ref of held.slice(0, 1)) rows.push({ ref, detail: threads.getSnapshot().threads.find((thread) => thread.projectLabel === ref)?.title });
  if (chosen && !rows.some((row) => row.ref === chosen)) rows.splice(1, 0, { ref: chosen });
  return <div className="run-on-rows" role="group" aria-label="Based on">
    {base ? null : <p className="run-on-note">Fetching origin…</p>}
    {rows.map((row) => <button
      key={row.ref}
      type="button"
      className="run-on-row"
      aria-pressed={row.ref === chosen}
      onClick={() => store.setDraftBranch({ base: row.ref === base?.ref ? "" : row.ref })}
    >
      <GitBranch size={13} aria-hidden />
      <span><code>{row.ref}</code>{row.detail ? <small>{row.detail}</small> : null}</span>
      {row.ref === chosen ? <Check size={13} aria-hidden /> : null}
    </button>)}
    <button type="button" className="run-on-row run-on-other" onClick={onOther}><span><small>Other branch…</small></span></button>
  </div>;
}

/**
 * A new thread's branch (design 1k/1o): a name, or empty for one from the
 * prompt or a random one, and the base. The New worktree switch stays until
 * "create the worktree on the first edit" is decided (K150 1k/5).
 */
export function DraftBranchFields({ touch }: { touch: boolean }) {
  const { store, state } = useWorkspaceState();
  const [picking, setPicking] = useState(false);
  const info = state.workspace;
  const worktree = state.workspaceMode === "worktree";
  useEffect(() => {
    if (worktree && !state.worktreeBase) void store.loadWorktreeBase();
  }, [state.worktreeBase, store, worktree]);
  if (!info?.isRepo) return <div className="run-on-branch">
    <div className="run-on-heading">Branch</div>
    <p className="run-on-note">{info ? "Not a Git repository: the thread runs in the folder as it is." : "Reading the project…"}</p>
  </div>;
  if (picking) return <div className="branch-section picking">
    <RefList refs={info.refs} {...(state.draftBase ? { current: state.draftBase } : {})} placeholder="Start from…" onPick={(ref) => { setPicking(false); store.setDraftBranch({ base: ref }); }} />
  </div>;
  return <div className="run-on-branch">
    <div className="run-on-heading">Branch</div>
    {worktree ? <>
      <BranchField touch={touch} />
      <Naming touch={touch} />
      <div className="run-on-heading">Based on</div>
      <Bases touch={touch} onOther={() => setPicking(true)} />
    </> : <div className="run-on-field"><GitBranch size={13} aria-hidden /><code>{info.branch ?? "detached"}</code><small>checkout</small></div>}
    {/* The whole row is the switch's label, so a tap anywhere on it switches (a 44 px target on touch). */}
    <label className="branch-worktree">
      <span><strong>New worktree</strong><small>{worktree ? "Its own folder; the checkout stays as it is" : "Runs in the project's checkout"}</small></span>
      <Switch label="Run in a new worktree" checked={worktree} onChange={(on) => store.setWorkspaceMode(on ? "worktree" : "current")} />
    </label>
  </div>;
}

/** What the pill shows after the machine: the planned branch, `tau/…` while the prompt names it. */
function useBranchLabel(): string | undefined {
  const { state } = useWorkspaceState();
  const info = state.workspace;
  if (!state.draftPending || !info?.isRepo) return undefined;
  return state.workspaceMode === "worktree" ? state.draftBranch ?? `${BRANCH_PREFIX}…` : info.branch ?? "detached";
}

function RunOnPill({ source, touch, snapshot, actions }: DraftMachineProps & { source: DraftMachineSource; touch: boolean }) {
  const { state } = useWorkspaceState();
  const machine = source.useMachine({ ...(snapshot ? { snapshot } : {}), ...(actions ? { actions } : {}) });
  const branch = useBranchLabel();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!machine && !state.draftPending) return null;
  const close = () => setOpen(false);
  const body = <>
    {machine ? <>
      {touch ? null : <div className="run-on-heading">Run on</div>}
      <source.Section {...(snapshot ? { snapshot } : {})} {...(actions ? { actions } : {})} touch={touch} />
    </> : null}
    {state.draftPending ? <DraftBranchFields touch={touch} /> : null}
    {touch ? <button type="button" className="run-on-done" onClick={close}><Check size={15} aria-hidden />Done</button> : null}
  </>;
  const name = machine?.moving ? "Moving…" : machine?.name;
  return <>
    <button
      ref={anchor}
      type="button"
      className="runtime-chip run-on-pill"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Run on ${machine?.name ?? "this project"}${branch ? `, branch ${branch}` : ""}`}
      disabled={machine?.moving || state.workspaceBusy}
      {...(!touch && machine?.tooltip ? tooltipProps(machine.tooltip) : {})}
      onClick={() => setOpen((value) => !value)}
    >
      {machine?.icon ?? <GitBranch size={13} aria-hidden />}
      {name ? <span>{name}</span> : null}
      {branch && !touch ? <><i aria-hidden>·</i><code>{branch}</code></> : null}
      <ChevronDown size={12} className="chev" />
    </button>
    {/* On the composer's top edge, at its left (design 1k); a new anchor each render places it again as rows arrive. */}
    {open ? touch
      ? <Sheet title="Run on" className="run-on-sheet" onClose={close}>{body}</Sheet>
      : <Popover anchor={{ get current() { return anchor.current?.closest<HTMLElement>(".composer-frame") ?? anchor.current; } }} side="top" align="start" label="Run on" className="run-on-popover" onClose={close}>{body}</Popover> : null}
  </>;
}

/**
 * A new thread's machine and branch as one pill before the model (design
 * 1k/1o), opening one popover, or a sheet with Done on touch. It shows with
 * one machine too: it says where the thread runs.
 */
export function createRunOnControl(touch: boolean) {
  return function DraftRunOn(props: DraftMachineProps) {
    const source = useMachineSource();
    // Another source brings other hooks.
    return <RunOnPill key={source === hostMachine ? "host" : "machines"} source={source} touch={touch} {...props} />;
  };
}

function DraftSubline({ source, touch, snapshot, actions }: RegionProps & { source: DraftMachineSource; touch: boolean }) {
  const { state } = useWorkspaceState();
  const threads = useThreadStore();
  const machine = source.useMachine({ ...(snapshot ? { snapshot } : {}), actions });
  const project = threads.getProjects().find((entry) => entry.path === state.cwd || (state.workspaceId !== undefined && entry.workspaceId === state.workspaceId))?.name
    ?? state.cwd?.split(/[\\/]/u).filter(Boolean).pop();
  const info = state.workspace;
  const where = touch || !info?.isRepo ? undefined : state.workspaceMode === "worktree" ? "no worktree yet" : info.branch;
  return <>{[project, machine?.name, where].filter(Boolean).map((part) => <span key={part} className="thread-detail draft-detail"><span>{part}</span></span>)}</>;
}

/** The header's branch slot: a draft's "project · machine · no worktree yet" (design 1k), else the thread's branch. */
export function createHeadingBranch(touch: boolean) {
  return function HeadingBranch(props: RegionProps) {
    const { state } = useWorkspaceState();
    const source = useMachineSource();
    if (state.draftPending) return <DraftSubline key={source === hostMachine ? "host" : "machines"} source={source} touch={touch} {...props} />;
    if (!touch) return <ThreadBranch {...props} />;
    const label = props.snapshot?.projectLabel;
    return label ? <span className="thread-detail thread-detail-branch"><GitBranch size={12} aria-hidden /><span>{label}</span></span> : null;
  };
}
