import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw } from "lucide-react";
import type { UiChangedFile } from "../../shared/workspace-kit-types";
import { FileKindIcon } from "./FileKindIcon";
import { useHostCapabilities } from "../use-host-capabilities";

interface DirectoryNode {
  kind: "directory";
  path: string;
  name: string;
  children: ChangeNode[];
}

interface FileNode {
  kind: "file";
  path: string;
  file: UiChangedFile;
}

type ChangeNode = DirectoryNode | FileNode;

export function buildChangesTree(files: readonly UiChangedFile[]): ChangeNode[] {
  const root: DirectoryNode = { kind: "directory", path: "", name: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      let directory = parent.children.find((node): node is DirectoryNode => node.kind === "directory" && node.path === path);
      if (!directory) {
        directory = { kind: "directory", path, name: part, children: [] };
        parent.children.push(directory);
      }
      parent = directory;
    }
    parent.children.push({ kind: "file", path: file.path, file });
  }
  const sort = (nodes: ChangeNode[]): void => {
    nodes.sort((left, right) => left.kind === right.kind
      ? left.path.localeCompare(right.path)
      : left.kind === "directory" ? -1 : 1);
    nodes.forEach((node) => { if (node.kind === "directory") sort(node.children); });
  };
  sort(root.children);
  return root.children;
}

function directoryPaths(nodes: readonly ChangeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "directory" ? [node.path, ...directoryPaths(node.children)] : []);
}

export function ChangesTree({ files, activePath, onOpen, onStage, onUnstage, onRevert }: {
  files: readonly UiChangedFile[];
  activePath?: string;
  onOpen(path: string): void;
  onStage(path: string): Promise<void> | void;
  onUnstage(path: string): Promise<void> | void;
  onRevert(path: string): Promise<void> | void;
}) {
  const tree = useMemo(() => buildChangesTree(files), [files]);
  // A Read-only device looks; staging and reverting are the host's to refuse (ADR 0024).
  const { readOnly } = useHostCapabilities();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(directoryPaths(tree)));
  const [busy, setBusy] = useState<string>();
  const [confirmRevert, setConfirmRevert] = useState<string>();
  const run = async (path: string, action: (path: string) => Promise<void> | void) => {
    setBusy(path);
    try { await action(path); } finally { setBusy(undefined); setConfirmRevert(undefined); }
  };
  const render = (nodes: readonly ChangeNode[], depth = 0): ReactNode => nodes.map((node) => {
    if (node.kind === "directory") {
      const open = expanded.has(node.path);
      return <div key={node.path} className="changes-tree-group">
        <button className="changes-tree-directory" style={{ paddingLeft: 10 + depth * 15 }} onClick={() => setExpanded((current) => {
          const next = new Set(current);
          if (open) next.delete(node.path); else next.add(node.path);
          return next;
        })}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileKindIcon name={node.name} directory open={open} />
          <span>{node.name}</span>
          <small>{node.children.length}</small>
        </button>
        {open ? render(node.children, depth + 1) : null}
      </div>;
    }
    const { file } = node;
    const waiting = busy === file.path;
    const confirming = confirmRevert === file.path;
    return <div key={file.path} className={`changes-tree-file ${file.path === activePath ? "active" : ""}`} style={{ paddingLeft: 27 + depth * 15 }}>
      <button className="changes-tree-open" title={file.path} onClick={() => onOpen(file.path)}>
        <FileKindIcon name={file.name} />
        <span className="changes-tree-name"><strong>{file.name}</strong></span>
        <i>{file.status.charAt(0).toUpperCase()}</i>
        <span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
      </button>
      {readOnly ? null : <span className="changes-tree-actions">
        <button disabled={waiting} title={file.staged ? "Unstage file" : "Stage file"} aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`} onClick={() => void run(file.path, file.staged ? onUnstage : onStage)}>
          {file.staged ? <Minus size={14} /> : <Plus size={14} />}
        </button>
        <button disabled={waiting} title="Revert file" aria-label={`Revert ${file.path}`} onClick={() => setConfirmRevert(file.path)}><RotateCcw size={13} /></button>
        {confirming ? <div className="changes-action-popover" role="dialog" aria-label={`Confirm revert ${file.path}`}>
          <strong>Discard this file?</strong><small>This cannot be undone.</small>
          <span><button onClick={() => setConfirmRevert(undefined)}>Cancel</button><button className="danger" onClick={() => void run(file.path, onRevert)}>Revert</button></span>
        </div> : null}
      </span>}
    </div>;
  });

  return <div className="changes-tree">{render(tree)}</div>;
}
