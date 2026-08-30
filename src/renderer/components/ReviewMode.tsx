import { useEffect, useState } from "react";
import { WindowControlsInset } from "./WindowControlsInset";
import { ArrowLeft, ExternalLink, GitCommitHorizontal } from "lucide-react";
import type { DiffLoadOptions, UiEditor, UiFileDiff, UiWorkspaceChanges } from "../../shared/contracts";
import { DiffView } from "./DiffView";
import { VirtualList } from "./VirtualList";

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
  onSelect,
  onBack,
  onCommit,
  onOpenInEditor,
  loadDiff,
}: {
  changes: UiWorkspaceChanges;
  selectedPath?: string;
  editor?: UiEditor;
  busy: boolean;
  onSelect(path: string): void;
  onBack(): void;
  onCommit(message: string, push: boolean): void;
  onOpenInEditor(path: string): void;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
}) {
  const [diff, setDiff] = useState<UiFileDiff>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [message, setMessage] = useState(changes.proposedMessage ?? "");
  const [editingMessage, setEditingMessage] = useState(false);

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
          <span>review · {changes.files.length} {changes.files.length === 1 ? "file" : "files"}</span>
        </div>
        <div className="title-spacer" />
        <button
          className="chrome-button accent"
          disabled={busy || changes.files.length === 0 || message.trim().length === 0}
          onClick={() => onCommit(message, true)}
        >
          <GitCommitHorizontal size={13} /> {busy ? "Working…" : "Commit & push"}
        </button>
      </header>

      <div className="review-body">
        <div className="review-list">
          <header>
            <h2>Changes</h2>
            <small>{changes.branch ?? "detached"}</small>
            <span className="spacer" />
            <span className="stat-add">+{changes.added}</span>
            <span className="stat-del">−{changes.removed}</span>
          </header>
          <div className="review-files">
            <VirtualList
              items={changes.files}
              itemHeight={43}
              className="review-files-virtual"
              empty={<p className="empty-copy">The worktree is clean.</p>}
              renderItem={(file) => <button
                key={file.path}
                className={`review-file ${file.path === selectedPath ? "active" : ""}`}
                onClick={() => onSelect(file.path)}
              >
                <i>{STATUS_GLYPH[file.status] ?? "M"}</i>
                <span className="meta"><strong>{file.name}</strong><small>{file.directory || "."}</small></span>
                <span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
              </button>}
            />
            {changes.files.length === 0 ? <p className="empty-copy">The worktree is clean.</p> : null}

            {changes.files.length > 0 ? (
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
