import "./review-layout.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  GitCommitHorizontal,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  WrapText,
  X,
} from "lucide-react";
import type {
  DiffLoadOptions,
  UiChangedFile,
  UiEditor,
  UiFileDiff,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceDiffScope,
} from "../../shared/workspace-kit-types";
import { readReviewState, writeReviewState, type PersistedReviewState } from "../review-state";
import { useClientStorage } from "../client-storage-context";
import type { ClientStorage } from "../../workbench/client-storage";
import { STORAGE_KEYS } from "../../workbench/storage-keys";
import { DiffStream, diffLanguage, fileDiffRows, type DiffLineSlot, type DiffStreamHandle, type DiffStreamRow } from "./DiffView";
import { FileKindIcon } from "./FileKindIcon";
import { ReviewFileTree, type ReviewFileActions } from "./ReviewFileTree";
import "./review-embedded.css";
import { WindowControlsInset } from "./WindowControlsInset";
import { usePagedWorkspaceFiles } from "./usePagedWorkspaceFiles";
import { useHostCapabilities } from "../use-host-capabilities";

const SIDEBAR_WIDTH_KEY = STORAGE_KEYS.reviewSidebarWidth;
const SIDEBAR_OPEN_KEY = STORAGE_KEYS.reviewSidebarOpen;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 480;
const COLLAPSED_CONTEXT_LINES = 3;
const EXPANDED_CONTEXT_LINES = 100_000;

function storedSidebarWidth(storage: ClientStorage, fallback = 280): number {
  const stored = storage.get(SIDEBAR_WIDTH_KEY);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
    : fallback;
}

function storedSidebarOpen(storage: ClientStorage): boolean {
  return storage.get(SIDEBAR_OPEN_KEY) !== "false";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
}

function sameDiff(left: UiFileDiff | undefined, right: UiFileDiff): boolean {
  if (!left
    || left.path !== right.path
    || left.added !== right.added
    || left.removed !== right.removed
    || left.note !== right.note
    || left.truncated !== right.truncated
    || left.nextHunkOffset !== right.nextHunkOffset
    || left.hunks.length !== right.hunks.length) return false;
  return left.hunks.every((hunk, hunkIndex) => {
    const other = right.hunks[hunkIndex];
    return other !== undefined
      && hunk.header === other.header
      && hunk.lines.length === other.lines.length
      && hunk.lines.every((line, lineIndex) => {
        const otherLine = other.lines[lineIndex];
        return otherLine !== undefined
          && line.kind === otherLine.kind
          && line.oldLine === otherLine.oldLine
          && line.newLine === otherLine.newLine
          && line.text === otherLine.text;
      });
  });
}

