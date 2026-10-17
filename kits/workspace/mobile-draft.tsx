import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, FolderGit2, GitBranch } from "lucide-react";
import { Sheet, type RegionProps } from "tau";
import { rankRefs, useWorkspaceState } from "./branch-menu.js";
import { BranchField, useBaseRefs, useMachineSource, useWorktreeBase } from "./run-on.js";

export function MobileDraftMachine(props: RegionProps) {
  const { state } = useWorkspaceState();
  const source = useMachineSource();
  return state.draftPending ? <Machine key={source === state.draftMachine ? "remote" : "host"} source={source} {...props} /> : null;
}

function Machine({ source, snapshot, actions }: RegionProps & { source: ReturnType<typeof useMachineSource> }) {
  const machine = source.useMachine({ ...(snapshot ? { snapshot } : {}), actions });
  const [open, setOpen] = useState(false);
  if (!machine) return null;
  return <>
    <button type="button" className="mobile-draft-machine" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} disabled={machine.moving}>
      {machine.icon}<span>on {machine.name}</span><ChevronDown size={16} className="chev" aria-hidden />
    </button>
    {open ? <Sheet title="Run on" onClose={() => setOpen(false)}><source.Section {...(snapshot ? { snapshot } : {})} actions={actions} touch /></Sheet> : null}
  </>;
}

export function MobileDraftCheckout() {
  const { store, state } = useWorkspaceState();
  const [open, setOpen] = useState(false);
  const worktree = state.workspaceMode === "worktree";
  useWorktreeBase();
  if (!state.draftPending || !state.workspace?.isRepo) return null;
  const branch = worktree ? state.draftBase ?? state.worktreeBase?.ref ?? "…" : state.workspace.branch;
  return <div className="mobile-draft-checkout">
    <button type="button" aria-pressed={worktree} onClick={() => store.setWorkspaceMode(worktree ? "current" : "worktree")}>
      {worktree ? <FolderGit2 size={18} /> : <Folder size={18} />}<span>{worktree ? "New worktree" : "Current checkout"}</span>
    </button>
    <button type="button" aria-label="Choose base branch" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <GitBranch size={18} /><span>{worktree ? state.draftBranch ? `${state.draftBranch} from ` : "From " : ""}{branch ?? "detached"}</span><ChevronRight size={14} />
    </button>
    {open ? <BaseBranch onClose={() => setOpen(false)} /> : null}
  </div>;
}

function BaseBranch({ onClose }: { onClose(): void }) {
  const { store, state } = useWorkspaceState();
  const [query, setQuery] = useState("");
  const selected = state.draftBase ?? state.worktreeBase?.ref;
  const refs = rankRefs(useBaseRefs(), query);
  const worktree = state.workspaceMode === "worktree";
  return <Sheet title={worktree ? "New branch" : "Base branch"} presentation="page" className="mobile-base-branch" onClose={onClose}>
    {/* A new worktree's own branch; empty names it from the prompt (Settings → Branch name). */}
    {worktree ? <BranchField touch /> : null}
    <input className="mobile-page-search" aria-label="Find a branch" placeholder="Find a branch" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="mobile-choice-card">
      {refs.map((ref) => <button key={ref.name} className="mobile-branch-row" onClick={() => { store.setDraftBranch({ base: ref.name }); store.setWorkspaceMode("worktree"); onClose(); }}>
        <GitBranch size={22} /><span>{ref.name}{ref.isCurrent ? <small>CURRENT</small> : null}</span>{selected === ref.name ? <Check size={20} /> : null}
      </button>)}
      {refs.length === 0 ? <p>No matching branches</p> : null}
    </div>
  </Sheet>;
}
