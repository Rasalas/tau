import { useEffect } from "react";
import { FileClock, History, RotateCcw } from "lucide-react";
import type {
  ChangeStatus,
  UiWorkspaceChanges,
} from "tau";
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
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
      // The shortcut takes the way that touches no file.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) {
        event.preventDefault();
        onConfirm(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel, onConfirm]);

  const files = workspaceChanges.files.slice(0, 8);
  const fileCount = workspaceChanges.fileCount ?? workspaceChanges.files.length;

  return (
    <div className="modal-scrim urgent restore-dialog-scrim">
      <section className="restore-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title">
        <header>
          <span className="restore-dialog-mark"><History size={15} /></span>
          <span>
            <strong id="restore-dialog-title">Rewind to this checkpoint?</strong>
            <small>Turn {checkpoint.turnId.slice(0, 12)}</small>
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
          <span>⌘↵ keep changes</span>
          <span className="spacer" />
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="restore-dialog-files" onClick={() => onConfirm(true)} disabled={busy}>
            <RotateCcw size={13} />Revert files too
          </button>
          <button type="button" className="primary" onClick={() => onConfirm(false)} disabled={busy} autoFocus>
            <FileClock size={13} />{busy ? "Rewinding…" : "Keep changes"}
          </button>
        </footer>
      </section>
    </div>
  );
}
