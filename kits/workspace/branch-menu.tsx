import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Folder, FolderGit2, GitBranch, Plus, Search, Trash2 } from "lucide-react";
import { Popover, Switch, VirtualList, tooltipProps, type RegionProps, type UiRef, type UiWorktree, type UiWorktreeStatus } from "tau";
import type { UiWorktreeRemoval } from "./protocol.js";
import { useWorkspaceStore } from "./store-context.js";

export function useWorkspaceState() {
  const store = useWorkspaceStore();
  return { store, state: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) };
}

/** Arrow keys over `count` rows from a search field, Enter picks; typing stays in the field. */
function useCursor(count: number, pick: (index: number) => void) {
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor((value) => Math.min(value, Math.max(0, count - 1))), [count]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setCursor((value) => (value + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter" && count) {
      event.preventDefault();
      pick(cursor);
    }
  };
  return { cursor, onKeyDown };
}

function SearchField({ value, label, onChange, onKeyDown }: { value: string; label: string; onChange(value: string): void; onKeyDown(event: KeyboardEvent<HTMLInputElement>): void }) {
  return <div className="ref-search">
    <Search size={13} />
    <input autoFocus value={value} placeholder={label} aria-label={label} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />
  </div>;
}

/** Refs to pick from, with the typed name offered as a new one when `create` is given. */
export function RefList({ refs, current, placeholder, create, onPick }: {
  refs: readonly UiRef[];
  current?: string;
  placeholder: string;
  create?: { label(name: string): ReactNode; onCreate(name: string): void };
  onPick(ref: string): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim();
  const shown = useMemo(() => refs.filter((ref) => !needle || ref.name.toLowerCase().includes(needle.toLowerCase())), [needle, refs]);
  const offer = create && needle && !refs.some((ref) => ref.name === needle) ? needle : undefined;
  const count = shown.length + (offer ? 1 : 0);
  const pick = (index: number) => (index < shown.length ? onPick(shown[index]!.name) : offer && create?.onCreate(offer));
  const { cursor, onKeyDown } = useCursor(count, pick);
  return <>
    <SearchField value={query} label={placeholder} onChange={setQuery} onKeyDown={onKeyDown} />
    <VirtualList
      items={shown}
      itemHeight={32}
      className="ref-list"
      empty={offer ? null : <p>No branch matches “{query}”.</p>}
      scrollToIndex={cursor < shown.length ? cursor : undefined}
      renderItem={(ref, index) => <button key={ref.name} type="button" className={ref.name === current || index === cursor ? "selected" : ""} onClick={() => onPick(ref.name)}>
        <span>{ref.name}</span>{ref.name === current ? <small>current</small> : ref.worktreePath ? <small>worktree</small> : null}
      </button>}
    />
    {offer && create ? <div className="ref-list ref-create">
      <button type="button" className={cursor === shown.length ? "selected" : ""} onClick={() => create.onCreate(offer)}><Plus size={13} /><span>{create.label(offer)}</span></button>
    </div> : null}
  </>;
}

function statusLine(status?: UiWorktreeStatus): string {
  if (!status || status.inspectionError || status.isDirty === undefined) return status ? "status unavailable" : "checking…";
  return [status.isDirty ? "uncommitted changes" : "clean", status.threadCount === 0 ? "unused" : `${status.threadCount} thread${status.threadCount === 1 ? "" : "s"}`].join(" · ");
}

/** The checkout of a running thread: switch or create a branch, open, add or remove a worktree. */
function CheckoutMenu({ sessionId, onDone }: { sessionId?: string; onDone(): void }) {
  const { store, state } = useWorkspaceState();
  const info = state.workspace;
  const [statuses, setStatuses] = useState<UiWorktreeStatus[]>();
  const [removing, setRemoving] = useState<{ tree: UiWorktree; preview?: UiWorktreeRemoval }>();
  const [busy, setBusy] = useState<{ ref: string; who: string }>();
  useEffect(() => {
    let current = true;
    void store.loadWorktreeBase();
    store.host.getWorktreeStatuses(store.workspace()).then((next) => { if (current) setStatuses(next); }, () => { if (current) setStatuses([]); });
    return () => { current = false; };
  }, [state.cwd, state.workspaceId, store]);
  if (!info?.isRepo) return <p className="branch-note">Not a Git repository.</p>;
  const done = (changed: Promise<boolean>) => void changed.then((ok) => { if (ok) onDone(); });
  const byPath = new Map(statuses?.map((status) => [status.path, status]));
  const base = state.worktreeBase?.ref ?? info.branch ?? "HEAD";
  // A switch rewrites the files under a running turn; ask first. A ref checked out elsewhere only opens that worktree.
  const switchTo = async (ref: string) => {
    const turns = info.refs.some((entry) => entry.name === ref && entry.worktreePath) ? [] : await store.host.checkoutTurns(sessionId, store.workspace()).catch(() => []);
    if (turns.length > 0) setBusy({ ref, who: turns.length === 1 ? `${turns[0]!.title} is` : `${turns.length} threads are` });
    else done(store.switchRef(ref));
  };
  return <div className="branch-menu">
    {busy ? <div className="worktree-remove" role="alertdialog" aria-label="Switch branch during a turn">
      <span className="menu-label">
        <em>{busy.who} working in this checkout.</em>
        <small>Switching the branch changes the files under it.</small>
      </span>
      <button type="button" className="danger" onClick={() => { setBusy(undefined); done(store.switchRef(busy.ref)); }}>Switch anyway</button>
      <button type="button" autoFocus onClick={() => { setBusy(undefined); onDone(); }}>Wait for the turn</button>
    </div> : <RefList
      refs={info.refs}
      {...(info.branch ? { current: info.branch } : {})}
      placeholder="Switch branch or type a new name…"
      create={{
        label: (name) => <>Create branch <code>{name}</code> here</>,
        onCreate: (name) => done(store.createBranch(name)),
      }}
      onPick={(ref) => (ref === info.branch ? onDone() : void switchTo(ref))}
    />}
    {info.ahead ? <div className="ref-note">{info.ahead} {info.ahead === 1 ? "commit" : "commits"} not pushed{info.upstream ? ` to ${info.upstream}` : ""}</div> : null}
    {info.isDirty ? <div className="ref-note">Uncommitted changes: a branch without a worktree cannot be checked out in place; a new branch takes them along.</div> : null}
    <div className="menu-heading">Worktrees</div>
    <div className="worktree-list">
      {info.worktrees.map((tree) => removing?.tree.path === tree.path ? <div className="worktree-remove" key={tree.path}>
        <span className="menu-label">
          <em>Remove {tree.branch ?? tree.name}?</em>
          <small>{removing.preview ? `${removing.preview.dirtyFiles} uncommitted file${removing.preview.dirtyFiles === 1 ? "" : "s"} · ${removing.preview.ahead} commit${removing.preview.ahead === 1 ? "" : "s"} beyond its base` : "reading what it holds…"}</small>
        </span>
        <button type="button" className="danger" onClick={() => { setRemoving(undefined); void store.removeWorktree(tree.path, tree.branch); }}>Remove</button>
        <button type="button" onClick={() => setRemoving(undefined)}>Cancel</button>
      </div> : <button key={tree.path} type="button" className={tree.isCurrent ? "selected" : ""} onClick={() => (tree.isCurrent ? onDone() : done(store.openWorktree(tree.path)))}>
        {tree.isMain ? <Folder size={13} /> : <FolderGit2 size={13} />}
        <span className="menu-label"><em>{tree.isMain ? "Main checkout" : tree.branch ?? tree.name}</em><small>{statusLine(byPath.get(tree.path))}</small></span>
        {!tree.isMain && !tree.isCurrent ? <span
          className="worktree-remove-action"
          role="button"
          tabIndex={-1}
          aria-label={`Remove ${tree.branch ?? tree.name}`}
          onClick={(event) => {
            event.stopPropagation();
            setRemoving({ tree });
            void store.host.getWorktreeRemoval(tree.path, state.cwd)
              .then((preview) => setRemoving((shown) => shown?.tree.path === tree.path ? { tree, preview } : shown), () => undefined);
          }}
        ><Trash2 size={12} /></span> : null}
      </button>)}
      <NewWorktree base={base} onCreate={(name) => done(store.createWorktree(name, base))} />
    </div>
  </div>;
}

/** "New worktree": a name, then a new thread there with the unsent text (the old checkout row's). */
function NewWorktree({ base, onCreate }: { base: string; onCreate(name: string): void }) {
  const [name, setName] = useState<string>();
  if (name === undefined) return <button type="button" onClick={() => setName("")}><Plus size={13} /><span className="menu-label"><em>New worktree…</em><small>from {base}; a new thread opens there with what you typed</small></span></button>;
  return <label className="branch-name new-worktree-name">
    <GitBranch size={13} aria-hidden />
    <input
      autoFocus
      value={name}
      placeholder="Branch for the worktree"
      aria-label="Branch for the new worktree"
      spellCheck={false}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && name.trim()) onCreate(name.trim());
      }}
    />
    <small>⏎</small>
  </label>;
}

