import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GitBranch, GitFork, RotateCcw } from "lucide-react";
import { Dialog, errorMessage, hostIsReadOnly, Popover, Sheet, tooltipProps, type ForkRequest, type HostSnapshot, type RegionProps, type UiMessage, type WorkbenchActions } from "tau";
import type { CheckpointStore } from "./checkpoints.js";
import type { ForkWorktree } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

/** `fix/x` → `fix/x-2`, or the next number free; a trailing number is replaced, not extended. */
export function nextForkBranch(branch: string | undefined, taken: readonly string[]): string {
  const stem = (branch || "tau/fork").replace(/-\d+$/u, "");
  for (let number = 2; ; number += 1) if (!taken.includes(`${stem}-${number}`)) return `${stem}-${number}`;
}

const stored = (messages: readonly UiMessage[] | undefined) => [...messages ?? []].reverse().find((message) => message.sourceEntryId)?.sourceEntryId;

/**
 * Asks before a fork, as design 2d does: the fork gets a branch and worktree of
 * its own with the files of the turn's verified checkpoint, else the branch's
 * HEAD. Without `entryId` it copies the whole thread and the checkout as it is.
 */
function ForkDialog({ request, anchor, sheet, snapshot, actions, checkpoints, workspace, onClose }: {
  request: ForkRequest;
  anchor?: RefObject<HTMLButtonElement | null>;
  sheet: boolean;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  checkpoints: CheckpointStore;
  workspace: WorkspaceStore;
  onClose(): void;
}) {
  const { turn } = request;
  const info = workspace.getSnapshot().workspace;
  const sessionId = snapshot?.sessionId;
  const through = request.entryId ?? stored(snapshot?.messages);
  const ids = new Set(turn ? turn.messages.flatMap((message) => [message.id, message.sourceEntryId]) : [request.entryId]);
  const state = useSyncExternalStore(checkpoints.subscribe, checkpoints.getSnapshot, checkpoints.getSnapshot);
  const checkpoint = request.entryId && state.sessionId === sessionId
    ? checkpoints.all().find((entry) => ids.has(entry.anchorMessageId) && entry.completeness !== "partial")
    : undefined;
  // The pills verify only turns that changed files; any other turn's checkpoint is asked about here.
  const [asked, setAsked] = useState<{ id: string; ok: boolean }>();
  const verified = !checkpoint ? false : state.restorable.has(checkpoint.id) || (asked?.id === checkpoint.id ? asked.ok : undefined);
  const [name, setName] = useState(() => nextForkBranch(info?.branch, info?.refs.map((ref) => ref.name) ?? []));
  const [busy, setBusy] = useState(false);
  const pending = verified === undefined ? checkpoint?.id : undefined;
  useEffect(() => {
    if (!pending || !sessionId) return;
    let live = true;
    const answer = (ok: boolean) => { if (live) setAsked({ id: pending, ok }); };
    workspace.host.canRestoreCheckpoint(sessionId, pending).then(answer, () => answer(false));
    return () => { live = false; };
  }, [pending, sessionId]);

  const repo = Boolean(info?.isRepo);
  const span = turn ? turn.number === 1 ? "turn 1" : `turns 1–${turn.number}` : request.entryId ? "the conversation up to here" : "the whole conversation";
  const title = turn ? `Fork from turn ${turn.number}?` : request.entryId ? "Fork from here?" : "Duplicate this thread?";
  const files = !repo ? " in this folder"
    : !request.entryId ? " and a copy of the worktree as it is now"
      : verified ? " and a copy of the worktree at that point"
        : verified === false ? `. ${turn ? `Turn ${turn.number}` : "This point"} has no checkpoint, so the worktree starts from ${info?.branch ?? "HEAD"}'s current commit, without uncommitted changes`
          : "";
  const fork = async () => {
    if (!through || busy || pending) return;
    if (snapshot?.isStreaming) { actions.notify("Wait for the active run before forking this thread."); return; }
    setBusy(true);
    let created: ForkWorktree | undefined;
    try {
      if (repo) {
        created = await workspace.host.forkWorktree({
          branch: name.trim(),
          ...(!request.entryId ? { now: true } : verified && checkpoint && sessionId ? { sessionId, checkpointId: checkpoint.id } : {}),
        }, snapshot?.workspaceId ?? workspace.workspace());
      }
      if (await actions.forkFrom?.({ sourceEntryId: through }, created ? { workspace: created.workspaceId } : {})) { onClose(); return; }
    } catch (error) {
      actions.notify(errorMessage(error));
    }
    // A worktree made for a fork that did not happen goes again.
    if (created) await workspace.host.removeWorktree(created.path, name.trim(), snapshot?.workspaceId ?? workspace.workspace()).catch(() => undefined);
    setBusy(false);
  };
  const body = <form onSubmit={(event) => { event.preventDefault(); void fork(); }}>
    <p>A new thread starts with {span}{files}. This thread stays as it is.</p>
    {repo ? <label className="confirm-dialog-type">
      <span>Branch</span>
      <span className="fork-dialog-branch">
        <GitBranch size={12} /><input value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} autoFocus aria-label="Branch" />
      </span>
    </label> : null}
    <footer>
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary" disabled={busy || Boolean(pending) || (repo && !name.trim())}><GitFork size={12} />{busy ? "Forking…" : "Fork"}</button>
    </footer>
  </form>;
  // A sheet on touch, as the mobile rules ask, out of the row's transform; beside the line elsewhere (design 2d).
  return sheet
    ? createPortal(<Sheet title={title} className="fork-sheet" onClose={onClose}>{body}</Sheet>, document.body)
    : anchor
      ? <Popover anchor={anchor} label={title} className="confirm-dialog fork-dialog" onClose={onClose}><h2>{title}</h2>{body}</Popover>
      : <Dialog label={title} className="confirm-dialog fork-dialog" onClose={onClose}><h2>{title}</h2>{body}</Dialog>;
}

