import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FileNode } from "../../shared/contracts";
import type { PanelProps } from "../extension-system";
import { useChanges, useFiles } from "../workbench-context";

function FileRow({
  node,
  depth,
  changedPaths,
  cwd,
}: {
  node: FileNode;
  depth: number;
  changedPaths: Set<string>;
  cwd?: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const relative = cwd && node.path.startsWith(cwd) ? node.path.slice(cwd.length + 1) : node.path;
  const changed = changedPaths.has(relative);

  return (
    <>
      <button
        className={`file-row ${node.kind} ${changed ? "selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => node.kind === "directory" && setOpen((value) => !value)}
        title={node.path}
      >
        <span>{node.kind === "directory" ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}</span>
        <span className="name">{node.name}</span>
        {changed ? <em>M</em> : null}
      </button>
      {open && node.children?.map((child) => (
        <FileRow key={child.path} node={child} depth={depth + 1} changedPaths={changedPaths} cwd={cwd} />
      ))}
    </>
  );
}

export function FilesPanel({ active, extensionName }: PanelProps) {
  const { fileTree, refreshFiles, snapshot } = useFiles();
  const { changes } = useChanges();
  useEffect(() => {
    if (active) void refreshFiles();
  }, [active, refreshFiles, snapshot?.cwd]);

  const changedPaths = new Set(changes.files.map((file) => file.path));

  return (
    <section className="panel-body">
      <header className="panel-header">
        <h2>Files</h2>
        <small>{extensionName.toLowerCase()}</small>
        <span className="spacer" />
        <button className="text-button" onClick={() => void refreshFiles()}>refresh</button>
      </header>
      <div className="file-tree">
        {fileTree.length
          ? fileTree.map((node) => (
              <FileRow key={node.path} node={node} depth={0} changedPaths={changedPaths} cwd={snapshot?.cwd} />
            ))
          : <p className="empty-copy">No files indexed.</p>}
      </div>
    </section>
  );
}

export function ChangesPanel({ active, extensionName }: PanelProps) {
  const { changes, refreshChanges, openReview, snapshot } = useChanges();
  useEffect(() => {
    if (active) void refreshChanges();
  }, [active, refreshChanges, snapshot?.cwd]);

  return (
    <section className="panel-body">
      <header className="panel-header">
        <h2>Changes</h2>
        <small>{extensionName.toLowerCase()}</small>
        <span className="spacer" />
        {changes.refreshStatus?.state === "error" ? <small title={changes.refreshStatus.message}>stale · refresh failed</small> : null}
        <button className="text-button" onClick={() => void refreshChanges()}>rescan</button>
      </header>
      {changes.files.length === 0 ? (
        <p className="empty-copy">The worktree is clean.</p>
      ) : (
        <div className="review-files">
          {changes.files.map((file) => (
            <button className="review-file" key={file.path} onClick={() => openReview(file.path)}>
              <i>{file.status.charAt(0).toUpperCase()}</i>
              <span className="meta">
                <strong>{file.name}</strong>
                <small>{file.directory || "."}</small>
              </span>
              <span className="stat-add">+{file.added}</span>
              <span className="stat-del">−{file.removed}</span>
            </button>
          ))}
          <div className="commit-proposal">
            <div className="commit-actions">
              <button className="primary" onClick={() => openReview()}>Open review</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
