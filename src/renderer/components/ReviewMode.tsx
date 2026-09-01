import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  MessageSquare,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  Search,
  X,
} from "lucide-react";
import type {
  DiffLoadOptions,
  UiEditor,
  UiFileDiff,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceDiffScope,
} from "../../shared/contracts";
import { readReviewState, writeReviewState, type PersistedReviewState } from "../review-state";
import { DiffView } from "./DiffView";
import { FileKindIcon } from "./FileKindIcon";
import { ReviewFileTree } from "./ReviewFileTree";
import { WindowControlsInset } from "./WindowControlsInset";
import { usePagedWorkspaceFiles } from "./usePagedWorkspaceFiles";

const SIDEBAR_WIDTH_KEY = "tau:review-sidebar-width";
const SIDEBAR_OPEN_KEY = "tau:review-sidebar-open";
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const COLLAPSED_CONTEXT_LINES = 3;
const EXPANDED_CONTEXT_LINES = 100_000;

function storedSidebarWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (stored === null) return 280;
  const value = Number(stored);
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
    : 280;
}

function storedSidebarOpen(): boolean {
  return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
}

export function ReviewMode({
  changes,
  selectedPath,
  editor,
  busy,
  primaryPush,
  onSelect,
  onBack,
  onCommit,
  onOpenInEditor,
  loadDiff,
  loadFiles,
  loadChanges,
  workspaceKey = "workspace",
  readOnly = false,
  checkpointTitle,
}: {
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
  const [diffError, setDiffError] = useState<string>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [contextMode, setContextMode] = useState<"collapse" | "expand">("collapse");
  const [message, setMessage] = useState(changes.proposedMessage ?? "");
  const [editingMessage, setEditingMessage] = useState(false);
  const [reviewState, setReviewState] = useState<PersistedReviewState>(() => readReviewState(workspaceKey, scope));
  const [notesOpen, setNotesOpen] = useState(false);
  const [draft, setDraft] = useState<{ path: string; line?: number }>();
  const [draftBody, setDraftBody] = useState("");
  const [filter, setFilter] = useState("");
  const [sidebarOpen, setSidebarOpenState] = useState(storedSidebarOpen);
  const [sidebarWidth, setSidebarWidthState] = useState(storedSidebarWidth);
  const [splitAvailable, setSplitAvailable] = useState(true);
  const stageRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | undefined>(undefined);
  const paged = usePagedWorkspaceFiles(visibleChanges, readOnly ? loadFiles : undefined);

  const contextLines = contextMode === "expand" ? EXPANDED_CONTEXT_LINES : COLLAPSED_CONTEXT_LINES;
  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return paged.files;
    return paged.files.filter((file) => file.path.toLocaleLowerCase().includes(query));
  }, [filter, paged.files]);
  const selectedFile = paged.files.find((file) => file.path === selectedPath);
  const selectedFilteredIndex = filteredFiles.findIndex((file) => file.path === selectedPath);

  useEffect(() => {
    if (scope === "worktree") setVisibleChanges(changes);
  }, [changes, scope]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff(undefined);
      setDiffError(undefined);
      return;
    }
    let cancelled = false;
    setDiff(undefined);
    setDiffError(undefined);
    const options: DiffLoadOptions = readOnly
      ? { hunkLimit: 40, contextLines }
      : {
          hunkLimit: 40,
          contextLines,
          scope,
          baseRef: visibleChanges.baseRef,
          baseCommit: visibleChanges.baseCommit,
        };
    void loadDiff(selectedPath, options)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((error) => {
        if (!cancelled) setDiffError(error instanceof Error ? error.message : "Could not load this diff.");
      });
    return () => {
      cancelled = true;
    };
  }, [contextLines, loadDiff, readOnly, scope, selectedPath, visibleChanges.baseCommit, visibleChanges.baseRef]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setSplitAvailable(entry.contentRect.width >= 760));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const cycleFile = (offset: -1 | 1) => {
    if (filteredFiles.length === 0) return;
    const current = selectedFilteredIndex < 0 ? (offset < 0 ? 0 : -1) : selectedFilteredIndex;
    const next = (current + offset + filteredFiles.length) % filteredFiles.length;
    const file = filteredFiles[next];
    if (file) onSelect(file.path);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingMessage && !draft) {
        onBack();
        return;
      }
      if (
        event.defaultPrevented
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || isTypingTarget(event.target)
        || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) return;
      if (filteredFiles.length === 0) return;
      event.preventDefault();
      cycleFile(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const setSidebarOpen = (open: boolean) => {
    setSidebarOpenState(open);
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
  };

  const setSidebarWidth = (width: number) => {
    const bounded = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
    setSidebarWidthState(bounded);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(bounded));
  };

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => setSidebarWidth(startWidth - (moveEvent.clientX - startX));
    const onUp = () => resizeCleanupRef.current?.();
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("review-resizing");
      resizeCleanupRef.current = undefined;
    };
    resizeCleanupRef.current = cleanup;
    document.body.classList.add("review-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const updateReviewState = (update: (current: PersistedReviewState) => PersistedReviewState) => {
    setReviewState((current) => {
      const next = update(current);
      writeReviewState(workspaceKey, scope, next);
      return next;
    });
  };

  const switchScope = async (nextScope: WorkspaceDiffScope) => {
    if (nextScope === scope || !loadChanges) return;
    setLoadingScope(true);
    try {
      const next = await loadChanges({ scope: nextScope });
      setScopeError(undefined);
      setScope(nextScope);
      setVisibleChanges(next);
      setReviewState(readReviewState(workspaceKey, nextScope));
      setFilter("");
      if (next.files[0]) onSelect(next.files[0].path);
    } catch (error) {
      setScopeError(error instanceof Error ? error.message : "Could not load branch changes.");
    } finally {
      setLoadingScope(false);
    }
  };

  const readPaths = useMemo(() => new Set(reviewState.readPaths), [reviewState.readPaths]);
  const visibleReadCount = paged.files.filter((file) => readPaths.has(file.path)).length;
  const selectedComments = reviewState.comments.filter((comment) => comment.path === selectedPath);
  const annotationCounts = useMemo(() => {
    const counts = new Map<number, number>();
    selectedComments
      .filter((comment) => !comment.resolved && comment.line !== undefined)
      .forEach((comment) => counts.set(comment.line!, (counts.get(comment.line!) ?? 0) + 1));
    return counts;
  }, [selectedComments]);

  const toggleRead = (path: string) => updateReviewState((current) => ({
    ...current,
    readPaths: current.readPaths.includes(path)
      ? current.readPaths.filter((entry) => entry !== path)
      : [...current.readPaths, path],
  }));

  const saveComment = () => {
    const body = draftBody.trim();
    if (!draft || !body) return;
    updateReviewState((current) => ({
      ...current,
      comments: [...current.comments, { id: crypto.randomUUID(), ...draft, body, createdAt: Date.now() }],
    }));
    setDraft(undefined);
    setDraftBody("");
    setNotesOpen(true);
  };

  const loadMore = () => {
    if (!selectedPath || !diff?.truncated || diff.nextHunkOffset === undefined) return;
    const options: DiffLoadOptions = {
      hunkOffset: diff.nextHunkOffset,
      hunkLimit: 40,
      contextLines,
      ...(readOnly ? {} : {
        scope,
        baseRef: visibleChanges.baseRef,
        baseCommit: visibleChanges.baseCommit,
      }),
    };
    void loadDiff(selectedPath, options)
      .then((next) => setDiff((current) => current
        ? { ...next, hunks: [...current.hunks, ...next.hunks] }
        : next))
      .catch((error) => setDiffError(error instanceof Error ? error.message : "Could not load more diff hunks."));
  };

  const scopeTitle = readOnly
    ? checkpointTitle ?? "Turn changes"
    : scope === "branch" ? "Branch changes" : "Changes";
  const effectiveMode = splitAvailable ? mode : "unified";

  return <div className="review-shell">
    <header className="title-bar">
      <WindowControlsInset />
      <button className="chrome-button" onClick={onBack}><ArrowLeft size={13} /> Back to thread</button>
      <span className="review-title-divider" />
      <div className="title-identity">
        <strong>{visibleChanges.branch ?? "review"}</strong>
        <span>review · {paged.fileCount} {paged.fileCount === 1 ? "file" : "files"}</span>
      </div>
      {!readOnly && loadChanges ? <div className="review-scope toggle-group" aria-label="Review scope">
        <button className={scope === "worktree" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("worktree")}>Worktree</button>
        <button className={scope === "branch" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("branch")}>Branch changes</button>
        {scopeError ? <div className="review-scope-popover" role="alert">
          <span>{scopeError}</span>
          <button className="icon-button compact" aria-label="Dismiss comparison error" onClick={() => setScopeError(undefined)}><X size={12} /></button>
        </div> : null}
      </div> : null}
      <div className="title-spacer" />
      {!readOnly && scope === "worktree" ? <button
        className="chrome-button accent"
        disabled={busy || paged.fileCount === 0 || message.trim().length === 0}
        onClick={() => onCommit(message, primaryPush)}
      >
        <GitCommitHorizontal size={13} /> {busy ? "Working…" : primaryPush ? "Commit & push" : "Commit"}
      </button> : readOnly
        ? <span className="review-read-only">Historical turn</span>
        : <span className="review-read-only">Committed branch diff</span>}
    </header>

    <div className="review-body">
      <main className="review-stage" ref={stageRef}>
        <header className="review-toolbar">
          <span className="review-scope-summary">
            <strong>{scopeTitle}</strong>
            <small>{visibleChanges.baseRef ? `from ${visibleChanges.baseRef}` : visibleChanges.branch ?? "detached"}</small>
            <span className="stat-add">+{visibleChanges.added}</span>
            <span className="stat-del">−{visibleChanges.removed}</span>
          </span>
          <div className="review-file-navigation">
            <button className="icon-button" aria-label="Previous changed file" disabled={filteredFiles.length === 0} onClick={() => cycleFile(-1)}><ChevronLeft size={15} /></button>
            <button className="icon-button" aria-label="Next changed file" disabled={filteredFiles.length === 0} onClick={() => cycleFile(1)}><ChevronRight size={15} /></button>
          </div>
          <span className="spacer" />
          {!readOnly && selectedPath ? <button className="text-button review-comment-action" onClick={() => {
            setDraft({ path: selectedPath });
            setDraftBody("");
          }}><MessageSquare size={12} /> Comment</button> : null}
          {!readOnly ? <button className={`text-button review-notes-action ${notesOpen ? "active" : ""}`} onClick={() => setNotesOpen((open) => !open)}>
            <MessagesSquare size={12} /> {reviewState.comments.filter((comment) => !comment.resolved).length} notes
          </button> : null}
          <div className="toggle-group" aria-label="Diff context">
            <button disabled={!selectedPath} className={contextMode === "collapse" ? "active" : ""} onClick={() => setContextMode("collapse")}>Diff only</button>
            <button disabled={!selectedPath} className={contextMode === "expand" ? "active" : ""} onClick={() => setContextMode("expand")}>All lines</button>
          </div>
          <div className="toggle-group" aria-label="Diff layout">
            <button disabled={!selectedPath} className={effectiveMode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
            <button className={effectiveMode === "split" ? "active" : ""} disabled={!selectedPath || !splitAvailable} title={!splitAvailable ? "Split view needs more width" : undefined} onClick={() => setMode("split")}>Split</button>
          </div>
          {editor && selectedPath ? <button className="text-button review-editor-action" onClick={() => onOpenInEditor(selectedPath)}>
            Open in {editor.name} <ExternalLink size={11} />
          </button> : null}
          <button
            className={`icon-button review-sidebar-toggle ${sidebarOpen ? "active" : ""}`}
            title="Toggle file tree"
            aria-label="Toggle file tree"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >{sidebarOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button>
        </header>

        {selectedFile ? <div className="review-file-header">
          <span className={`review-file-status ${selectedFile.status}`}>{selectedFile.status.charAt(0).toUpperCase()}</span>
          <FileKindIcon name={selectedFile.name} />
          <strong>{selectedFile.name}</strong>
          {selectedFile.directory ? <span>{selectedFile.directory}</span> : null}
          <span className="spacer" />
          <span className="stat-add">+{diff?.added ?? selectedFile.added}</span>
          <span className="stat-del">−{diff?.removed ?? selectedFile.removed}</span>
        </div> : null}

        {draft ? <div className="review-comment-composer" role="dialog" aria-label="Add review note">
          <strong>{draft.line ? `${draft.path}:${draft.line}` : draft.path}</strong>
          <textarea
            autoFocus
            placeholder="Leave a review note…"
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveComment();
            }}
          />
          <button className="mini-button" onClick={saveComment}>Add note</button>
          <button className="icon-button compact" aria-label="Cancel comment" onClick={() => setDraft(undefined)}><X size={13} /></button>
        </div> : null}

        <div className="review-stage-content">
          <div className="review-diff">
            {diffError ? <div className="diff-empty diff-error"><strong>Failed to load diff</strong><span>{diffError}</span></div>
              : selectedPath ? <DiffView
                  diff={diff}
                  mode={effectiveMode}
                  annotationCounts={annotationCounts}
                  onExpandContext={() => setContextMode("expand")}
                  onAnnotate={!readOnly ? (line) => {
                    setDraft({ path: selectedPath, line });
                    setDraftBody("");
                  } : undefined}
                  onLoadMore={diff?.truncated && diff.nextHunkOffset !== undefined ? loadMore : undefined}
                />
              : <div className="diff-empty">Pick a file to review.</div>}
          </div>
          {notesOpen ? <aside className="review-notes">
            <header><strong>Review notes</strong><button className="icon-button compact" aria-label="Close notes" onClick={() => setNotesOpen(false)}><X size={13} /></button></header>
            {reviewState.comments.length === 0 ? <p>No notes yet.</p> : reviewState.comments.map((comment) => <article key={comment.id} className={comment.resolved ? "resolved" : ""}>
              <small>{comment.path}{comment.line ? `:${comment.line}` : ""}</small>
              <p>{comment.body}</p>
              <button className="text-button" onClick={() => updateReviewState((current) => ({
                ...current,
                comments: current.comments.map((entry) => entry.id === comment.id
                  ? { ...entry, resolved: !entry.resolved }
                  : entry),
              }))}>{comment.resolved ? "Reopen" : "Resolve"}</button>
            </article>)}
          </aside> : null}
        </div>
      </main>

      {sidebarOpen ? <aside className="review-list" style={{ width: sidebarWidth }}>
        <div className="review-sidebar-resizer" role="separator" aria-orientation="vertical" onPointerDown={startSidebarResize} />
        <label className="review-filter">
          <Search size={13} />
          <input
            type="search"
            aria-label="Filter changed files"
            placeholder="Filter files"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {filter ? <button aria-label="Clear file filter" onClick={() => setFilter("")}><X size={12} /></button> : null}
        </label>
        <div className="review-sidebar-meta">
          <strong>{paged.fileCount} {paged.fileCount === 1 ? "changed file" : "changed files"}</strong>
          <span className="spacer" />
          <span className="stat-add">+{visibleChanges.added}</span>
          <span className="stat-del">−{visibleChanges.removed}</span>
        </div>
        {!readOnly ? <div className="review-progress">
          <span>{visibleReadCount}/{paged.fileCount} viewed</span>
          <i><b style={{ width: `${paged.fileCount ? Math.min(100, visibleReadCount / paged.fileCount * 100) : 0}%` }} /></i>
        </div> : null}
        <div className="review-files">
          {visibleChanges.completeness === "partial" ? <p className="file-tree-error changed-files-warning">
            {visibleChanges.incompleteReason ?? "Snapshot coverage is partial; some workspace changes may be omitted."}
          </p> : null}
          {filteredFiles.length > 0 ? <ReviewFileTree
            files={filteredFiles}
            activePath={selectedPath}
            viewedPaths={readPaths}
            readOnly={readOnly}
            onOpen={onSelect}
            onToggleViewed={toggleRead}
          /> : <p className="empty-copy">{filter ? "No matching changed files." : "No changes in this scope."}</p>}
          {loadFiles && paged.hasMore ? <div className="changed-files-more-row">
            <button className="text-button" disabled={paged.loading} onClick={() => void paged.loadNextPage()}>
              {paged.loading ? "Loading…" : `Load more (${Math.max(0, paged.fileCount - paged.files.length)} remaining)`}
            </button>
            {paged.error ? <small className="file-tree-error">{paged.error}</small> : null}
          </div> : null}
          {paged.fileCount > 0 && !readOnly && scope === "worktree" ? <div className="commit-proposal">
            Commit message: {editingMessage ? null : <em>“{message || "none"}”</em>}
            {editingMessage ? <textarea autoFocus value={message} onChange={(event) => setMessage(event.target.value)} onBlur={() => setEditingMessage(false)} /> : null}
            <div className="commit-actions">
              <button className="primary" disabled={busy || message.trim().length === 0} onClick={() => onCommit(message, false)}>Commit</button>
              <button onClick={() => setEditingMessage((value) => !value)}>{editingMessage ? "Done" : "Edit"}</button>
            </div>
          </div> : null}
        </div>
      </aside> : null}
    </div>
  </div>;
}
