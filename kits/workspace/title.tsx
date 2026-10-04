import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ChevronDown, ChevronRight, Download, Ellipsis, GitCommitHorizontal, GitCompare, GitBranch, FolderGit2, SquareMenu, SquarePen, Upload } from "lucide-react";
import { hostAvailable, Menu, Popover, tooltipProps, useHostCapabilities, usePreferences, type MenuSection, type RegionProps } from "tau";
import { ThreadBranch } from "./branch-menu.js";
import { EditorIcon } from "./EditorIcon.js";
import { pickProjectAction, ProjectActionEditor, ProjectActionsControl, projectActionItems, useProjectActions } from "./project-actions.js";
import { resolveGitQuickAction, type GitQuickActionKind } from "./actions.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";
import { type TitleCollapse } from "./title-collapse.js";
import type { ThreadChangesCount } from "./thread-changes.js";

/** Workspace Kit context and actions, placed by core beside the conversation. */
export function WorkspaceTitleActions(props: RegionProps & { hideChanges?: boolean }) {
  const state = useWorkspaceKit();
  const workspaceStore = useWorkspaceStore();
  const { readOnly } = useHostCapabilities();
  const projectActions = useProjectActions(state.workspaceId ?? state.cwd, (command, includeInContext, name) => void workspaceStore.runShellAction(command, includeInContext, name));
  const changed = state.changes.fileCount ?? state.changes.files.length;
  if (!state.cwd) return null;
  const worktree = state.workspace?.worktrees.find((entry) => entry.isCurrent && !entry.isMain);
  return <section className="workspace-summary-card" aria-label="Project workspace">
    {worktree ? <header className="workspace-card-row workspace-card-identity"><FolderGit2 aria-hidden /><span className="workspace-card-label" title={worktree.path}>{worktree.name}</span><span className="workspace-card-accessory">Worktree</span></header> : null}
    <div className="workspace-card-tools" role="group" aria-label="Project tools">
      <WorkspaceEditorButton {...props} />
      {!state.draftPending && !readOnly ? <ProjectActionsControl state={projectActions} card /> : null}
    </div>
    <div className="workspace-card-checkout" role="group" aria-label="Checkout">
      <div className="workspace-summary-branch">{state.draftPending ? <span className="workspace-card-row"><GitBranch aria-hidden /><span className="workspace-card-label">{state.workspace?.branch || "New worktree"}</span></span> : <ThreadBranch {...props} card />}</div>
      {!state.draftPending ? <TitleActionsRow {...props} hideActions hideChanges collapse={{ actions: "label", changes: "label", git: "label" }} /> : null}
    </div>
    {!state.draftPending ? (state.workspaceSummarySections ?? []).map((Section, index) => <Section key={index} {...props} />) : null}
    {!state.draftPending && !props.hideChanges ? <button type="button" className="workspace-changes-link workspace-card-row workspace-card-changes" {...tooltipProps("Review working-tree changes")} aria-label={`${changed} ${changed === 1 ? "file" : "files"} changed`} onClick={() => workspaceStore.showChangedFiles()}>
      <GitCompare aria-hidden /><span className="workspace-card-label">Changes</span><span className="workspace-card-deltas" aria-label={`Working tree: ${state.changes.added} additions, ${state.changes.removed} deletions`}><span className="added">+{state.changes.added}</span><span className="removed">−{state.changes.removed}</span></span><span className="workspace-card-tail"><ChevronRight size={16} /></span>
    </button> : null}
  </section>;
}