/**
 * The branch in the thread header's sub-line (`thread-branch`): a menu over
 * the thread's checkout. Core draws the plain label while no kit takes the slot.
 */
export function ThreadBranch({ snapshot, card = false }: RegionProps & { card?: boolean }) {
  const { state } = useWorkspaceState();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const info = state.workspace;
  const label = info?.branch ?? snapshot?.projectLabel;
  if (!label) return null;
  if (info && !info.isRepo) return <span className={`thread-detail${card ? " workspace-card-row" : ""}`}><GitBranch size={card ? 16 : 12} aria-hidden /><span className={card ? "workspace-card-label" : undefined}>{label}</span></span>;
  return <span className="thread-detail">
    <button
      ref={anchor}
      type="button"
      className={`thread-branch-trigger${card ? " workspace-card-row" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Branch ${label}`}
      disabled={state.workspaceBusy}
      onClick={() => setOpen((value) => !value)}
    >
      {card ? <GitBranch aria-hidden /> : null}<span className={card ? "workspace-card-label" : undefined}>{label}</span>{card ? <span className="workspace-card-tail"><ChevronDown size={16} /></span> : <ChevronDown size={11} className="chev" />}
    </button>
    {open ? <Popover anchor={anchor} label="Branch" className="branch-popover" onClose={() => setOpen(false)}>
      <CheckoutMenu sessionId={snapshot?.sessionId} onDone={() => setOpen(false)} />
    </Popover> : null}
  </span>;
}

/** Why the draft suggests its own worktree, in the pill's tooltip. */
export const WORKTREE_SUGGESTION_REASON = "Another thread is working in this folder. In its own worktree, the changes and checkpoints of both threads stay separate.";

/**
 * "Start in its own worktree" beside the draft's other pills (K125), shown
 * while the store suggests it; the whole pill is the switch's label.
 */
export function WorktreeSuggestionPill() {
  const { store, state } = useWorkspaceState();
  if (!state.draftPending || !state.worktreeSuggested) return null;
  return <label className="draft-pill worktree-suggestion" {...tooltipProps(WORKTREE_SUGGESTION_REASON)}>
    <FolderGit2 size={13} aria-hidden />
    <span>Start in its own worktree</span>
    <Switch
      label="Start in its own worktree"
      checked={state.workspaceMode === "worktree"}
      disabled={state.workspaceBusy || state.preparingWorktree}
      onChange={(on) => store.setWorktreeSuggestion(on)}
    />
  </label>;
}
