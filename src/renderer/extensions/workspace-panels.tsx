import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FileNode } from "../../shared/workspace-kit-types";
import { VirtualList } from "../components/VirtualList";
import { FileKindIcon } from "../components/FileKindIcon";
import type { PanelProps } from "../extension-system";
import { useWorkbench } from "../workbench-context";
import { useWorkspaceKit } from "./workspace-store";
import { useWorkspaceStore } from "../renderer-services-context";

interface FlatNode { node: FileNode; depth: number; }

function FileTree({ nodes, changedPaths, activePath, loadFiles, openFile }: {
  nodes: FileNode[];
  changedPaths: Set<string>;
  activePath?: string;
  loadFiles(path: string): Promise<FileNode[]>;
  openFile(path: string, options?: { pin?: boolean }): void;
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
    if (node.kind !== "directory") { openFile(node.path); return; }
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
      // Nodes and changed files are both named relative to the workspace root.
      const changed = changedPaths.has(node.path);
      const pending = loading.has(node.path);
      const open = node.kind === "directory" && expanded.has(node.path);
      const active = node.kind === "file" && node.path === activePath;
      return <div key={node.path}>
        <button
          className={`file-row ${node.kind} ${changed ? "selected" : ""} ${active ? "active" : ""}`}
          style={{ marginLeft: `${depth * 16}px`, width: `calc(100% - ${depth * 16}px)` }}
          aria-current={active ? "true" : undefined}
          onClick={() => void toggle(node)}
          onDoubleClick={() => { if (node.kind === "file") openFile(node.path, { pin: true }); }}
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
  const workspaceStore = useWorkspaceStore();
  const { fileTree, changes, cwd } = useWorkspaceKit();
  const { openFile, activeDocumentPath: activePath } = useWorkbench();
  const refreshFiles = () => workspaceStore.refreshFiles();
  const loadFiles = (path: string) => workspaceStore.loadFiles(path);
  useEffect(() => { if (active) void workspaceStore.refreshFiles(); }, [active, cwd, workspaceStore]);
  const changedPaths = useMemo(() => new Set(changes.files.map((file) => file.path)), [changes.files]);

  return <section className="panel-body">
    <header className="panel-header">
      <h2>Files</h2>
      <small>{extensionName.toLowerCase()}</small>
      <span className="spacer" />
      <button className="text-button" onClick={() => void refreshFiles()}>refresh</button>
    </header>
    <FileTree nodes={fileTree} changedPaths={changedPaths} activePath={activePath} loadFiles={loadFiles} openFile={openFile} />
  </section>;
}
