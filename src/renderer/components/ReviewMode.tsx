import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ExternalLink, GitCommitHorizontal, MessageSquare, X } from "lucide-react";
import type {
  DiffLoadOptions, UiEditor, UiFileDiff, UiWorkspaceChanges, UiWorkspaceChangesPage,
  WorkspaceChangesQuery, WorkspaceDiffScope,
} from "../../shared/contracts";
import { readReviewState, writeReviewState, type PersistedReviewState } from "../review-state";
import { DiffView } from "./DiffView";
import { VirtualList } from "./VirtualList";
import { WindowControlsInset } from "./WindowControlsInset";
import { usePagedWorkspaceFiles } from "./usePagedWorkspaceFiles";

const STATUS_GLYPH: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?" };

export function ReviewMode({ changes, selectedPath, editor, busy, primaryPush, onSelect, onBack, onCommit,
  onOpenInEditor, loadDiff, loadFiles, loadChanges, workspaceKey = "workspace", readOnly = false, checkpointTitle }: {
  changes: UiWorkspaceChanges;
  selectedPath?: string;
  editor?: UiEditor;
  busy: boolean;
  primaryPush: boolean;
  onSelect(path: string): void;
  onBack(): void;
  onCommit(message: string, push: boolean): void;
  onOpenInEditor(path: string): void;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  loadChanges?(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  workspaceKey?: string;
  readOnly?: boolean;
  checkpointTitle?: string;
}) {
  const [scope, setScope] = useState<WorkspaceDiffScope>("worktree");
  const [visibleChanges, setVisibleChanges] = useState(changes);
  const [loadingScope, setLoadingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string>();
  const [diff, setDiff] = useState<UiFileDiff>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [message, setMessage] = useState(changes.proposedMessage ?? "");
  const [editingMessage, setEditingMessage] = useState(false);
  const [reviewState, setReviewState] = useState<PersistedReviewState>(() => readReviewState(workspaceKey, scope));
  const [notesOpen, setNotesOpen] = useState(false);
  const [draft, setDraft] = useState<{ path: string; line?: number }>();
  const [draftBody, setDraftBody] = useState("");
  const paged = usePagedWorkspaceFiles(visibleChanges, readOnly ? loadFiles : undefined);

  useEffect(() => { if (scope === "worktree") setVisibleChanges(changes); }, [changes, scope]);
  useEffect(() => {
    if (!selectedPath) { setDiff(undefined); return; }
    let cancelled = false;
    setDiff(undefined);
    const options: DiffLoadOptions = readOnly
      ? { hunkLimit: 40 }
      : { hunkLimit: 40, scope, baseRef: visibleChanges.baseRef, baseCommit: visibleChanges.baseCommit };
    void loadDiff(selectedPath, options).then((next) => { if (!cancelled) setDiff(next); });
    return () => { cancelled = true; };
  }, [loadDiff, readOnly, scope, selectedPath, visibleChanges.baseCommit, visibleChanges.baseRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !editingMessage && !draft) onBack(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, editingMessage, onBack]);

  const updateReviewState = (update: (current: PersistedReviewState) => PersistedReviewState) => setReviewState((current) => {
    const next = update(current);
    writeReviewState(workspaceKey, scope, next);
    return next;
  });
  const switchScope = async (nextScope: WorkspaceDiffScope) => {
    if (nextScope === scope || !loadChanges) return;
    setLoadingScope(true);
    try {
      const next = await loadChanges({ scope: nextScope });
      setScopeError(undefined);
      setScope(nextScope);
      setVisibleChanges(next);
      setReviewState(readReviewState(workspaceKey, nextScope));
      if (next.files[0]) onSelect(next.files[0].path);
    } catch (error) {
      setScopeError(error instanceof Error ? error.message : "Could not load branch changes.");
    } finally { setLoadingScope(false); }
  };
  const readPaths = useMemo(() => new Set(reviewState.readPaths), [reviewState.readPaths]);
  const visibleReadCount = paged.files.filter((file) => readPaths.has(file.path)).length;
  const selectedComments = reviewState.comments.filter((comment) => comment.path === selectedPath);
  const annotationCounts = useMemo(() => {
    const counts = new Map<number, number>();
    selectedComments.filter((comment) => !comment.resolved && comment.line !== undefined)
      .forEach((comment) => counts.set(comment.line!, (counts.get(comment.line!) ?? 0) + 1));
    return counts;
  }, [selectedComments]);
  const toggleRead = (path: string) => updateReviewState((current) => ({ ...current,
    readPaths: current.readPaths.includes(path) ? current.readPaths.filter((entry) => entry !== path) : [...current.readPaths, path],
  }));
  const saveComment = () => {
    const body = draftBody.trim();
    if (!draft || !body) return;
    updateReviewState((current) => ({ ...current, comments: [...current.comments,
      { id: crypto.randomUUID(), ...draft, body, createdAt: Date.now() }] }));
    setDraft(undefined);
    setDraftBody("");
    setNotesOpen(true);
  };

  return <div className="review-shell">
    <header className="title-bar">
      <WindowControlsInset />
      <button className="chrome-button" onClick={onBack}><ArrowLeft size={13} /> Back to thread</button>
      <span className="review-title-divider" />
      <div className="title-identity"><strong>{visibleChanges.branch ?? "review"}</strong><span>review · {paged.fileCount} {paged.fileCount === 1 ? "file" : "files"}</span></div>
      {!readOnly && loadChanges ? <div className="review-scope toggle-group" aria-label="Review scope">
        <button className={scope === "worktree" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("worktree")}>Worktree</button>
        <button className={scope === "branch" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("branch")}>Branch changes</button>
        {scopeError ? <div className="review-scope-popover" role="alert"><span>{scopeError}</span><button className="icon-button compact" aria-label="Dismiss comparison error" onClick={() => setScopeError(undefined)}><X size={12} /></button></div> : null}
      </div> : null}
      <div className="title-spacer" />
      {!readOnly && scope === "worktree" ? <button className="chrome-button accent" disabled={busy || paged.fileCount === 0 || message.trim().length === 0} onClick={() => onCommit(message, primaryPush)}>
        <GitCommitHorizontal size={13} /> {busy ? "Working…" : primaryPush ? "Commit & push" : "Commit"}
      </button> : readOnly ? <span className="review-read-only">Historical turn</span> : <span className="review-read-only">Committed branch diff</span>}
    </header>

    <div className="review-body">
      <aside className="review-list">
        <header><h2>{readOnly ? checkpointTitle ?? "Turn changes" : scope === "branch" ? "Branch changes" : "Changes"}</h2><small>{visibleChanges.baseRef ? `from ${visibleChanges.baseRef}` : visibleChanges.branch ?? "detached"}</small><span className="spacer" /><span className="stat-add">+{visibleChanges.added}</span><span className="stat-del">−{visibleChanges.removed}</span></header>
        {!readOnly ? <div className="review-progress"><span>{visibleReadCount}/{paged.fileCount} viewed</span><i><b style={{ width: `${paged.fileCount ? Math.min(100, visibleReadCount / paged.fileCount * 100) : 0}%` }} /></i></div> : null}
        <div className="review-files">
          {visibleChanges.completeness === "partial" ? <p className="file-tree-error changed-files-warning">{visibleChanges.incompleteReason ?? "Snapshot coverage is partial; some workspace changes may be omitted."}</p> : null}
          <VirtualList items={paged.files} itemHeight={43} className="review-files-virtual" empty={<p className="empty-copy">No changes in this scope.</p>} renderItem={(file) => <div key={file.path} className={`review-file ${file.path === selectedPath ? "active" : ""} ${readPaths.has(file.path) ? "read" : ""}`}>
            <button className="review-file-select" onClick={() => onSelect(file.path)}><i>{STATUS_GLYPH[file.status] ?? "M"}</i><span className="meta"><strong>{file.name}</strong><small>{(file.note ?? file.directory) || "."}</small></span><span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span></button>
            {!readOnly ? <button className="review-file-read" title={readPaths.has(file.path) ? "Mark unread" : "Mark viewed"} aria-label={`${readPaths.has(file.path) ? "Mark unread" : "Mark viewed"} ${file.path}`} onClick={() => toggleRead(file.path)}><Check size={13} /></button> : null}
          </div>} />
          {loadFiles && paged.hasMore ? <div className="changed-files-more-row"><button className="text-button" disabled={paged.loading} onClick={() => void paged.loadNextPage()}>{paged.loading ? "Loading…" : `Load more (${Math.max(0, paged.fileCount - paged.files.length)} remaining)`}</button>{paged.error ? <small className="file-tree-error">{paged.error}</small> : null}</div> : null}
          {paged.fileCount > 0 && !readOnly && scope === "worktree" ? <div className="commit-proposal">Commit message: {editingMessage ? null : <em>“{message || "none"}”</em>}{editingMessage ? <textarea autoFocus value={message} onChange={(event) => setMessage(event.target.value)} onBlur={() => setEditingMessage(false)} /> : null}<div className="commit-actions"><button className="primary" disabled={busy || message.trim().length === 0} onClick={() => onCommit(message, false)}>Commit</button><button onClick={() => setEditingMessage((value) => !value)}>{editingMessage ? "Done" : "Edit"}</button></div></div> : null}
        </div>
      </aside>

      <main className="review-stage">
        <header><strong>{selectedPath || "Select a file"}</strong>{diff ? <span className="stat-add">+{diff.added}</span> : null}{diff ? <span className="stat-del">−{diff.removed}</span> : null}<span className="spacer" />
          {!readOnly && selectedPath ? <button className="text-button" onClick={() => { setDraft({ path: selectedPath }); setDraftBody(""); }}><MessageSquare size={12} /> Comment</button> : null}
          {!readOnly ? <button className={`text-button ${notesOpen ? "active" : ""}`} onClick={() => setNotesOpen((open) => !open)}>{reviewState.comments.filter((comment) => !comment.resolved).length} notes</button> : null}
          <div className="toggle-group"><button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button><button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button></div>
          {editor && selectedPath ? <button className="text-button" onClick={() => onOpenInEditor(selectedPath)}>Open in {editor.name} <ExternalLink size={11} /></button> : null}
        </header>
        {draft ? <div className="review-comment-composer" role="dialog" aria-label="Add review note"><strong>{draft.line ? `${draft.path}:${draft.line}` : draft.path}</strong><textarea autoFocus placeholder="Leave a review note…" value={draftBody} onChange={(event) => setDraftBody(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveComment(); }} /><button className="mini-button" onClick={saveComment}>Add note</button><button className="icon-button compact" aria-label="Cancel comment" onClick={() => setDraft(undefined)}><X size={13} /></button></div> : null}
        <div className="review-stage-content">
          <div className="review-diff">{selectedPath ? <DiffView diff={diff} mode={mode} annotationCounts={annotationCounts} onAnnotate={!readOnly ? (line) => { setDraft({ path: selectedPath, line }); setDraftBody(""); } : undefined} onLoadMore={diff?.truncated && diff.nextHunkOffset !== undefined ? () => void loadDiff(selectedPath, { hunkOffset: diff.nextHunkOffset, hunkLimit: 40, scope, baseRef: visibleChanges.baseRef, baseCommit: visibleChanges.baseCommit }).then((next) => setDiff((current) => current ? { ...next, hunks: [...current.hunks, ...next.hunks] } : next)) : undefined} /> : <div className="diff-empty">Pick a file to review.</div>}</div>
          {notesOpen ? <aside className="review-notes"><header><strong>Review notes</strong><button className="icon-button compact" aria-label="Close notes" onClick={() => setNotesOpen(false)}><X size={13} /></button></header>{reviewState.comments.length === 0 ? <p>No notes yet.</p> : reviewState.comments.map((comment) => <article key={comment.id} className={comment.resolved ? "resolved" : ""}><small>{comment.path}{comment.line ? `:${comment.line}` : ""}</small><p>{comment.body}</p><button className="text-button" onClick={() => updateReviewState((current) => ({ ...current, comments: current.comments.map((entry) => entry.id === comment.id ? { ...entry, resolved: !entry.resolved } : entry) }))}>{comment.resolved ? "Reopen" : "Resolve"}</button></article>)}</aside> : null}
        </div>
      </main>
    </div>
  </div>;
}
