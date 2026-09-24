import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { ChangesTree, FileKindIcon, useHostCapabilities, useWorkbench, VirtualList, type FileNode, type PanelProps } from "tau";
import { relativeHostPath } from "./host-paths.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";

interface FlatNode { node: FileNode; depth: number; }

function FileTree({ nodes, changedPaths, activePath, loadFiles, openFile, editFile }: {
  nodes: FileNode[];
  changedPaths: Set<string>;
  activePath?: string;
  loadFiles(path: string): Promise<FileNode[]>;
  openFile(path: string, options?: { pin?: boolean }): void;
  /** A kit that edits files takes the double-click; false leaves it to the stage. */
  editFile(path: string): boolean;
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
          onDoubleClick={() => { if (node.kind === "file" && !editFile(node.path)) openFile(node.path, { pin: true }); }}
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
    <FileTree nodes={fileTree} changedPaths={changedPaths} activePath={activePath} loadFiles={loadFiles} openFile={openFile} editFile={(path) => workspaceStore.editFile(path)} />
  </section>;
}

export function ChangesPanel({ active, extensionName, actions }: PanelProps) {
  const workspaceStore = useWorkspaceStore();
  const { changes, committing, pushPrimary, commitFocusToken, cwd, workspace, changesSections } = useWorkspaceKit();
  const { activeDocumentPath: activePath } = useWorkbench();
  const snapshot = useMemo(() => cwd ? { cwd } : undefined, [cwd]);
  const canPush = Boolean(workspace?.upstream);
  const refreshChanges = () => workspaceStore.refreshChanges();
  const openReview = (path?: string) => workspaceStore.openReview(path);
  const openDiff = (path: string) => workspaceStore.openDiff(path);
  const stageFile = (path: string) => workspaceStore.stageFile(path);
  const unstageFile = (path: string) => workspaceStore.unstageFile(path);
  const stageAll = () => workspaceStore.stageAll();
  const revertFile = (path: string) => workspaceStore.revertFile(path);
  const commit = (message: string, push: boolean) => workspaceStore.commit(message, push);
  useEffect(() => { if (active) void workspaceStore.refreshChanges(); }, [active, cwd, workspaceStore]);
  const [message, setMessage] = useState(changes.proposedMessage ?? "");
  const [dirty, setDirty] = useState(false);
  // Follow the host's proposal until the user types; a commit resets to following.
  useEffect(() => { if (!dirty) setMessage(changes.proposedMessage ?? ""); }, [changes.proposedMessage, dirty]);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const { readOnly } = useHostCapabilities();
  useEffect(() => { if (commitFocusToken > 0 && active) messageRef.current?.focus(); }, [active, commitFocusToken]);

  const canCommit = !committing && changes.files.length > 0 && message.trim().length > 0;
  const stagedCount = changes.files.filter((file) => file.staged).length;
  const allStaged = stagedCount === changes.files.length;
  const submit = (push: boolean) => { if (canCommit) void commit(message, push).then(() => setDirty(false)); };
  const leadPush = pushPrimary && canPush;
  const activeRelative = relativeHostPath(activePath, snapshot?.cwd);

  return <section className="panel-body">
    <header className="panel-header">
      <h2>Changes</h2>
      <small>{changes.branch ?? extensionName.toLowerCase()}</small>
      <span className="spacer" />
      {changes.refreshStatus?.state === "error" ? <small title={changes.refreshStatus.message}>stale · refresh failed</small> : null}
      <button className="icon-button compact" title="Open full review" aria-label="Open full review" onClick={() => openReview()}><FileDiff size={14} /></button>
      <button className="text-button" onClick={() => void refreshChanges()}>rescan</button>
    </header>
    {changesSections.map((Section, index) => <Section key={index} actions={actions} message={message} committed={() => setDirty(false)} />)}
    {changes.files.length === 0 ? <p className="empty-copy">The worktree is clean.</p> : <>
      {readOnly ? <p className="empty-copy" role="note">This device is paired Read only: it can look at the changes, not stage, commit or revert them.</p> : <div className="commit-box">
        <div className="commit-selection"><small>{stagedCount}/{changes.files.length} staged</small>{!allStaged ? <button className="text-button" disabled={committing} onClick={() => void stageAll()}>Stage all</button> : <span>All staged</span>}</div>
        <textarea
          ref={messageRef}
          placeholder="Commit message"
          aria-label="Commit message"
          value={message}
          onChange={(event) => { setMessage(event.target.value); setDirty(true); }}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(leadPush); } }}
        />
        <div className="commit-actions">
          <button className={leadPush ? "" : "primary"} disabled={!canCommit} onClick={() => submit(false)}>
            {committing && !leadPush ? "Working…" : stagedCount ? "Commit staged" : "Commit all"}
          </button>
          {canPush ? (
            <button className={leadPush ? "primary" : ""} disabled={!canCommit} onClick={() => submit(true)}>
              {committing && leadPush ? "Working…" : stagedCount ? "Commit staged & push" : "Commit all & push"}
            </button>
          ) : null}
          <small><span className="stat-add">+{changes.added}</span> <span className="stat-del">−{changes.removed}</span></small>
        </div>
      </div>}
      <ChangesTree key={snapshot?.cwd} files={changes.files} activePath={activeRelative} onOpen={openDiff} onStage={stageFile} onUnstage={unstageFile} onRevert={revertFile} />
    </>}
  </section>;
}
