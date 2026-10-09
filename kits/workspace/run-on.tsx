import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Folder, FolderGit2, GitBranch, Laptop, Server } from "lucide-react";
import { Popover, Switch, hostHasLocalFiles, tooltipProps, useHostName, useSetting, useThreadStore, type RegionProps, type UiProject, type DraftThread } from "tau";
import { CheckoutMenu, RefList, ThreadBranch, useWorkspaceState } from "./branch-menu.js";
import { WORKSPACE_HOST_EXTENSION_ID, type BranchNaming, type DraftMachineSource } from "./protocol.js";
import { START_FROM_ORIGIN_OPTION } from "./store.js";

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

export function useMachineSource(): DraftMachineSource {
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

export function BranchField({ touch }: { touch: boolean }) {
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

/** The draft's new branch: its name, then the base to start from (T3's ref picker plus a name). */
export function DraftWorktreeBranch({ touch, onPicked }: { touch: boolean; onPicked?(): void }) {
  const { store, state } = useWorkspaceState();
  const origin = useSetting<boolean>(`options.${WORKSPACE_HOST_EXTENSION_ID}.${START_FROM_ORIGIN_OPTION}`, { defaultValue: true, scope: "both", read: (raw) => typeof raw === "boolean" ? raw : undefined });
  const base = state.worktreeBase;
  const chosen = state.draftBase ?? base?.ref;
  const refs = useMemo(() => {
    const known = state.workspace?.refs ?? [];
    // The default base may be origin's, which the checkout's refs need not list.
    return base && !known.some((ref) => ref.name === base.ref) ? [{ name: base.ref, isCurrent: false }, ...known] : known;
  }, [base, state.workspace?.refs]);
  return <div className="draft-branch">
    <div className="run-on-heading">New branch</div>
    <BranchField touch={touch} />
    <Naming touch={touch} />
    <div className="run-on-heading">Based on</div>
    <RefList
      refs={refs}
      {...(chosen ? { current: chosen } : {})}
      placeholder="Search branches…"
      autoFocus={false}
      detail={(ref) => ref === base?.ref ? ["default", touch ? undefined : fetchedAgo(base.fetchedAt, Date.now())].filter(Boolean).join(" · ") : undefined}
      onPick={(ref) => { store.setDraftBranch({ base: ref === base?.ref ? "" : ref }); onPicked?.(); }}
    />
    <label className="branch-worktree draft-branch-origin" {...tooltipProps("Fetch origin and start from its latest commit")}>
      <span><strong>Start from origin</strong></span>
      <Switch label="Start from origin" checked={origin.value} onChange={(on) => { origin.set(on); store.setDraftBranch({ base: "" }); void store.loadWorktreeBase(); }} />
    </label>
  </div>;
}

/** The checkout branch a new thread without a worktree runs on, or the branch and base a new worktree gets. */
function useDraftBranch(): { label: string; base?: string } | undefined {
  const { state } = useWorkspaceState();
  const info = state.workspace;
  if (!state.draftPending || !info?.isRepo) return undefined;
  if (state.workspaceMode !== "worktree") return { label: info.branch ?? "detached" };
  const base = state.draftBase ?? state.worktreeBase?.ref ?? info.branch ?? "HEAD";
  return { label: state.draftBranch ?? `${BRANCH_PREFIX}…`, base };
}

/**
 * The machine beside the project pill under the heading; it says where the
 * thread runs, with one machine too, and opens the machine rows.
 */
function MachinePill({ source, snapshot, actions }: RegionProps & { source: DraftMachineSource }) {
  const { state } = useWorkspaceState();
  const machine = source.useMachine({ ...(snapshot ? { snapshot } : {}), actions });
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Settings' Run on: Ask opens the choice as a draft starts.
  useEffect(() => { if (state.draftPending && source.openOnDraft?.()) setOpen(true); }, [source, state.draftPending]);
  if (!machine || !state.draftPending) return null;
  return <>
    <button
      ref={anchor}
      type="button"
      className="draft-pill draft-machine"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Run on ${machine.name}`}
      disabled={machine.moving}
      {...(machine.tooltip ? tooltipProps(machine.tooltip) : {})}
      onClick={() => setOpen((value) => !value)}
    >
      {machine.icon}<span>{machine.moving ? "Moving…" : machine.name}</span><ChevronDown size={12} />
    </button>
    {open ? <Popover anchor={anchor} label="Run on" className="run-on-popover" onClose={() => setOpen(false)}>
      <div className="run-on-heading">Run on</div>
      <source.Section {...(snapshot ? { snapshot } : {})} actions={actions} touch={false} />
    </Popover> : null}
  </>;
}

export function DraftMachinePill(props: RegionProps) {
  const source = useMachineSource();
  // Another source brings other hooks.
  return <MachinePill key={source === hostMachine ? "host" : "machines"} source={source} {...props} />;
}

const MODES = [
  { mode: "current", label: "Current checkout", detail: "Runs in the project's checkout", Icon: Folder },
  { mode: "worktree", label: "New worktree", detail: "Its own folder; the checkout stays as it is", Icon: FolderGit2 },
] as const;

/**
 * Where a new thread works, on the composer's top edge without a surface of
 * its own (T3's phone layout): checkout or new worktree at the left, the
 * branch at the right. Each opens its popover.
 */
export function DraftCheckout({ snapshot }: RegionProps) {
  const { store, state } = useWorkspaceState();
  const branch = useDraftBranch();
  const modeAnchor = useRef<HTMLButtonElement>(null);
  const branchAnchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"mode" | "branch">();
  const worktree = state.workspaceMode === "worktree";
  useEffect(() => {
    if (state.draftPending && worktree && !state.worktreeBase) void store.loadWorktreeBase();
  }, [state.draftPending, state.worktreeBase, store, worktree]);
  if (!branch) return null;
  const current = MODES.find((entry) => entry.mode === state.workspaceMode) ?? MODES[0];
  const close = () => setOpen(undefined);
  const toggle = (which: "mode" | "branch") => setOpen((value) => value === which ? undefined : which);
  return <div className="draft-checkout">
    <button
      ref={modeAnchor}
      type="button"
      className="draft-checkout-control"
      aria-haspopup="dialog"
      aria-expanded={open === "mode"}
      aria-label={`Workspace: ${current.label}`}
      disabled={state.workspaceBusy || state.preparingWorktree}
      onClick={() => toggle("mode")}
    >
      <current.Icon size={13} aria-hidden /><span>{current.label}</span><ChevronDown size={12} className="chev" />
    </button>
    <button
      ref={branchAnchor}
      type="button"
      className="draft-checkout-control draft-checkout-branch"
      aria-haspopup="dialog"
      aria-expanded={open === "branch"}
      aria-label={branch.base ? `New branch ${branch.label} from ${branch.base}` : `Branch ${branch.label}`}
      disabled={state.workspaceBusy || state.preparingWorktree}
      onClick={() => toggle("branch")}
    >
      <GitBranch size={13} aria-hidden />
      {branch.base ? <>{state.draftBranch ? <code>{branch.label}</code> : null}<span>{state.draftBranch ? "from" : "From"}</span></> : null}
      <code>{branch.base ?? branch.label}</code>
      <ChevronDown size={12} className="chev" />
    </button>
    {open === "mode" ? <Popover anchor={modeAnchor} side="top" label="Workspace" className="run-on-popover draft-mode-popover" onClose={close}>
      <div className="run-on-rows" role="group" aria-label="Workspace">
        {MODES.map(({ mode, label, detail, Icon }) => <button key={mode} type="button" className="run-on-row" aria-pressed={state.workspaceMode === mode} onClick={() => { store.setWorkspaceMode(mode); close(); }}>
          <Icon size={13} aria-hidden /><span><strong>{label}</strong><small>{detail}</small></span>{state.workspaceMode === mode ? <Check size={13} aria-hidden /> : null}
        </button>)}
      </div>
    </Popover> : null}
    {open === "branch" ? worktree
      ? <Popover anchor={branchAnchor} side="top" align="end" label="Branch" className="run-on-popover draft-branch-popover" onClose={close}>
        <DraftWorktreeBranch touch={false} />
      </Popover>
      : <Popover anchor={branchAnchor} side="top" align="end" label="Branch" className="branch-popover" onClose={close}>
        <CheckoutMenu sessionId={snapshot?.sessionId} onDone={close} />
      </Popover> : null}
  </div>;
}

/** Names a draft from project or draft metadata before falling back to its folder. */
export function draftProjectName(projects: readonly Pick<UiProject, "path" | "workspaceId" | "name">[], drafts: readonly Pick<DraftThread, "projectPath" | "workspaceId" | "projectName">[], cwd?: string, workspaceId?: string): string | undefined {
  const matches = (path: string, id: string | undefined) => path === cwd || (workspaceId !== undefined && id === workspaceId);
  return projects.find((entry) => matches(entry.path, entry.workspaceId))?.name
    ?? drafts.find((entry) => matches(entry.projectPath, entry.workspaceId))?.projectName
    ?? cwd?.split(/[\\/]/u).filter(Boolean).pop();
}

function DraftSubline({ source, touch, snapshot, actions }: RegionProps & { source: DraftMachineSource; touch: boolean }) {
  const { state } = useWorkspaceState();
  const threads = useThreadStore();
  const machine = source.useMachine({ ...(snapshot ? { snapshot } : {}), actions });
  const project = draftProjectName(threads.getProjects(), threads.getDrafts(), state.cwd, state.workspaceId);
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
