import { useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, errorMessage } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestActionResult, PullRequestBranchHead, PullRequestRef } from "./protocol.js";

/** The selected identity stays fixed while newer request reads arrive. */
export interface BranchDeletionSelection { ref: PullRequestRef; head: PullRequestBranchHead }

export function BranchDeleteConfirm({ selection, client, disabledReason, onDone, onClose }: {
  selection: BranchDeletionSelection;
  client: PullRequestClient;
  disabledReason?: string;
  onDone(result: PullRequestActionResult): void;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { ref, head } = selection;
  const remove = async () => {
    if (busy || disabledReason) return;
    setBusy(true); setError(undefined);
    try {
      const result = await client.action(ref.url, { action: "delete-branch", seen: head });
      if (!result.branch?.branchDeleted) throw new Error(result.branch?.branchKept ?? "GitHub did not confirm deletion. Refresh and try again.");
      onDone(result);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return createPortal(
    <Dialog label="Delete remote branch?" className="confirm-dialog pr-link-dialog" onClose={() => { if (!busy) onClose(); }}>
      <header><h2>Delete remote branch?</h2>
        <p>This deletes the branch of PR #{ref.number} on GitHub. Local branches, worktrees and threads stay. Commits not reachable elsewhere may be lost.</p>
      </header>
      <p><code>{head.repository}:{head.branch}</code><br /><code>{head.sha}</code></p>
      {error ? <p role="alert" className="pr-error">{error}</p> : null}
      {disabledReason ? <p role="status">{disabledReason}</p> : null}
      <footer><button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy || Boolean(disabledReason)} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete branch"}</button>
      </footer>
    </Dialog>, document.body,
  );
}