/** The fork question core hands over (`f`, the thread tree, Duplicate); one at a time. */
export class ForkAsks {
  private request?: ForkRequest;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.request;
  set(request?: ForkRequest): void {
    this.request = request;
    this.listeners.forEach((listener) => listener());
  }
}

/** Draws the question core handed over, centred, or as a sheet on touch. */
export function createForkAsker(asks: ForkAsks, checkpoints: CheckpointStore, workspace: WorkspaceStore, sheet: boolean) {
  return function ForkAsker({ snapshot, actions }: RegionProps) {
    const request = useSyncExternalStore(asks.subscribe, asks.getSnapshot, asks.getSnapshot);
    return request ? <ForkDialog request={request} sheet={sheet} snapshot={snapshot} actions={actions} checkpoints={checkpoints} workspace={workspace} onClose={() => asks.set()} /> : null;
  };
}

/** Fork and Restore on the line above a turn, shown on hover; both act on the turn's end. */
export function createTurnActions(checkpoints: CheckpointStore, workspace: WorkspaceStore, sheet: boolean) {
  return function TurnActions({ turn, snapshot, actions }: RegionProps) {
    const state = useSyncExternalStore(checkpoints.subscribe, checkpoints.getSnapshot, checkpoints.getSnapshot);
    const anchor = useRef<HTMLButtonElement>(null);
    const [asking, setAsking] = useState(false);
    if (!turn || (turn.last && snapshot?.isStreaming) || hostIsReadOnly()) return null;
    const through = stored(turn.messages);
    const ids = new Set(turn.messages.flatMap((message: UiMessage) => [message.id, message.sourceEntryId]));
    const checkpoint = state.sessionId === snapshot?.sessionId
      ? checkpoints.all().find((entry) => ids.has(entry.anchorMessageId) && state.restorable.has(entry.id))
      : undefined;
    // Pressing one keeps the focus that shows them (a tap on touch), so the press lands.
    return <span className={`turn-actions${asking ? " open" : ""}`} onMouseDown={(event) => { if (!(event.target as HTMLElement).closest("input")) event.preventDefault(); }}>
      {through && actions.forkFrom ? <button ref={anchor} type="button" onClick={() => setAsking(true)} {...tooltipProps(`Fork from turn ${turn.number}`)}>
        <GitFork size={11} />Fork here
      </button> : null}
      {checkpoint ? <button type="button" onClick={() => checkpoints.onRestore?.(checkpoint)} {...tooltipProps(`Restore the files to the end of turn ${turn.number}`)}>
        <RotateCcw size={11} />Restore files
      </button> : null}
      {asking && through ? <ForkDialog request={{ entryId: through, turn }} anchor={anchor} sheet={sheet} snapshot={snapshot} actions={actions}
        checkpoints={checkpoints} workspace={workspace} onClose={() => setAsking(false)} /> : null}
    </span>;
  };
}
