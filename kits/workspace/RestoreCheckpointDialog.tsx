import { useEffect } from "react";
import { FileClock, History, RotateCcw } from "lucide-react";
import {
  Dialog,
  type ChangeStatus,
  type UiWorkspaceChanges,
} from "tau";
import { modEnterLabel } from "../_shared/platform-keys.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

export interface RestoreCheckpointDialogProps {
  checkpoint: UiTurnCheckpoint;
  laterTurns: number;
  workspaceChanges: UiWorkspaceChanges;
  busy?: boolean;
  onCancel(): void;
  /** `files` also puts the workspace back; without it only the conversation goes back. */
  onConfirm(files: boolean): void;
}

function restoreAction(status: ChangeStatus): string {
  if (status === "added" || status === "untracked") return "remove";
  if (status === "deleted") return "restore";
  if (status === "renamed") return "replace";
  return "replace";
}

/** When the turn finished, as a person tells turns apart: the time today, the date and time before. */
export function turnFinishedLabel(endedAt: number, now = Date.now()): string {
  const ended = new Date(endedAt);
  if (ended.toDateString() === new Date(now).toDateString()) {
    return `Turn finished at ${ended.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  return `Turn finished ${ended.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

/** Asks which way back to a checkpoint: the conversation only, or the files too. */
export function RestoreCheckpointDialog({
  checkpoint,
  laterTurns,
  workspaceChanges,
  busy = false,
  onCancel,
  onConfirm,
}: RestoreCheckpointDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The shortcut takes the way that touches no file, and only from inside
      // the dialog: a menu or dialog opened over it keeps its own keys.
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || busy) return;
      if (!(event.target instanceof Element) || !event.target.closest(".restore-dialog")) return;
      event.preventDefault();
      onConfirm(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onConfirm]);

  const files = workspaceChanges.files.slice(0, 8);
  const fileCount = workspaceChanges.fileCount ?? workspaceChanges.files.length;

  return (
    <Dialog className="restore-dialog" label="Rewind to this checkpoint?" onClose={() => { if (!busy) onCancel(); }}>
      <header>
        <span className="restore-dialog-mark"><History size={15} /></span>
        <span>
          <strong>Rewind to this checkpoint?</strong>
          <small>{turnFinishedLabel(checkpoint.endedAt)}</small>
        </span>
      </header>
      <div className="restore-dialog-body">
        <p>The thread continues from the end of this turn on a new branch. The current branch, with its {laterTurns} later {laterTurns === 1 ? "turn" : "turns"}, stays in its own thread.</p>
        <p><strong>Keep changes</strong> rewinds only the conversation; every file stays as it is now.</p>
        <p><strong>Revert files too</strong> also puts the workspace back to this checkpoint. Tau first saves the current workspace, uncommitted work included, in a backup thread.</p>
        <dl>
          <div>
            <dt>Workspace paths the file revert changes</dt>
            <dd>{fileCount}</dd>
          </div>
        </dl>
        {files.length > 0 ? (
          <ul aria-label="Workspace paths changed by restore">
            {files.map((file) => <li key={file.path}><code>{file.path}</code><span>{restoreAction(file.status)}</span></li>)}
            {fileCount > files.length ? <li className="restore-dialog-more">…and {fileCount - files.length} more</li> : null}
          </ul>
        ) : <p className="restore-dialog-muted">The live workspace already matches this checkpoint.</p>}
        <p className="restore-dialog-note">Use Fork instead to explore this checkpoint without leaving the current thread.</p>
      </div>
      <footer>
        <span>{modEnterLabel()} keep changes</span>
        <span className="spacer" />
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="restore-dialog-files" onClick={() => onConfirm(true)} disabled={busy}>
          <RotateCcw size={13} />Revert files too
        </button>
        <button type="button" className="primary" onClick={() => onConfirm(false)} disabled={busy} autoFocus>
          <FileClock size={13} />{busy ? "Rewinding…" : "Keep changes"}
        </button>
      </footer>
    </Dialog>
  );
}