/** Project context stays in the stage's existing strip while documents are open. */
export function WorkspaceStageContext(props: RegionProps) {
  const state = useWorkspaceKit();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [state.cwd]);
  useEffect(() => {
    const trigger = anchor.current;
    if (!open || !trigger) return undefined;
    const closeHidden = () => { if (trigger.getBoundingClientRect().width === 0) setOpen(false); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(closeHidden);
    observer?.observe(trigger);
    window.addEventListener("resize", closeHidden);
    return () => { observer?.disconnect(); window.removeEventListener("resize", closeHidden); };
  }, [open]);
  if (!state.cwd) return null;
  const active = props.actions.activeStageTab?.();
  const diffActive = active?.kind === "panel" && active.panelId === "review.diff";
  return <div className="workspace-stage-context">
    <button ref={anchor} type="button" className="stage-tool workspace-project-trigger" aria-label="Project actions" {...tooltipProps("Project actions", { side: "bottom" })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <SquareMenu size={16} aria-hidden />
    </button>
    {open ? <Popover anchor={anchor} align="end" label="Project actions" className="workspace-project-menu" onClose={() => setOpen(false)}>
      <WorkspaceTitleActions {...props} hideChanges={diffActive} />
    </Popover> : null}
  </div>;
}

const EDITOR_PREFIX = "editor:";
const GIT_PREFIX = "git:";

/** The editors "Open in" offers, the chosen one marked. */
function editorSections(editors: ReturnType<typeof useWorkspaceKit>["editors"], active?: { id: string }): MenuSection[] {
  return editors.length > 0 ? [{
    heading: "Open in",
    items: editors.map((editor) => ({
      id: `${EDITOR_PREFIX}${editor.id}`,
      label: editor.name,
      selected: editor.id === active?.id,
      icon: <EditorIcon editorId={editor.id} className="menu-editor-icon" />,
    })),
  }] : [];
}

/**
 * "Open in" before the stage tools, the design's Editor button: the
 * chosen editor's logo opens the project, the chevron picks another editor.
 */
export function WorkspaceEditorButton(_props: RegionProps) {
  const workspaceStore = useWorkspaceStore();
  const preferences = usePreferences();
  const state = useWorkspaceKit();
  const { localFiles } = useHostCapabilities();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const [menu, setMenu] = useState(false);
  if (!localFiles) return null;
  const activeEditor = workspaceStore.activeEditor();
  const mac = typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);
  const label = activeEditor ? `Open in ${activeEditor.name}` : "No supported editor found on PATH";
  return <span className="menu-anchor workspace-editor-button" aria-label="Open in editor" role="group">
    <button
      type="button"
      className="stage-tool"
      disabled={!activeEditor}
      aria-label="Open"
      {...tooltipProps(label, { side: "bottom", ...(activeEditor ? { shortcut: mac ? "⌘O" : "Ctrl+O" } : {}) })}
      onClick={() => activeEditor && void workspaceStore.openInEditor(undefined, activeEditor.id)}
    >{activeEditor ? <EditorIcon editorId={activeEditor.id} className="editor-icon" /> : <SquarePen size={16} />}<span>{activeEditor ? `Open in ${activeEditor.name}` : "Open in editor"}</span></button>
    <button
      type="button"
      className="stage-tool workspace-editor-choose"
      aria-label="Choose editor"
      aria-haspopup="menu"
      aria-expanded={menu}
      disabled={state.editors.length === 0}
      {...tooltipProps("Choose editor", { side: "bottom" })}
      onClick={() => setMenu((open) => !open)}
    ><ChevronDown size={12} /></button>
    {menu ? <Menu
      align="right"
      sections={editorSections(state.editors, activeEditor)}
      label="Open in"
      onSelect={(id) => {
        setMenu(false);
        if (!id.startsWith(EDITOR_PREFIX)) return;
        const editor = id.slice(EDITOR_PREFIX.length);
        workspaceStore.chooseEditor(editor);
        void workspaceStore.openInEditor(undefined, editor);
      }}
      onClose={() => setMenu(false)}
    /> : null}
  </span>;
}

/**
 * The header's count, as the host reads it for this thread: a worktree's
 * branch against its base, else the uncommitted files its own turns changed.
 * Read again whenever the checkout, its changes or the thread's turns move.
 */
function useThreadChanges(sessionId: string | undefined): ThreadChangesCount | undefined {
  const workspaceStore = useWorkspaceStore();
  const state = useWorkspaceKit();
  const [count, setCount] = useState<{ sessionId?: string; value: ThreadChangesCount }>();
  const turn = sessionId ? state.turnStats[sessionId] : undefined;
  useEffect(() => {
    if (!hostAvailable()) return undefined;
    let live = true;
    workspaceStore.host.threadChanges(sessionId).then((value) => { if (live) setCount({ sessionId, value }); }, () => undefined);
    return () => { live = false; };
  }, [sessionId, state.changes, state.workspace, turn, workspaceStore]);
  return count?.sessionId === sessionId ? count?.value : undefined;
}

