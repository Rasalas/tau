import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { ChangeStatus, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import type { UiTurnCheckpoint } from "../../shared/turn-checkpoint-types";

export interface RestoreCheckpointDialogProps {
  checkpoint: UiTurnCheckpoint;
  laterTurns: number;
  workspaceChanges: UiWorkspaceChanges;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

function restoreAction(status: ChangeStatus): string {
  if (status === "added" || status === "untracked") return "remove";
  if (status === "deleted") return "restore";
  if (status === "renamed") return "replace";
  return "replace";
}

/** Explicit confirmation for the destructive workspace/conversation restore. */
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
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) {
        event.preventDefault();
        onConfirm();
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
          <span className="restore-dialog-mark"><AlertTriangle size={15} /></span>
          <span>
            <strong id="restore-dialog-title">Restore this checkpoint?</strong>
            <small>Turn {checkpoint.turnId.slice(0, 12)}</small>
          </span>
        </header>
        <div className="restore-dialog-body">
          <p>This creates a recoverable backup thread first, then replaces the active conversation branch and workspace with this checkpoint.</p>
          <p>The workspace list compares the live files with the selected checkpoint.</p>
          <dl>
            <div>
              <dt>Later turns removed from the active branch</dt>
              <dd>{laterTurns}</dd>
            </div>
            <div>
              <dt>Workspace paths changed by restore</dt>
              <dd>{fileCount}</dd>
            </div>
          </dl>
          {files.length > 0 ? (
            <ul aria-label="Workspace paths changed by restore">
              {files.map((file) => <li key={file.path}><code>{file.path}</code><span>{restoreAction(file.status)}</span></li>)}
              {fileCount > files.length ? <li className="restore-dialog-more">…and {fileCount - files.length} more</li> : null}
            </ul>
          ) : <p className="restore-dialog-muted">The live workspace already matches this checkpoint.</p>}
          <p className="restore-dialog-note">Use Fork instead if you want to explore this checkpoint without changing the current thread or workspace.</p>
        </div>
        <footer>
          <span>⌘↵ restore</span>
          <span className="spacer" />
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={busy} autoFocus>
            <RotateCcw size={13} />{busy ? "Restoring…" : "Restore checkpoint"}
          </button>
        </footer>
      </section>
    </div>
  );
}
