import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FileNode } from "../../shared/contracts";
import { VirtualList } from "../components/VirtualList";
import { FileKindIcon } from "../components/FileKindIcon";
import type { PanelProps } from "../extension-system";
import { useChanges, useFiles } from "../workbench-context";

interface FlatNode { node: FileNode; depth: number; }

function FileTree({ nodes, changedPaths, cwd, loadFiles }: {
  nodes: FileNode[];
  changedPaths: Set<string>;
  cwd?: string;
  loadFiles(path: string): Promise<FileNode[]>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const visible = useMemo(() => {
    const result: FlatNode[] = [];
    const visit = (entries: FileNode[], depth: number) => entries.forEach((node) => {
      result.push({ node, depth });
      if (node.kind === "directory" && expanded.has(node.path) && node.children) visit(node.children, depth + 1);
    });
    visit(nodes, 0);
    return result;
  }, [expanded, nodes]);

  const toggle = async (node: FileNode) => {
    if (node.kind !== "directory") return;
    if (expanded.has(node.path)) {
      setExpanded((current) => { const next = new Set(current); next.delete(node.path); return next; });
      return;
    }
    setExpanded((current) => new Set(current).add(node.path));
    if (node.children || loading.has(node.path)) return;
    setLoading((current) => new Set(current).add(node.path));
    try {
      await loadFiles(node.path);
      setErrors((current) => { const next = new Map(current); next.delete(node.path); return next; });
    } catch (error) {
      setErrors((current) => new Map(current).set(node.path, error instanceof Error ? error.message : "Could not load directory."));
    } finally {
      setLoading((current) => { const next = new Set(current); next.delete(node.path); return next; });
    }
  };

  return <VirtualList
    items={visible}
    itemHeight={30}
    className="file-tree"
    empty={<p className="empty-copy">No files indexed.</p>}
    renderItem={({ node, depth }) => {
      const relative = cwd && node.path.startsWith(cwd) ? node.path.slice(cwd.length + 1) : node.path;
      const changed = changedPaths.has(relative);
      const pending = loading.has(node.path);
      const open = node.kind === "directory" && expanded.has(node.path);
      return <div key={node.path}>
        <button
          className={`file-row ${node.kind} ${changed ? "selected" : ""}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => void toggle(node)}
          title={node.path}
        >
          <span className="file-disclosure">{node.kind === "directory" ? (pending ? "…" : open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}</span>
          <span className="file-kind-icon"><FileKindIcon name={node.name} directory={node.kind === "directory"} open={open} /></span>
          <span className="name">{node.name}</span>
          {changed ? <em>M</em> : null}
        </button>
        {errors.get(node.path) ? <small className="file-tree-error">{errors.get(node.path)}</small> : null}
      </div>;
    }}
  />;
}

export function FilesPanel({ active, extensionName }: PanelProps) {
  const { fileTree, refreshFiles, loadFiles, snapshot } = useFiles();
  const { changes } = useChanges();
  useEffect(() => { if (active) void refreshFiles(); }, [active, refreshFiles, snapshot?.cwd]);
  const changedPaths = useMemo(() => new Set(changes.files.map((file) => file.path)), [changes.files]);

  return <section className="panel-body">
    <header className="panel-header">
      <h2>Files</h2>
      <small>{extensionName.toLowerCase()}</small>
      <span className="spacer" />
      <button className="text-button" onClick={() => void refreshFiles()}>refresh</button>
    </header>
    <FileTree nodes={fileTree} changedPaths={changedPaths} cwd={snapshot?.cwd} loadFiles={loadFiles} />
  </section>;
}

export function ChangesPanel({ active, extensionName }: PanelProps) {
  const { changes, refreshChanges, openReview, snapshot } = useChanges();
  useEffect(() => { if (active) void refreshChanges(); }, [active, refreshChanges, snapshot?.cwd]);

  return <section className="panel-body">
    <header className="panel-header">
      <h2>Changes</h2>
      <small>{extensionName.toLowerCase()}</small>
      <span className="spacer" />
      {changes.refreshStatus?.state === "error" ? <small title={changes.refreshStatus.message}>stale · refresh failed</small> : null}
      <button className="text-button" onClick={() => void refreshChanges()}>rescan</button>
    </header>
    {changes.files.length === 0 ? <p className="empty-copy">The worktree is clean.</p> : <>
      <VirtualList
        items={changes.files}
        itemHeight={43}
        className="review-files"
        renderItem={(file) => <button className="review-file" key={file.path} onClick={() => openReview(file.path)}>
          <i>{file.status.charAt(0).toUpperCase()}</i>
          <span className="meta"><strong>{file.name}</strong><small>{file.directory || "."}</small></span>
          <span className="stat-add">+{file.added}</span>
          <span className="stat-del">−{file.removed}</span>
        </button>}
      />
      <div className="commit-proposal"><div className="commit-actions"><button className="primary" onClick={() => openReview()}>Open review</button></div></div>
    </>}
  </section>;
}
