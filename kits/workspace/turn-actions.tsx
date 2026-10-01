import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GitBranch, GitFork, RotateCcw } from "lucide-react";
import { hostIsReadOnly, Popover, Sheet, tooltipProps, type RegionProps, type UiMessage } from "tau";
import type { CheckpointStore } from "./checkpoints.js";
import type { WorkspaceStore } from "./store.js";

/**
 * Asks before a fork, as design 2d does. A fork shares this thread's branch and
 * worktree today; the branch field is where a branch of its own will be chosen.
 */
function ForkDialog({ anchor, turn, branch, sheet, onCancel, onFork }: {
  anchor: RefObject<HTMLButtonElement | null>;
  turn: number;
  branch?: string;
  sheet: boolean;
  onCancel(): void;
  onFork(): void;
}) {
  const title = `Fork from turn ${turn}?`;
  const body = <>
    <p>A new thread starts with {turn === 1 ? "turn 1" : `turns 1–${turn}`}. For now it works on this thread's branch and worktree. This thread stays as it is.</p>
    <label className="confirm-dialog-type">
      <span>Branch</span>
      <span className="fork-dialog-branch" {...tooltipProps("A fork shares this thread's branch for now")}>
        <GitBranch size={12} /><input value={branch ?? "this thread's branch"} readOnly />
      </span>
    </label>
    <label className="confirm-dialog-skip"><input type="checkbox" checked disabled />Run on the same machine</label>
    <footer>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="primary" autoFocus onClick={onFork}><GitFork size={12} />Fork</button>
    </footer>
  </>;
  // A sheet on touch, as the mobile rules ask, out of the row's transform; beside the line elsewhere (design 2d).
  return sheet
    ? createPortal(<Sheet title={title} className="fork-sheet" onClose={onCancel}>{body}</Sheet>, document.body)
    : <Popover anchor={anchor} label={title} className="confirm-dialog fork-dialog" onClose={onCancel}><h2>{title}</h2>{body}</Popover>;
}

/** Fork and Restore on the line above a turn, shown on hover; both act on the turn's end. */
export function createTurnActions(checkpoints: CheckpointStore, workspace: WorkspaceStore, sheet: boolean) {
  return function TurnActions({ turn, snapshot, actions }: RegionProps) {
    const state = useSyncExternalStore(checkpoints.subscribe, checkpoints.getSnapshot, checkpoints.getSnapshot);
    const branch = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().workspace?.branch);
    const anchor = useRef<HTMLButtonElement>(null);
    const [asking, setAsking] = useState(false);
    if (!turn || (turn.last && snapshot?.isStreaming) || hostIsReadOnly()) return null;
    const through = [...turn.messages].reverse().find((message: UiMessage) => message.sourceEntryId);
    const ids = new Set(turn.messages.flatMap((message: UiMessage) => [message.id, message.sourceEntryId]));
    const checkpoint = state.sessionId === snapshot?.sessionId
      ? checkpoints.all().find((entry) => ids.has(entry.anchorMessageId) && state.restorable.has(entry.id))
      : undefined;
    // Pressing one keeps the focus that shows them (a tap on touch), so the press lands.
    return <span className={`turn-actions${asking ? " open" : ""}`} onMouseDown={(event) => event.preventDefault()}>
      {through && actions.forkFrom ? <button ref={anchor} type="button" onClick={() => setAsking(true)} {...tooltipProps(`Fork from turn ${turn.number}`)}>
        <GitFork size={11} />Fork here
      </button> : null}
      {checkpoint ? <button type="button" onClick={() => checkpoints.onRestore?.(checkpoint)} {...tooltipProps(`Restore the files to the end of turn ${turn.number}`)}>
        <RotateCcw size={11} />Restore files
      </button> : null}
      {asking && through ? <ForkDialog anchor={anchor} turn={turn.number} sheet={sheet} {...(branch ? { branch } : {})} onCancel={() => setAsking(false)} onFork={() => {
        setAsking(false);
        void actions.forkFrom?.(through);
      }} /> : null}
    </span>;
  };
}
