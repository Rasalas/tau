import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2 } from "lucide-react";
import { ChangesTree, useWorkbench, type DesktopExtensionContext, type PanelProps } from "tau";

/**
 * The dock panel over Workspace Kit's changes: what the worktree has, staged
 * or not, and the commit box that ends the turn. The full review is one click
 * away in the header.
 */
export function createChangesPanel(plugin: DesktopExtensionContext) {
  const store = plugin.workspaceStore;
  return function ChangesPanel({ active, extensionName }: PanelProps) {
    const { changes, committing, pushPrimary, commitFocusToken, cwd, workspace } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const { activeDocumentPath: activePath } = useWorkbench();
    const canPush = Boolean(workspace?.upstream);
    useEffect(() => { if (active) void store.refreshChanges(); }, [active, cwd]);
    const [message, setMessage] = useState(changes.proposedMessage ?? "");
    const [dirty, setDirty] = useState(false);
    // Follow the host's proposal until the user types; a commit resets to following.
    useEffect(() => { if (!dirty) setMessage(changes.proposedMessage ?? ""); }, [changes.proposedMessage, dirty]);
    const messageRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { if (commitFocusToken > 0 && active) messageRef.current?.focus(); }, [active, commitFocusToken]);

    const canCommit = !committing && changes.files.length > 0 && message.trim().length > 0;
    const stagedCount = changes.files.filter((file) => file.staged).length;
    const allStaged = stagedCount === changes.files.length;
    const submit = (push: boolean) => { if (canCommit) void store.commit(message, push).then(() => setDirty(false)); };
    const leadPush = pushPrimary && canPush;
    const activeRelative = useMemo(
      () => activePath && cwd && activePath.startsWith(`${cwd}/`) ? activePath.slice(cwd.length + 1) : undefined,
      [activePath, cwd],
    );

    return <section className="panel-body">
      <header className="panel-header">
        <h2>Changes</h2>
        <small>{changes.branch ?? extensionName.toLowerCase()}</small>
        <span className="spacer" />
        {changes.refreshStatus?.state === "error" ? <small title={changes.refreshStatus.message}>stale · refresh failed</small> : null}
        <button className="icon-button compact" title="Open full review" aria-label="Open full review" onClick={() => store.openReview()}><Maximize2 size={14} /></button>
        <button className="text-button" onClick={() => void store.refreshChanges()}>rescan</button>
      </header>
      {changes.files.length === 0 ? <p className="empty-copy">The worktree is clean.</p> : <>
        <div className="commit-box">
          <div className="commit-selection"><small>{stagedCount}/{changes.files.length} staged</small>{!allStaged ? <button className="text-button" disabled={committing} onClick={() => void store.stageAll()}>Stage all</button> : <span>All staged</span>}</div>
          <textarea
            ref={messageRef}
            placeholder="Commit message"
            aria-label="Commit message"
            value={message}
            onChange={(event) => { setMessage(event.target.value); setDirty(true); }}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(leadPush); } }}
          />
          <div className="commit-actions">
            <button className={leadPush ? "" : "primary"} disabled={!canCommit} onClick={() => submit(false)}>
              {committing && !leadPush ? "Working…" : stagedCount ? "Commit staged" : "Commit all"}
            </button>
            {canPush ? (
              <button className={leadPush ? "primary" : ""} disabled={!canCommit} onClick={() => submit(true)}>
                {committing && leadPush ? "Working…" : stagedCount ? "Commit staged & push" : "Commit all & push"}
              </button>
            ) : null}
            <small><span className="stat-add">+{changes.added}</span> <span className="stat-del">−{changes.removed}</span></small>
          </div>
        </div>
        <ChangesTree
          key={cwd}
          files={changes.files}
          activePath={activeRelative}
          onOpen={(path) => store.openDiff(path)}
          onStage={(path) => store.stageFile(path)}
          onUnstage={(path) => store.unstageFile(path)}
          onRevert={(path) => store.revertFile(path)}
        />
      </>}
    </section>;
  };
}
