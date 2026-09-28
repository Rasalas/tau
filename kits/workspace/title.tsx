import { useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ChevronDown, ChevronRight, Download, Ellipsis, GitCommitHorizontal, SquarePen, Upload } from "lucide-react";
import { Menu, tooltipProps, useHostCapabilities, usePreferences, type MenuSection, type RegionProps } from "tau";
import { EditorIcon } from "./EditorIcon.js";
import { pickProjectAction, ProjectActionEditor, ProjectActionsControl, projectActionItems, useProjectActions } from "./project-actions.js";
import { resolveGitQuickAction, type GitQuickActionKind } from "./actions.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";
import { titleCollapse, useTitleCollapse, type TitleCollapse } from "./title-collapse.js";

/**
 * The thread header's controls Workspace Kit owns, as in the workbench design:
 * the project actions, "N files changed ›", which opens the review, and the Git
 * quick action. Core's header only lends the place; the row collapses itself
 * to the room it gets. "Open in" is the stage strip's (`WorkspaceEditorButton`).
 */
export function WorkspaceTitleActions(props: RegionProps) {
  const row = useRef<HTMLDivElement>(null);
  const level = useTitleCollapse(row);
  return <TitleActionsRow {...props} row={row} collapse={titleCollapse(level)} />;
}

const EDITOR_PREFIX = "editor:";

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
 * "Open in" at the stage strip's right end, the design's Editor button: the
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
    >{activeEditor ? <EditorIcon editorId={activeEditor.id} className="editor-icon" /> : <SquarePen size={16} />}</button>
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

export function TitleActionsRow({ collapse, row }: RegionProps & { collapse: TitleCollapse; row?: RefObject<HTMLDivElement | null> }) {
  const workspaceStore = useWorkspaceStore();
  const state = useWorkspaceKit();
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
  const showActions = !readOnly;
  const moreSections: MenuSection[] = showActions && collapse.actions === "overflow" ? [{ heading: "Actions", items: projectActionItems(projectActions.actions) }] : [];
  const gitIcon = gitAction.kind === "pull" ? <Download size={13} /> : gitAction.kind === "push" ? <Upload size={13} /> : <GitCommitHorizontal size={13} />;
  const changed = state.changes.files.length;

  return (
    <div ref={row} className="workspace-title-actions">
      {showActions && collapse.actions !== "overflow" ? <ProjectActionsControl state={projectActions} iconOnly={collapse.actions === "icon"} /> : null}

      {moreSections.length > 0 || (projectActions.editing && collapse.actions === "overflow") ? <div className="menu-anchor">
        <button className="chrome-button title-more" aria-label="More actions" {...tooltipProps("More actions", { side: "bottom" })} onClick={() => setMoreMenu(true)}>
          <Ellipsis size={14} />
        </button>
        {moreMenu ? <Menu
          align="right"
          sections={moreSections}
          label="More actions"
          onSelect={(id) => { pickProjectAction(projectActions, id); }}
          onClose={() => setMoreMenu(false)}
        /> : null}
        {projectActions.editing && collapse.actions === "overflow" ? <ProjectActionEditor state={projectActions} /> : null}
      </div> : null}

      {changed > 0 ? <button
        type="button"
        className="workspace-changes-link"
        {...tooltipProps("Review the changes", { side: "bottom" })}
        onClick={() => { if (!workspaceStore.openChangesView()) workspaceStore.openReview(); }}
      >{changed} {changed === 1 ? "file" : "files"} changed<ChevronRight size={13} /></button> : null}

      {readOnly ? null : <div className="menu-anchor">
        <div className="chrome-group" aria-label="Git actions">
          <button
            className="chrome-button accent split-main"
            disabled={gitAction.disabled}
            aria-label={gitAction.label}
            {...tooltipProps(collapse.git === "icon" ? `${gitAction.label}: ${gitAction.hint}` : gitAction.hint, { side: "bottom" })}
            onClick={() => runGitAction(gitAction.kind)}
          >
            {gitIcon}
            {collapse.git === "label" ? <span>{gitAction.label}</span> : null}
          </button>
          <button
            className="chrome-button accent split-trigger"
            disabled={!state.workspace?.isRepo || state.committing}
            aria-label="Choose Git action"
            onClick={() => setGitMenu(true)}
          >
            <ChevronDown size={13} />
          </button>
        </div>
        {gitMenu ? (
          <Menu
            align="right"
            heading={state.workspace?.branch ?? "Git"}
            items={[
              {
                id: "review",
                label: "Review changes",
                description: state.changes.files.length > 0 ? `${state.changes.files.length} changed files` : "The worktree is clean",
                disabled: state.changes.files.length === 0,
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
            ]}
            onSelect={(id) => id === "review" ? workspaceStore.openReview(undefined, gitAction.kind === "commit-push") : runGitAction(id as GitQuickActionKind)}
            onClose={() => setGitMenu(false)}
          />
        ) : null}
      </div>}
    </div>
  );
}
