import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { UiChangedFile } from "../../shared/workspace-kit-types";
import { buildChangesTree } from "./ChangesTree";
import { FileKindIcon } from "./FileKindIcon";

const STATUS_GLYPH: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

type ReviewTreeNode = ReturnType<typeof buildChangesTree>[number];

function directoryPaths(nodes: readonly ReviewTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory" ? [node.path, ...directoryPaths(node.children)] : [],
  );
}

function descendantFileCount(node: ReviewTreeNode): number {
  if (node.kind === "file") return 1;
  return node.children.reduce((count, child) => count + descendantFileCount(child), 0);
}

export function ReviewFileTree({
  files,
  activePath,
  viewedPaths,
  readOnly,
  onOpen,
  onToggleViewed,
}: {
  files: readonly UiChangedFile[];
  activePath?: string;
  viewedPaths: ReadonlySet<string>;
  readOnly: boolean;
  onOpen(path: string): void;
  onToggleViewed(path: string): void;
}) {
  const tree = useMemo(() => buildChangesTree(files), [files]);
  const paths = useMemo(() => directoryPaths(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(paths));

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      paths.forEach((path) => next.add(path));
      return next;
    });
  }, [paths]);

  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const render = (nodes: readonly ReviewTreeNode[], depth = 0): ReactNode => nodes.map((node) => {
    if (node.kind === "directory") {
      const open = expanded.has(node.path);
      return <div key={node.path} className="review-tree-group">
        <button
          className="review-tree-directory"
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={open}
          onClick={() => toggleDirectory(node.path)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileKindIcon name={node.name} directory open={open} />
          <span>{node.name}</span>
          <small>{descendantFileCount(node)}</small>
        </button>
        {open ? render(node.children, depth + 1) : null}
      </div>;
    }

    const { file } = node;
    const viewed = viewedPaths.has(file.path);
    return <div
      key={file.path}
      className={`review-tree-file ${file.path === activePath ? "active" : ""} ${viewed ? "viewed" : ""}`}
      style={{ paddingLeft: 25 + depth * 14 }}
    >
      <button className="review-tree-open" title={file.path} onClick={() => onOpen(file.path)}>
        <FileKindIcon name={file.name} />
        <span className="review-tree-name">{file.name}</span>
        <i className={file.status} title={file.status}>{STATUS_GLYPH[file.status] ?? "M"}</i>
      </button>
      {!readOnly ? <button
        className="review-tree-viewed"
        title={viewed ? "Mark unread" : "Mark viewed"}
        aria-label={`${viewed ? "Mark unread" : "Mark viewed"} ${file.path}`}
        onClick={() => onToggleViewed(file.path)}
      ><Check size={12} /></button> : null}
    </div>;
  });

  return <div className="review-tree" role="tree">{render(tree)}</div>;
}
