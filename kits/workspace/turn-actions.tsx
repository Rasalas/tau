import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GitBranch, GitFork, RotateCcw } from "lucide-react";
import { Dialog, errorMessage, hostIsReadOnly, Popover, Sheet, tooltipProps, type ForkRequest, type RegionProps, type UiMessage } from "tau";
import type { CheckpointStore } from "./checkpoints.js";
import type { ForkWorktree } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

/** `fix/x` → `fix/x-2`, or the next number free; a trailing number is replaced, not extended. */
export function nextForkBranch(branch: string | undefined, taken: readonly string[]): string {
  const stem = (branch || "tau/fork").replace(/-\d+$/u, "");
  let n = 2;
  while (taken.includes(`${stem}-${n}`)) n += 1;
  return `${stem}-${n}`;
}

const stored = (messages: readonly UiMessage[] | undefined) => [...messages ?? []].reverse().find((m) => m.sourceEntryId)?.sourceEntryId;

/** One fork question at a time: from a turn's line (beside it) or handed over by core (`f`, the tree, Duplicate). */
type Ask = ForkRequest & { anchor?: RefObject<HTMLButtonElement | null> };
export class ForkAsks {
  ask?: Ask;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.ask;
  set(ask?: Ask): void {
    this.ask = ask;
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * Asks before a fork, as design 2d does: the fork gets a branch and worktree of
 * its own with the files of the turn's verified checkpoint, else the branch's
 * HEAD. Without `entryId` it copies the whole thread and the checkout as it is.
 */
export function createForkAsker(asks: ForkAsks, checkpoints: CheckpointStore, workspace: WorkspaceStore, sheet: boolean) {
  return function ForkAsker({ snapshot, actions }: RegionProps) {
    const ask = useSyncExternalStore(asks.subscribe, asks.get, asks.get);
    const state = useSyncExternalStore(checkpoints.subscribe, checkpoints.getSnapshot, checkpoints.getSnapshot);
    const info = workspace.getSnapshot().workspace;
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    // The pills verify only turns that changed files; any other turn's checkpoint is asked about here.
    const [asked, setAsked] = useState<{ id: string; ok: boolean }>();
    useEffect(() => { setName(nextForkBranch(info?.branch, info?.refs.map((ref) => ref.name) ?? [])); setBusy(false); }, [ask]);
    const sessionId = snapshot?.sessionId;
    const turn = ask?.turn;
    const entry = ask?.entryId;
    const ids = new Set(turn ? turn.messages.flatMap((m) => [m.id, m.sourceEntryId]) : [entry]);
    const checkpoint = entry && state.sessionId === sessionId
      ? checkpoints.all().find((c) => ids.has(c.anchorMessageId) && c.completeness !== "partial")
      : undefined;
    const verified = !checkpoint ? false : state.restorable.has(checkpoint.id) || (asked?.id === checkpoint.id ? asked.ok : undefined);
    const pending = verified === undefined ? checkpoint?.id : undefined;
    useEffect(() => {
      if (!pending || !sessionId) return;
      let live = true;
      const answer = (ok: boolean) => { if (live) setAsked({ id: pending, ok }); };
      workspace.host.canRestoreCheckpoint(sessionId, pending).then(answer, () => answer(false));
      return () => { live = false; };
    }, [pending, sessionId]);
    if (!ask) return null;

    const close = () => asks.set();
    const through = entry ?? stored(snapshot?.messages);
    const repo = info?.isRepo;
    const project = snapshot?.workspaceId ?? workspace.workspace();
    const title = turn ? `Fork from turn ${turn.number}?` : entry ? "Fork from here?" : "Duplicate this thread?";
    const files = !repo ? " in this folder"
      : !entry ? " and a copy of the worktree as it is now"
        : verified ? " and a copy of the worktree at that point"
          : verified === false ? `. ${turn ? `Turn ${turn.number}` : "This point"} has no checkpoint, so the worktree starts from ${info?.branch ?? "HEAD"}'s last commit, without uncommitted changes`
            : "";
    const fork = async () => {
      if (!through || busy || pending) return;
      if (snapshot?.isStreaming) { actions.notify("Wait for the active run before forking this thread."); return; }
      setBusy(true);
      let made: ForkWorktree | undefined;
      try {
        if (repo) made = await workspace.host.forkWorktree({ branch: name.trim(), ...(!entry ? { now: true } : verified ? { sessionId, checkpointId: checkpoint!.id } : {}) }, project);
        if (await actions.forkFrom?.({ sourceEntryId: through }, made ? { workspace: made.workspaceId } : {})) { close(); return; }
      } catch (error) {
        actions.notify(errorMessage(error));
      }
      // A worktree made for a fork that did not happen goes again.
      if (made) await workspace.host.removeWorktree(made.path, name.trim(), project).catch(() => undefined);
      setBusy(false);
    };
    const body = <form onSubmit={(event) => { event.preventDefault(); void fork(); }}>
      <p>A new thread starts with {turn ? turn.number === 1 ? "turn 1" : `turns 1–${turn.number}` : entry ? "the conversation up to here" : "the whole conversation"}{files}. This thread stays as it is.</p>
      {repo ? <label className="confirm-dialog-type">
        <span>Branch</span>
        <span className="fork-dialog-branch"><GitBranch size={12} /><input value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} autoFocus aria-label="Branch" /></span>
      </label> : null}
      <footer>
        <button type="button" onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !!pending || (repo && !name.trim())}><GitFork size={12} />{busy ? "Forking…" : "Fork"}</button>
      </footer>
    </form>;
    // A sheet on touch, as the mobile rules ask, out of the row's transform; beside the line elsewhere (design 2d).
    if (sheet) return createPortal(<Sheet title={title} className="fork-sheet" onClose={close}>{body}</Sheet>, document.body);
    const Frame = (ask.anchor ? Popover : Dialog) as typeof Popover;
    return <Frame anchor={ask.anchor!} label={title} className="confirm-dialog fork-dialog" onClose={close}><h2>{title}</h2>{body}</Frame>;
  };
}

