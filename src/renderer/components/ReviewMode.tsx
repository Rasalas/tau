import { useEffect, useState } from "react";
import { WindowControlsInset } from "./WindowControlsInset";
import { ArrowLeft, ExternalLink, GitCommitHorizontal } from "lucide-react";
import type { DiffLoadOptions, UiEditor, UiFileDiff, UiWorkspaceChanges, UiWorkspaceChangesPage } from "../../shared/contracts";
import { DiffView } from "./DiffView";
import { VirtualList } from "./VirtualList";
import { usePagedWorkspaceFiles } from "./usePagedWorkspaceFiles";

const STATUS_GLYPH: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

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
  /** Loads the next bounded historical file-list page, when available. */
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  /** Historical turn diffs are inspect-only and must not offer workspace commits. */
  readOnly?: boolean;
  checkpointTitle?: string;
}) {
  const [diff, setDiff] = useState<UiFileDiff>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [message, setMessage] = useState(changes.proposedMessage ?? "");
  const [editingMessage, setEditingMessage] = useState(false);
  const { files, fileCount, hasMore: hasMoreFiles, loading: loadingFiles, error: fileLoadError, loadNextPage: loadNextFiles } = usePagedWorkspaceFiles(changes, loadFiles);

  useEffect(() => {
    if (!selectedPath) { setDiff(undefined); return; }
    let cancelled = false;
    setDiff(undefined);
    void loadDiff(selectedPath, { hunkLimit: 40 }).then((next) => { if (!cancelled) setDiff(next); });
    return () => { cancelled = true; };
  }, [loadDiff, selectedPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingMessage) onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingMessage, onBack]);

  return (
    <div className="review-shell">
      <header className="title-bar">
        <WindowControlsInset />
        <button className="chrome-button" onClick={onBack}><ArrowLeft size={13} /> Back to thread</button>
        <span style={{ width: 1, height: 16, background: "var(--line)" }} />
        <div className="title-identity">
          <strong>{changes.branch ?? "review"}</strong>
          <span>review · {fileCount} {fileCount === 1 ? "file" : "files"}</span>
        </div>
        <div className="title-spacer" />
        {!readOnly ? <button
            className="chrome-button accent"
            disabled={busy || fileCount === 0 || message.trim().length === 0}
            onClick={() => onCommit(message, primaryPush)}
          >
            <GitCommitHorizontal size={13} /> {busy ? "Working…" : primaryPush ? "Commit & push" : "Commit"}
          </button> : <span className="review-read-only">Historical turn</span>}
      </header>

      <div className="review-body">
        <div className="review-list">
          <header>
            <h2>{readOnly ? checkpointTitle ?? "Turn changes" : "Changes"}</h2>
            <small>{changes.branch ?? "detached"}</small>
            <span className="spacer" />
            <span className="stat-add">+{changes.added}</span>
            <span className="stat-del">−{changes.removed}</span>
          </header>
          <div className="review-files">
            {changes.completeness === "partial" ? <p className="file-tree-error changed-files-warning">
              {changes.incompleteReason ?? "Snapshot coverage is partial; some workspace changes may be omitted."}
              {changes.omittedFileCount ? ` (${changes.omittedFileCount} file${changes.omittedFileCount === 1 ? "" : "s"} omitted)` : ""}
            </p> : null}
            <VirtualList
              items={files}
              itemHeight={43}
              className="review-files-virtual"
              empty={<p className="empty-copy">{changes.completeness === "partial" ? "No fully captured file entries are available." : "The worktree is clean."}</p>}
              renderItem={(file) => <button
                key={file.path}
                className={`review-file ${file.path === selectedPath ? "active" : ""}`}
                onClick={() => onSelect(file.path)}
              >
                <i>{STATUS_GLYPH[file.status] ?? "M"}</i>
                <span className="meta"><strong>{file.name}</strong><small>{(file.note ?? file.directory) || "."}</small></span>
                <span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
              </button>}
            />
            {fileCount === 0 ? <p className="empty-copy">{changes.completeness === "partial" ? "No fully captured file entries are available." : "The worktree is clean."}</p> : null}
            {loadFiles && hasMoreFiles ? <div className="changed-files-more-row">
              <button className="text-button" disabled={loadingFiles} onClick={() => void loadNextFiles()}>
                {loadingFiles ? "Loading…" : `Load more (${Math.max(0, fileCount - files.length)} remaining)`}
              </button>
              {fileLoadError ? <small className="file-tree-error">{fileLoadError}</small> : null}
            </div> : null}

            {fileCount > 0 && !readOnly ? (
              <div className="commit-proposal">
                Commit message: {editingMessage ? null : <em>“{message || "none"}”</em>}
                {editingMessage ? (
                  <textarea
                    autoFocus
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onBlur={() => setEditingMessage(false)}
                  />
                ) : null}
                <div className="commit-actions">
                  <button
                    className="primary"
                    disabled={busy || message.trim().length === 0}
                    onClick={() => onCommit(message, false)}
                  >
                    Commit
                  </button>
                  <button onClick={() => setEditingMessage((value) => !value)}>
                    {editingMessage ? "Done" : "Edit"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="review-stage">
          <header>
            <strong>{selectedPath ?? "Select a file"}</strong>
            {diff ? <span className="stat-add">+{diff.added}</span> : null}
            {diff ? <span className="stat-del">−{diff.removed}</span> : null}
            <span className="spacer" />
            <div className="toggle-group">
              <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
              <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
            </div>
            {editor && selectedPath ? (
              <button className="text-button" onClick={() => onOpenInEditor(selectedPath)}>
                Open in {editor.name} <ExternalLink size={11} />
              </button>
            ) : null}
          </header>
          {selectedPath ? <DiffView
            diff={diff}
            mode={mode}
            onLoadMore={diff?.truncated && diff.nextHunkOffset !== undefined ? () => {
              void loadDiff(selectedPath, { hunkOffset: diff.nextHunkOffset, hunkLimit: 40 }).then((next) => {
                setDiff((current) => current ? { ...next, hunks: [...current.hunks, ...next.hunks], truncated: next.truncated, nextHunkOffset: next.nextHunkOffset } : next);
              });
            } : undefined}
          /> : <div className="diff-empty">Pick a file to review.</div>}
        </div>
      </div>
    </div>
  );
}