/** What the confirm button does, in words: which files, on which branch, and whether it pushes. */
export function commitSummary(files: number, branch: string | undefined, push: boolean, staged = 0): string {
  const what = staged > 0
    ? `Commits the ${staged} staged ${staged === 1 ? "file" : "files"}`
    : `Commits all ${files} changed ${files === 1 ? "file" : "files"}`;
  const where = branch ? ` on ${branch}` : "";
  return push ? `${what}${where}, then pushes ${branch ?? "the branch"}.` : `${what}${where}. Nothing is pushed.`;
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
  suggestCommitMessage,
  autoSuggestCommitMessage = true,
  layout,
  onLayoutChange,
  ignoreWhitespace = false,
  onIgnoreWhitespaceChange,
  filesStartCollapsed = false,
  wordWrap = true,
  onWordWrapChange,
  lines,
  toolbar,
  aside,
  fileActions,
  listHeader,
  onRefresh,
  embedded = false,
}: {
  /** The stage owns the tab and window chrome. */
  embedded?: boolean;
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
  suggestCommitMessage?(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined>;
  autoSuggestCommitMessage?: boolean;
  /** Split or unified; with `onLayoutChange` the caller owns it, otherwise the toggle does. */
  layout?: "unified" | "split";
  onLayoutChange?(layout: "unified" | "split"): void;
  /** Passed to `loadDiff`; the toolbar offers the toggle only with `onIgnoreWhitespaceChange`. */
  ignoreWhitespace?: boolean;
  onIgnoreWhitespaceChange?(ignore: boolean): void;
  /** Every file starts folded to its header. */
  filesStartCollapsed?: boolean;
  /** Long lines wrap; the toolbar offers the switch only with `onWordWrapChange`. */
  wordWrap?: boolean;
  onWordWrapChange?(wrap: boolean): void;
  /** The line seam: a gutter action and what is drawn under a line. */
  lines?: DiffLineSlot;
  /** Controls a caller adds to the toolbar. */
  toolbar?: ReactNode;
  /** A panel beside the diffs. */
  aside?: ReactNode;
  /** Staging and reverting in the worktree, from the file list. */
  fileActions?: ReviewFileActions & { stageAll?(): Promise<void> | void };
  /** Drawn at the top of the file list, handed the commit message the bar holds. */
  listHeader?(commit: { message: string; committed(): void }): ReactNode;
  /** Reads the worktree's changes again. */
  onRefresh?(): void;
}) {
  const [scope, setScope] = useState<WorkspaceDiffScope>("worktree");
  const [visibleChanges, setVisibleChanges] = useState(changes);
  const [loadingScope, setLoadingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string>();
  const [diffs, setDiffs] = useState<Map<string, UiFileDiff>>(() => new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(() => new Map());
  const [ownMode, setOwnMode] = useState<"unified" | "split">(layout ?? "unified");
  const mode = onLayoutChange ? layout ?? "unified" : ownMode;
  const setMode = onLayoutChange ?? setOwnMode;
  /** Files whose fold differs from `filesStartCollapsed`. */
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [contextMode, setContextMode] = useState<"collapse" | "expand">("collapse");
  const [message, setMessage] = useState(autoSuggestCommitMessage && suggestCommitMessage ? "" : changes.proposedMessage ?? "");
  const [reviewState, setReviewState] = useState<PersistedReviewState>(() => readReviewState(workspaceKey, scope));
  const [filter, setFilter] = useState("");
  const clientStorage = useClientStorage();
  const [sidebarOpen, setSidebarOpenState] = useState(() => storedSidebarOpen(clientStorage));
  const [sidebarWidth, setSidebarWidthState] = useState(() => storedSidebarWidth(clientStorage, embedded ? 190 : 280));
  const [splitAvailable, setSplitAvailable] = useState(true);
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [messageError, setMessageError] = useState<string>();
  const stageRef = useRef<HTMLElement>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<DiffStreamHandle>(null);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const suggestedFingerprintRef = useRef<string | undefined>(undefined);
  // A device paired Read only reviews but does not commit (ADR 0024).
  const deviceReadOnly = useHostCapabilities().readOnly;
  const noCommit = readOnly || deviceReadOnly;
  const resizeCleanupRef = useRef<(() => void) | undefined>(undefined);
  const paged = usePagedWorkspaceFiles(visibleChanges, readOnly ? loadFiles : undefined);

  const contextLines = contextMode === "expand" ? EXPANDED_CONTEXT_LINES : COLLAPSED_CONTEXT_LINES;
  const whitespace = useMemo<DiffLoadOptions>(() => ignoreWhitespace ? { ignoreWhitespace: true } : {}, [ignoreWhitespace]);
  const isCollapsed = useCallback((path: string) => filesStartCollapsed !== toggledFiles.has(path), [filesStartCollapsed, toggledFiles]);
  const toggleCollapsed = useCallback((path: string) => setToggledFiles((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  }), []);
  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return paged.files;
    return paged.files.filter((file) => file.path.toLocaleLowerCase().includes(query));
  }, [filter, paged.files]);
  const selectedFilteredIndex = filteredFiles.findIndex((file) => file.path === selectedPath);

  useEffect(() => {
    if (scope === "worktree") setVisibleChanges(changes);
  }, [changes, scope]);

  useEffect(() => {
    let cancelled = false;
    const options: DiffLoadOptions = readOnly
      ? { hunkLimit: 40, contextLines, ...whitespace }
      : { hunkLimit: 40, contextLines, ...whitespace, scope, baseRef: visibleChanges.baseRef, baseCommit: visibleChanges.baseCommit };
    let nextIndex = 0;
    const loadNext = async (): Promise<void> => {
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- cancelled flips in the effect cleanup below, which aborts this in-flight loop.
      while (!cancelled) {
        const file = paged.files[nextIndex++];
        if (!file) return;
        try {
          const next = await loadDiff(file.path, options);
          if (!cancelled) {
            setDiffs((current) => sameDiff(current.get(file.path), next) ? current : new Map(current).set(file.path, next));
            setDiffErrors((current) => {
              if (!current.has(file.path)) return current;
              const updated = new Map(current);
              updated.delete(file.path);
              return updated;
            });
          }
        } catch (error) {
          if (!cancelled) setDiffErrors((current) => new Map(current).set(file.path, error instanceof Error ? error.message : "Could not load this diff."));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, paged.files.length) }, () => loadNext()));
    return () => { cancelled = true; };
  }, [contextLines, loadDiff, paged.files, readOnly, scope, visibleChanges.baseCommit, visibleChanges.baseRef, whitespace]);

  const onVisiblePathChange = useCallback((path: string) => {
    if (path !== selectedPathRef.current) onSelect(path);
  }, [onSelect]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setSplitAvailable(entry.contentRect.width >= 760));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const scrollToFile = (path: string) => {
    if (isCollapsed(path)) toggleCollapsed(path);
    onSelect(path);
    streamRef.current?.scrollToPath(path);
  };

  const cycleFile = (offset: -1 | 1) => {
    if (filteredFiles.length === 0) return;
    const current = selectedFilteredIndex < 0 ? (offset < 0 ? 0 : -1) : selectedFilteredIndex;
    const next = (current + offset + filteredFiles.length) % filteredFiles.length;
    const file = filteredFiles[next];
    if (file) scrollToFile(file.path);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isTypingTarget(event.target) && !event.defaultPrevented) {
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
    clientStorage.set(SIDEBAR_OPEN_KEY, String(open));
  };

  const setSidebarWidth = (width: number) => {
    const bounded = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
    setSidebarWidthState(bounded);
    clientStorage.set(SIDEBAR_WIDTH_KEY, String(bounded));
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
      setDiffs(new Map());
      setDiffErrors(new Map());
      setReviewState(readReviewState(workspaceKey, nextScope));
      setToggledFiles(new Set());
      setFilter("");
      if (next.files[0]) onSelect(next.files[0].path);
    } catch (error) {
      setScopeError(error instanceof Error ? error.message : "Could not load branch changes.");
    } finally {
      setLoadingScope(false);
    }
  };

  const readPaths = useMemo(() => new Set(reviewState.readPaths), [reviewState.readPaths]);
  const worktreeActions = fileActions && !noCommit && scope === "worktree" ? fileActions : undefined;
  const stagedCount = scope === "worktree" ? paged.files.filter((file) => file.staged).length : 0;
  const visibleReadCount = paged.files.filter((file) => readPaths.has(file.path)).length;

  const toggleRead = (path: string) => updateReviewState((current) => ({
    ...current,
    readPaths: current.readPaths.includes(path)
      ? current.readPaths.filter((entry) => entry !== path)
      : [...current.readPaths, path],
  }));

  const loadMore = (path: string) => {
    const diff = diffs.get(path);
    if (!diff?.truncated || diff.nextHunkOffset === undefined) return;
    const options: DiffLoadOptions = {
      hunkOffset: diff.nextHunkOffset,
      hunkLimit: 40,
      contextLines,
      ...whitespace,
      ...(readOnly ? {} : { scope, baseRef: visibleChanges.baseRef, baseCommit: visibleChanges.baseCommit }),
    };
    void loadDiff(path, options)
      .then((next) => setDiffs((current) => new Map(current).set(path, { ...next, hunks: [...diff.hunks, ...next.hunks] })))
      .catch((error) => setDiffErrors((current) => new Map(current).set(path, error instanceof Error ? error.message : "Could not load more diff hunks.")));
  };

  const scopeTitle = readOnly
    ? checkpointTitle ?? "Turn changes"
    : scope === "branch" ? "Branch changes" : "Working tree";
  const effectiveMode = splitAvailable ? mode : "unified";
  // One flat row model over every file, so the review renders a single window
  // instead of every line of every diff.
  const streamRows = useMemo<DiffStreamRow[]>(() => paged.files.flatMap((file) => {
    const diff = diffs.get(file.path);
    const error = diffErrors.get(file.path);
    return [
      { kind: "file", key: `${file.path}\0header`, path: file.path, file, ...(diff ? { diff } : {}) } satisfies DiffStreamRow,
      ...isCollapsed(file.path) ? [] : fileDiffRows(file.path, diff, { collapsible: true, ...(error ? { error } : {}) }),
      { kind: "separator", key: `${file.path}\0end`, path: "" } satisfies DiffStreamRow,
    ];
  }), [diffErrors, diffs, isCollapsed, paged.files]);
  const allCollapsed = paged.files.length > 0 && paged.files.every((file) => isCollapsed(file.path));
  const setAllCollapsed = (collapsed: boolean) => setToggledFiles(collapsed === filesStartCollapsed
    ? new Set()
    : new Set(paged.files.map((file) => file.path)));
  const streamLanguages = useMemo(
    () => [...new Set(paged.files.map((file) => diffLanguage(file.path)).filter((language): language is string => language !== undefined))],
    [paged.files],
  );
  const renderFileHeader = useCallback((file: UiChangedFile, diff?: UiFileDiff) => <header className="review-file-header">
    <button
      className="icon-button compact review-file-fold"
      aria-label={`${isCollapsed(file.path) ? "Expand" : "Collapse"} ${file.path}`}
      aria-expanded={!isCollapsed(file.path)}
      onClick={() => toggleCollapsed(file.path)}
    >{isCollapsed(file.path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
    <span className={`review-file-status ${file.status}`}>{file.status.charAt(0).toUpperCase()}</span>
    <FileKindIcon name={file.name} />
    <strong>{file.name}</strong>
    {file.directory ? <span>{file.directory}</span> : null}
    <span className="spacer" />
    <span className="stat-add">+{diff?.added ?? file.added}</span>
    <span className="stat-del">−{diff?.removed ?? file.removed}</span>
    {editor ? <button className="icon-button compact" aria-label={`Open ${file.path} in ${editor.name}`} title={`Open in ${editor.name}`} onClick={() => onOpenInEditor(file.path)}><ExternalLink size={12} /></button> : null}
  </header>, [editor, isCollapsed, onOpenInEditor, toggleCollapsed]);
  const generateCommitMessage = async () => {
    if (!suggestCommitMessage || generatingMessage) return;
    setGeneratingMessage(true);
    setMessageError(undefined);
    try {
      const next = await suggestCommitMessage(visibleChanges, [...diffs.values()]);
      if (next) setMessage(next);
    } catch (error) {
      setMessageError(`No suggestion: ${error instanceof Error ? error.message : "the model did not answer."}`);
      setMessage((current) => current || visibleChanges.proposedMessage || "");
    } finally {
      setGeneratingMessage(false);
    }
  };
  const suggestionFingerprint = `${scope}:${visibleChanges.baseCommit ?? ""}:${paged.files.map((file) => `${file.path}:${file.added}:${file.removed}`).join("|")}`;
  useEffect(() => {
    if (embedded || noCommit || !autoSuggestCommitMessage || !suggestCommitMessage || paged.files.length === 0 || diffs.size + diffErrors.size < paged.files.length) return;
    if (suggestedFingerprintRef.current === suggestionFingerprint) return;
    suggestedFingerprintRef.current = suggestionFingerprint;
    void generateCommitMessage();
  }, [embedded, autoSuggestCommitMessage, diffErrors.size, diffs.size, paged.files.length, noCommit, suggestionFingerprint, suggestCommitMessage]);

  const scopeControls = !readOnly && loadChanges ? <div className="review-scope toggle-group" aria-label="Review scope">
        <button className={scope === "worktree" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("worktree")}>Working tree</button>
        <button className={scope === "branch" ? "active" : ""} disabled={loadingScope} onClick={() => void switchScope("branch")}>Branch vs target</button>
        {scopeError ? <div className="review-scope-popover" role="alert">
          <span>{scopeError}</span>
          <button className="icon-button compact" aria-label="Dismiss comparison error" onClick={() => setScopeError(undefined)}><X size={12} /></button>
        </div> : null}
      </div> : null;

  const reviewToolbar = <header className="review-toolbar">
          {embedded ? scopeControls : null}
          <span className="review-scope-summary">
            {!embedded ? <strong>{scopeTitle}</strong> : null}
            {!embedded || scope === "branch" ? <small>{readOnly ? "Before turn → after turn" : visibleChanges.baseRef ? `${visibleChanges.branch ?? "Branch"} → ${visibleChanges.baseRef}` : `${visibleChanges.branch ?? "Detached HEAD"} · uncommitted`}</small> : null}
            {visibleChanges.request ? (
              <a
                className="review-request"
                href={visibleChanges.request.url}
                target="_blank"
                rel="noreferrer"
                title={`${visibleChanges.request.title} · opens in the browser`}
              >
                {visibleChanges.request.provider === "github" ? "PR" : "MR"} #{visibleChanges.request.number}
              </a>
            ) : null}
            <span className="stat-add">+{visibleChanges.added}</span>
            <span className="stat-del">−{visibleChanges.removed}</span>
          </span>
          <div className="review-file-navigation">
            <button className="icon-button" aria-label="Previous changed file" disabled={filteredFiles.length === 0} onClick={() => cycleFile(-1)}><ChevronLeft size={15} /></button>
            <button className="icon-button" aria-label="Next changed file" disabled={filteredFiles.length === 0} onClick={() => cycleFile(1)}><ChevronRight size={15} /></button>
          </div>
          <span className="spacer" />
          {toolbar}
          {!embedded ? <button
            className="icon-button review-fold-all"
            aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
            title={allCollapsed ? "Expand all files" : "Collapse all files"}
            disabled={paged.files.length === 0}
            onClick={() => setAllCollapsed(!allCollapsed)}
          >{allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}</button> : null}
          {onWordWrapChange ? <button
            className={`icon-button review-wrap-action ${wordWrap ? "active" : ""}`}
            aria-pressed={wordWrap}
            aria-label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            title={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            disabled={paged.files.length === 0}
            onClick={() => onWordWrapChange(!wordWrap)}
          ><WrapText size={14} /></button> : null}
          {!embedded && onIgnoreWhitespaceChange ? <button
            className={`text-button review-whitespace-action ${ignoreWhitespace ? "active" : ""}`}
            aria-pressed={ignoreWhitespace}
            title={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            disabled={paged.files.length === 0}
            onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
          >Ignore whitespace</button> : null}
          {!embedded ? <div className="toggle-group" aria-label="Diff context">
            <button disabled={paged.files.length === 0} className={contextMode === "collapse" ? "active" : ""} onClick={() => setContextMode("collapse")}>Diff only</button>
            <button disabled={paged.files.length === 0} className={contextMode === "expand" ? "active" : ""} onClick={() => setContextMode("expand")}>All lines</button>
          </div> : null}
          <div className="toggle-group" aria-label="Diff layout">
            <button disabled={paged.files.length === 0} className={effectiveMode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
            <button className={effectiveMode === "split" ? "active" : ""} disabled={paged.files.length === 0 || !splitAvailable} title={!splitAvailable ? "Split view needs more width" : undefined} onClick={() => setMode("split")}>Split</button>
          </div>
          {!embedded && editor && selectedPath ? <button className="text-button review-editor-action" onClick={() => onOpenInEditor(selectedPath)}>
            Open in {editor.name} <ExternalLink size={11} />
          </button> : null}
          <button
            className={`icon-button review-sidebar-toggle ${sidebarOpen ? "active" : ""}`}
            title="Toggle file tree"
            aria-label="Toggle file tree"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >{sidebarOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button>
        </header>;

  return <div className={`review-shell${embedded ? " review-embedded" : ""}`}>
    {embedded ? null : <header className="title-bar">
      <WindowControlsInset />
      <button className="chrome-button" onClick={onBack}><ArrowLeft size={13} /> Back to thread</button>
      <span className="review-title-divider" />
      <div className="title-identity">
        <strong>{visibleChanges.branch ?? "review"}</strong>
        <span>review · {paged.fileCount} {paged.fileCount === 1 ? "file" : "files"}</span>
      </div>
      {scopeControls}
      <div className="title-spacer" />
      {!noCommit && scope === "worktree" ? null : deviceReadOnly && !readOnly && scope === "worktree"
        ? <span className="review-read-only">Read only</span>
        : readOnly
        ? <span className="review-read-only">Historical turn</span>
        : <span className="review-read-only">Committed branch diff</span>}
    </header>}

    {!embedded && paged.fileCount > 0 && !noCommit && scope === "worktree" ? <section className="commit-bar" aria-label="Commit">
      <div className="commit-bar-message">
        <textarea
          aria-label="Commit message"
          placeholder={generatingMessage ? "Writing from the diff…" : "Commit message"}
          value={generatingMessage ? "" : message}
          disabled={generatingMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
        {suggestCommitMessage ? <button className="icon-button compact" aria-label="Generate commit message" title="Write a new message from the diff" disabled={generatingMessage} onClick={() => void generateCommitMessage()}><RefreshCw className={generatingMessage ? "spinning" : ""} size={12} /></button> : null}
      </div>
      <div className="commit-bar-actions">
        <div className="commit-actions">
          {primaryPush ? <button disabled={busy || generatingMessage || message.trim().length === 0} onClick={() => onCommit(message, false)}>Commit only</button> : null}
          <button className="primary" disabled={busy || generatingMessage || message.trim().length === 0} onClick={() => onCommit(message, primaryPush)}>
            <GitCommitHorizontal size={13} /> {busy ? "Working…" : primaryPush ? "Commit & push" : "Commit"}
          </button>
        </div>
        <small>{commitSummary(paged.fileCount, visibleChanges.branch, primaryPush, stagedCount)}</small>
        {messageError ? <small className="commit-message-error">{messageError}</small> : null}
      </div>
    </section> : null}

    {embedded ? reviewToolbar : null}
    <div className="review-body">
      <main className="review-stage" ref={stageRef}>
        {embedded ? null : reviewToolbar}

        <div className="review-stage-content">
          <div className="review-diff-stream" ref={diffScrollRef}>
            {paged.files.length === 0 ? <div className="diff-empty">No changes in this scope.</div> : <DiffStream
              ref={streamRef}
              rows={streamRows}
              mode={effectiveMode}
              scrollRef={diffScrollRef}
              languages={streamLanguages}
              {...(selectedPath ? { activePath: selectedPath } : {})}
              {...(lines ? { lines } : {})}
              onExpandContext={() => setContextMode("expand")}
              onLoadMore={loadMore}
              renderFileHeader={renderFileHeader}
              onVisiblePathChange={onVisiblePathChange}
              wrap={wordWrap}
            />}
          </div>
          {aside}
        </div>
      </main>

      {sidebarOpen ? <aside className="review-list" style={{ width: sidebarWidth }}>
        <div className="review-sidebar-resizer" role="separator" aria-orientation="vertical" onPointerDown={startSidebarResize} />
        {!embedded && listHeader && !readOnly ? <div className="review-list-header">{listHeader({ message, committed: () => setMessage("") })}</div> : null}
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
          {!readOnly && visibleChanges.refreshStatus?.state === "error" ? <small className="review-stale" title={visibleChanges.refreshStatus.message}>stale</small> : null}
          {onRefresh && !readOnly ? <button className="icon-button compact" aria-label="Rescan changes" title="Read the worktree's changes again" onClick={onRefresh}><RefreshCw size={12} /></button> : null}
        </div>
        {worktreeActions && paged.files.length > 0 ? <div className="review-staging">
          <span>{stagedCount}/{paged.fileCount} staged</span>
          {worktreeActions.stageAll && stagedCount < paged.fileCount ? <button className="text-button" disabled={busy} onClick={() => void worktreeActions.stageAll?.()}>Stage all</button> : null}
        </div> : null}
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
            onOpen={scrollToFile}
            onToggleViewed={toggleRead}
            {...(worktreeActions ? { fileActions: worktreeActions } : {})}
          /> : <p className="empty-copy">{filter ? "No matching changed files." : "No changes in this scope."}</p>}
          {loadFiles && paged.hasMore ? <div className="changed-files-more-row">
            <button className="text-button" disabled={paged.loading} onClick={() => void paged.loadNextPage()}>
              {paged.loading ? "Loading…" : `Load more (${Math.max(0, paged.fileCount - paged.files.length)} remaining)`}
            </button>
            {paged.error ? <small className="file-tree-error">{paged.error}</small> : null}
          </div> : null}
        </div>
      </aside> : null}
    </div>
  </div>;
}