/** Fork and Restore on the line above a turn, shown on hover; both act on the turn's end. */
export function createTurnActions(asks: ForkAsks, checkpoints: CheckpointStore) {
  return function TurnActions({ turn, snapshot, actions }: RegionProps) {
    const state = useSyncExternalStore(checkpoints.subscribe, checkpoints.getSnapshot, checkpoints.getSnapshot);
    const ask = useSyncExternalStore(asks.subscribe, asks.get, asks.get);
    const anchor = useRef<HTMLButtonElement>(null);
    if (!turn || (turn.last && snapshot?.isStreaming) || hostIsReadOnly()) return null;
    const through = stored(turn.messages);
    const ids = new Set(turn.messages.flatMap((m: UiMessage) => [m.id, m.sourceEntryId]));
    const checkpoint = state.sessionId === snapshot?.sessionId
      ? checkpoints.all().find((c) => ids.has(c.anchorMessageId) && state.restorable.has(c.id))
      : undefined;
    // Pressing one keeps the focus that shows them (a tap on touch), so the press lands.
    return <span className={`turn-actions${ask?.anchor === anchor ? " open" : ""}`} onMouseDown={(event) => event.preventDefault()}>
      {through && actions.forkFrom ? <button ref={anchor} type="button" onClick={() => asks.set({ entryId: through, turn, anchor })} {...tooltipProps(`Fork from turn ${turn.number}`)}>
        <GitFork size={11} />Fork here
      </button> : null}
      {checkpoint ? <button type="button" onClick={() => checkpoints.onRestore?.(checkpoint)} {...tooltipProps(`Restore the files to the end of turn ${turn.number}`)}>
        <RotateCcw size={11} />Restore files
      </button> : null}
    </span>;
  };
}