export function TitleActionsRow({ collapse, row, snapshot, hideChanges = false, hideActions = false }: RegionProps & { hideChanges?: boolean; hideActions?: boolean; collapse: TitleCollapse; row?: RefObject<HTMLDivElement | null> }) {
  const workspaceStore = useWorkspaceStore();
  const state = useWorkspaceKit();
  const threadChanges = useThreadChanges(snapshot?.sessionId);
  const { readOnly } = useHostCapabilities();
  const [gitMenu, setGitMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const projectActions = useProjectActions(state.workspaceId ?? state.cwd, (command, includeInContext, name) => void workspaceStore.runShellAction(command, includeInContext, name));
  const gitAction = useMemo(
    () => resolveGitQuickAction(state.changes, state.workspace, state.committing),
    [state.changes, state.committing, state.workspace],
  );
  const runGitAction = (kind: GitQuickActionKind) => {
    if (kind === "commit") workspaceStore.openReview(undefined, false);
    if (kind === "commit-push") workspaceStore.openReview(undefined, true);
    if (kind === "pull") void workspaceStore.pull();
    if (kind === "push") void workspaceStore.push();
  };

  // A Read-only device runs nothing and changes no branch (ADR 0024); both are left out.
  const showActions = !readOnly && !hideActions;
  const gitItems = [
    {
      id: "review",
      label: "Review changes",
      description: state.changes.files.length > 0 ? `${state.changes.files.length} changed files` : "The worktree is clean",
      disabled: state.changes.files.length === 0,
      icon: <GitCompare size={13} />,
    },
    {
      id: "commit",
      label: "Commit",
      disabled: state.changes.files.length === 0,
      icon: <GitCommitHorizontal size={13} />,
    },
    {
      id: "commit-push",
      label: "Commit & push",
      description: state.workspace?.upstream ? `to ${state.workspace.upstream}` : "No upstream configured",
      disabled: state.changes.files.length === 0 || !state.workspace?.upstream,
      icon: <Upload size={13} />,
    },
    {
      id: "push",
      label: "Push",
      description: state.workspace?.ahead ? `${state.workspace.ahead} local ${state.workspace.ahead === 1 ? "commit" : "commits"}` : "No local commits to push",
      disabled: !state.workspace?.upstream || !state.workspace.ahead || Boolean(state.workspace.behind),
      icon: <Upload size={13} />,
    },
  ];
  const pickGit = (id: string) => id === "review" ? workspaceStore.openReview(undefined, gitAction.kind === "commit-push") : runGitAction(id as GitQuickActionKind);
  const gitInMenu = !readOnly && collapse.gitMenu === "overflow";
  const moreSections: MenuSection[] = [
    ...(showActions && collapse.actions === "overflow" ? [{ heading: "Actions", items: projectActionItems(projectActions.actions) }] : []),
    ...(gitInMenu ? [{ heading: state.workspace?.branch ?? "Git", items: gitItems.map((item) => ({ ...item, id: GIT_PREFIX + item.id })) }] : []),
  ];
  const more = moreSections.length > 0 || (projectActions.editing && collapse.actions === "overflow") ? <div className="menu-anchor">
    <button className="chrome-button title-more" aria-label="More actions" {...tooltipProps("More actions", { side: "bottom" })} onClick={() => setMoreMenu(true)}>
      <Ellipsis size={14} />
    </button>
    {moreMenu ? <Menu
      align="right"
      sections={moreSections}
      label="More actions"
      onSelect={(id) => { if (id.startsWith(GIT_PREFIX)) { setMoreMenu(false); pickGit(id.slice(GIT_PREFIX.length)); } else pickProjectAction(projectActions, id); }}
      onClose={() => setMoreMenu(false)}
    /> : null}
    {projectActions.editing && collapse.actions === "overflow" ? <ProjectActionEditor state={projectActions} /> : null}
  </div> : null;
  const gitIcon = gitAction.kind === "pull" ? <Download size={13} /> : gitAction.kind === "push" ? <Upload size={13} /> : <GitCommitHorizontal size={13} />;
  const changed = threadChanges?.files ?? state.changes.files.length;
  const others = threadChanges?.scope === "thread" ? threadChanges.uncommitted - threadChanges.files : 0;

  return (
    <div ref={row} className="workspace-title-actions">
      {showActions && collapse.actions !== "overflow" ? <ProjectActionsControl state={projectActions} iconOnly={collapse.actions === "icon"} /> : null}

      {gitInMenu ? null : more}

      {!hideChanges && changed > 0 ? <button
        type="button"
        className="workspace-changes-link"
        {...tooltipProps(others > 0 ? `Review the changes; ${others} more uncommitted ${others === 1 ? "file is" : "files are"} not this thread's` : threadChanges?.scope === "branch" ? "Review the changes; committed ones on this branch count too" : "Review the changes", { side: "bottom" })}
        onClick={() => workspaceStore.showChangedFiles()}
      >{changed} {changed === 1 ? "file" : "files"}{collapse.changes === "label" ? <> changed<ChevronRight size={13} /></> : null}</button> : null}

      {readOnly ? null : <div className="menu-anchor">
        <div className="chrome-group" aria-label="Git actions">
          <button
            className={`chrome-button accent split-main${collapse.git === "icon" ? " icon-only" : ""}`}
            disabled={gitAction.disabled}
            aria-label={gitAction.label}
            {...tooltipProps(collapse.git === "icon" ? `${gitAction.label}: ${gitAction.hint}` : gitAction.hint, { side: "bottom" })}
            onClick={() => runGitAction(gitAction.kind)}
          >
            {gitIcon}
            {collapse.git === "label" ? <span>{gitAction.label}</span> : null}
          </button>
          {gitInMenu ? null : <button
            className="chrome-button accent split-trigger"
            disabled={!state.workspace?.isRepo || state.committing}
            aria-label="Choose Git action"
            onClick={() => setGitMenu(true)}
          >
            <ChevronDown size={13} />
          </button>}
        </div>
        {gitMenu ? (
          <Menu
            align="right"
            heading={state.workspace?.branch ?? "Git"}
            items={gitItems}
            onSelect={pickGit}
            onClose={() => setGitMenu(false)}
          />
        ) : null}
      </div>}
      {gitInMenu ? more : null}
    </div>
  );
}
