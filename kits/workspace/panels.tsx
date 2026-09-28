import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, FileDiff, PanelTop, RotateCw, Search, SquarePen } from "lucide-react";
import { ChangesTree, DiffView, FileKindIcon, tooltipProps, useHostCapabilities, useWorkbench, VirtualList, type FileNode, type PanelProps, type UiFileDiff } from "tau";
import { FileReader } from "./file-reader.js";
import { relativeHostPath } from "./host-paths.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";

interface FlatNode { node: FileNode; depth: number; }

function FileTree({ nodes, changedPaths, activePath, rowHeight, loadFiles, openFile, editFile }: {
  nodes: FileNode[];
  rowHeight: number;
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
    itemHeight={rowHeight}
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

/** Search Kit's "Go to file" (`tau.search/files`), copied down: a kit never imports another kit. */
export const SEARCH_FILES_SERVICE = "tau.search/files";
export interface SearchFilesService {
  pickFile(onPick?: (path: string) => void): void;
}

/** A service another kit may provide or withdraw at any time, for a component to follow. */
export interface ServiceSlot<T> {
  get(): T | undefined;
  set(value: T | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function serviceSlot<T>(): ServiceSlot<T> {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => { value = next; for (const listener of [...listeners]) listener(); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const noSlot = () => () => undefined;

/** Whether the workbench lays out for touch (`body[data-profile="compact"]`: a phone, a tablet). */
function useCompactLayout(): boolean {
  const read = () => typeof document !== "undefined" && document.body.dataset.profile === "compact";
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setCompact(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-profile"] });
    return () => observer.disconnect();
  }, []);
  return compact;
}

/** A changed file's working-tree diff in the Files tab, the design's "Diff" beside "Source". */
function FileDiffPane({ path, load }: { path: string; load(path: string): Promise<UiFileDiff> }) {
  const [diff, setDiff] = useState<UiFileDiff>();
  useEffect(() => {
    let live = true;
    setDiff(undefined);
    load(path).then((next) => { if (live) setDiff(next); }, () => { if (live) setDiff({ path, added: 0, removed: 0, hunks: [], note: "The diff could not be read." }); });
    return () => { live = false; };
  }, [load, path]);
  return <div className="files-diff"><DiffView diff={diff} mode="unified" path={path} /></div>;
}

/** The changed files as a flat list with their Git status, the Files tab's "Changed" view. */
function ChangedList({ files, current, onOpen, onPin }: {
  files: readonly { path: string; name: string; status: string }[];
  current?: string;
  onOpen(path: string): void;
  onPin(path: string): void;
}) {
  if (files.length === 0) return <p className="empty-copy">The worktree is clean.</p>;
  const letter = (status: string) => status === "added" || status === "untracked" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";
  return <div className="files-changed-list">
    {files.map((file) => <button
      key={file.path}
      type="button"
      className={`file-row file ${file.path === current ? "active" : ""}`}
      aria-current={file.path === current ? "true" : undefined}
      title={file.path}
      onClick={() => onOpen(file.path)}
      onDoubleClick={() => onPin(file.path)}
    >
      <span className="file-kind-icon"><FileKindIcon name={file.name} /></span>
      <span className="name">{file.path}</span>
      <em className={`files-status-${letter(file.status)}`}>{letter(file.status)}</em>
    </button>)}
  </div>;
}

/**
 * The project's files. On the stage (the workbench design's Files tab) the
 * explorer stands beside the file it shows, with Changed / All and "Open in
 * your editor"; a double-click opens a file as a tab of its own. In a phone's
 * sheet (`placement: "sheet"`), which has no stage, the file opens in the
 * sheet to read; in the drawer a click opens it on the stage.
 */
export function FilesPanel({ active, placement, search }: PanelProps & { search?: ServiceSlot<SearchFilesService> }) {
  const workspaceStore = useWorkspaceStore();
  const { fileTree, changes, cwd, workspace } = useWorkspaceKit();
  const { openFile, activeDocumentPath: activePath } = useWorkbench();
  const touch = useCompactLayout();
  const inSheet = placement === "sheet";
  const onStage = placement === "stage";
  const [reading, setReading] = useState<string>();
  const [view, setView] = useState<"changed" | "all">(() => changes.files.length > 0 ? "changed" : "all");
  const [fileView, setFileView] = useState<"diff" | "source">("diff");
  const { filesFocus } = useWorkspaceKit();
  // "N files changed" asked for the Changed view and its first file.
  useEffect(() => {
    if (!filesFocus) return;
    setView("changed");
    setFileView("diff");
    if (filesFocus.path) setReading(filesFocus.path);
  }, [filesFocus?.token]);
  const refreshFiles = () => workspaceStore.refreshFiles();
  const loadFiles = (path: string) => workspaceStore.loadFiles(path);
  const readFile = useCallback((path: string) => workspaceStore.host.readFile(path, workspaceStore.workspace()), [workspaceStore]);
  const readDiff = useCallback((path: string) => workspaceStore.host.getFileDiff(path, undefined, workspaceStore.workspace()), [workspaceStore]);
  useEffect(() => { if (active) void workspaceStore.refreshFiles(); }, [active, cwd, workspaceStore]);
  // Another project's paths name other files; the first render keeps what a focus request picked.
  const shownCwd = useRef(cwd);
  useEffect(() => {
    if (shownCwd.current !== cwd) setReading(undefined);
    shownCwd.current = cwd;
  }, [cwd]);
  const changedPaths = useMemo(() => new Set(changes.files.map((file) => file.path)), [changes.files]);
  const pin = (path: string) => { if (!workspaceStore.editFile(path)) openFile(path, { pin: true }); };
  const open = (path: string, options?: { pin?: boolean }) => {
    if (inSheet || (onStage && !options?.pin)) setReading(path);
    else if (options) openFile(path, options);
    else openFile(path);
  };
  const searcher = useSyncExternalStore(search?.subscribe ?? noSlot, () => search?.get());
  const { localFiles } = useHostCapabilities();
  const editor = localFiles ? workspaceStore.activeEditor() : undefined;

  const tree = <FileTree
    nodes={fileTree}
    changedPaths={changedPaths}
    activePath={onStage ? reading : relativeHostPath(activePath, cwd)}
    rowHeight={touch ? 44 : 30}
    loadFiles={loadFiles}
    openFile={open}
    editFile={(path) => !inSheet && workspaceStore.editFile(path)}
  />;
  const goToFile = searcher ? <button
    type="button"
    className="icon-button files-panel-search"
    aria-label="Go to file"
    {...tooltipProps("Go to file", { shortcut: "⌘P", side: "bottom" })}
    onClick={() => searcher.pickFile(inSheet || onStage ? setReading : undefined)}
  ><Search size={touch ? 18 : 14} /></button> : null;

  if (onStage) {
    const project = cwd?.split(/[\\/]/u).filter(Boolean).at(-1);
    return <section className="panel-body files-panel files-stage">
      <aside className="files-explorer" aria-label="Explorer">
        <header className="files-explorer-head">
          <span className="files-explorer-scope" title={cwd}>{project}{workspace?.branch ? <> · <b>{workspace.branch}</b></> : null}</span>
          <div className="toggle-group files-explorer-view" role="group" aria-label="Show">
            <button type="button" className={view === "changed" ? "active" : ""} aria-pressed={view === "changed"} onClick={() => setView("changed")}>Changed</button>
            <button type="button" className={view === "all" ? "active" : ""} aria-pressed={view === "all"} onClick={() => setView("all")}>All</button>
          </div>
          {goToFile}
        </header>
        <div className="files-panel-tree">
          {view === "changed" ? <ChangedList files={changes.files} current={reading} onOpen={open} onPin={pin} /> : tree}
        </div>
        {editor ? <button type="button" className="files-open-editor" onClick={() => void workspaceStore.openInEditor(reading, editor.id)}>
          <SquarePen size={14} aria-hidden="true" /><span>Open in your editor</span><kbd>{/mac|iphone|ipad/iu.test(navigator.platform) ? "⌘O" : "Ctrl+O"}</kbd>
        </button> : null}
      </aside>
      {reading ? <div className="files-reading">
        <header className="files-reading-head">
          <strong title={reading}>{reading}</strong>
          {changedPaths.has(reading) ? <div className="toggle-group" role="group" aria-label="View">
            <button type="button" className={fileView === "diff" ? "active" : ""} aria-pressed={fileView === "diff"} onClick={() => setFileView("diff")}>Diff</button>
            <button type="button" className={fileView === "source" ? "active" : ""} aria-pressed={fileView === "source"} onClick={() => setFileView("source")}>Source</button>
          </div> : null}
          <button type="button" className="icon-button" aria-label="Open as a tab" {...tooltipProps("Open as a tab", { side: "bottom" })} onClick={() => openFile(reading, { pin: true, ...(changedPaths.has(reading) && fileView === "diff" ? { view: "diff" as const } : {}) })}><PanelTop size={14} /></button>
          <button type="button" className="icon-button" aria-label="Edit file" {...tooltipProps("Edit file", { side: "bottom" })} onClick={() => pin(reading)}><SquarePen size={14} /></button>
        </header>
        {changedPaths.has(reading) && fileView === "diff"
          ? <FileDiffPane path={reading} load={readDiff} />
          : <FileReader key={reading} path={reading} load={readFile} />}
      </div> : <div className="files-stage-empty"><p className="empty-copy">Pick a file to read it here; a double-click opens it as a tab of its own.</p></div>}
    </section>;
  }

  // The tree stays mounted under the file, so back finds its folders as they were.
  return <section className="panel-body files-panel">
    {inSheet && reading ? <FileReader path={reading} load={readFile} onBack={() => setReading(undefined)} /> : null}
    <header className="panel-header" hidden={Boolean(inSheet && reading)}>
      {/* The sheet's own header names it already. */}
      {inSheet ? null : <h2>Files</h2>}
      <span className="spacer" />
      {goToFile}
      <button type="button" className="icon-button files-panel-search" aria-label="Refresh files" {...tooltipProps("Refresh files", { side: "bottom" })} onClick={() => void refreshFiles()}><RotateCw size={touch ? 18 : 14} /></button>
    </header>
    <div className="files-panel-tree" hidden={Boolean(inSheet && reading)}>{tree}</div>
  </section>;
}

export function ChangesPanel({ active, actions }: PanelProps) {
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
      {changes.branch ? <small>{changes.branch}</small> : null}
      <span className="spacer" />
      {changes.refreshStatus?.state === "error" ? <small title={changes.refreshStatus.message}>stale · refresh failed</small> : null}
      <button className="icon-button compact" title="Open full review" aria-label="Open full review" onClick={() => openReview()}><FileDiff size={14} /></button>
      <button className="icon-button compact" aria-label="Rescan changes" {...tooltipProps("Rescan changes", { side: "bottom" })} onClick={() => void refreshChanges()}><RotateCw size={14} /></button>
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
