import { useMemo, useState } from "react";
import { ChevronDown, GitCommitHorizontal, PanelRight, PanelRightClose, Upload } from "lucide-react";
import type { UiEditor, UiWorkspaceChanges, WorkspaceInfo } from "../../shared/contracts";
import { shortenPath } from "../path-display";
import { resolveGitQuickAction, type GitQuickActionKind } from "../title-bar-actions";
import { EditorIcon } from "./EditorIcon";
import { Menu } from "./Menu";
import { ProjectActionsControl } from "./ProjectActionsControl";
import { WindowControlsInset } from "./WindowControlsInset";

function workspaceName(cwd?: string): string {
  return cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

function parentPath(cwd?: string): string {
  if (!cwd) return "starting host…";
  const parent = cwd.slice(0, cwd.lastIndexOf("/"));
  return parent ? shortenPath(parent, 34) : "/";
}

export function TitleBar({
  cwd,
  editors,
  activeEditor,
  changes,
  workspace,
  gitBusy,
  dockOpen,
  editorDisabled = false,
  onOpenInEditor,
  onChooseEditor,
  onOpenReview,
  onPush,
  onRunAction,
  onToggleDock,
}: {
  cwd?: string;
  editors: UiEditor[];
  activeEditor?: UiEditor;
  changes: UiWorkspaceChanges;
  workspace?: WorkspaceInfo;
  gitBusy: boolean;
  dockOpen: boolean;
  editorDisabled?: boolean;
  onOpenInEditor(editorId?: string): void;
  onChooseEditor(id: string): void;
  onOpenReview(push: boolean): void;
  onPush(): void;
  onRunAction(command: string, includeInContext: boolean, name: string): void;
  onToggleDock(): void;
}) {
  const [editorMenu, setEditorMenu] = useState(false);
  const [gitMenu, setGitMenu] = useState(false);
  const gitAction = useMemo(
    () => resolveGitQuickAction(changes, workspace, gitBusy),
    [changes, gitBusy, workspace],
  );

  const runGitAction = (kind: GitQuickActionKind) => {
    if (kind === "commit") onOpenReview(false);
    if (kind === "commit-push") onOpenReview(true);
    if (kind === "push") onPush();
  };

  return (
    <header className="title-bar">
      <WindowControlsInset />
      <div className="title-identity">
        <strong>{workspaceName(cwd)}</strong>
        <span title={cwd}>{parentPath(cwd)}</span>
      </div>
      <div className="title-spacer" />

      <ProjectActionsControl cwd={cwd} onRun={onRunAction} />

      <div className="menu-anchor">
        <div className="chrome-group" aria-label="Open in editor">
          <button
            className="chrome-button split-main"
            disabled={!activeEditor || editorDisabled}
            title={editorDisabled ? "Opening an editor is unavailable while a draft is being delivered" : activeEditor ? `Open in ${activeEditor.name}` : "No supported editor found on PATH"}
            onClick={() => activeEditor && onOpenInEditor(activeEditor.id)}
          >
            <EditorIcon editorId={activeEditor?.id} className="editor-icon" />
            Open
          </button>
          <button
            className="chrome-button split-trigger"
            disabled={editors.length === 0 || editorDisabled}
            aria-label="Choose editor"
            onClick={() => setEditorMenu(true)}
          >
            <ChevronDown size={13} />
          </button>
        </div>
        {editorMenu ? (
          <Menu
            align="right"
            heading="Open in"
            items={editors.map((editor) => ({
              id: editor.id,
              label: editor.name,
              selected: editor.id === activeEditor?.id,
              icon: <EditorIcon editorId={editor.id} className="menu-editor-icon" />,
            }))}
            onSelect={(id) => { onChooseEditor(id); onOpenInEditor(id); }}
            onClose={() => setEditorMenu(false)}
          />
        ) : null}
      </div>

      <div className="menu-anchor">
        <div className="chrome-group" aria-label="Git actions">
          <button
            className="chrome-button accent split-main"
            disabled={gitAction.disabled}
            title={gitAction.hint}
            onClick={() => runGitAction(gitAction.kind)}
          >
            {gitAction.kind === "push" ? <Upload size={13} /> : <GitCommitHorizontal size={13} />}
            {gitAction.label}
          </button>
          <button
            className="chrome-button accent split-trigger"
            disabled={!workspace?.isRepo || gitBusy}
            aria-label="Choose Git action"
            onClick={() => setGitMenu(true)}
          >
            <ChevronDown size={13} />
          </button>
        </div>
        {gitMenu ? (
          <Menu
            align="right"
            heading={workspace?.branch ?? "Git"}
            items={[
              {
                id: "review",
                label: "Review changes",
                description: changes.files.length > 0 ? `${changes.files.length} changed files` : "The worktree is clean",
                disabled: changes.files.length === 0,
              },
              {
                id: "commit",
                label: "Commit",
                disabled: changes.files.length === 0,
                icon: <GitCommitHorizontal size={13} />,
              },
              {
                id: "commit-push",
                label: "Commit & push",
                description: workspace?.upstream ? `to ${workspace.upstream}` : "No upstream configured",
                disabled: changes.files.length === 0 || !workspace?.upstream,
                icon: <Upload size={13} />,
              },
              {
                id: "push",
                label: "Push",
                description: workspace?.ahead ? `${workspace.ahead} local ${workspace.ahead === 1 ? "commit" : "commits"}` : "No local commits to push",
                disabled: !workspace?.upstream || !workspace.ahead || Boolean(workspace.behind),
                icon: <Upload size={13} />,
              },
            ]}
            onSelect={(id) => id === "review" ? onOpenReview(gitAction.kind === "commit-push") : runGitAction(id as GitQuickActionKind)}
            onClose={() => setGitMenu(false)}
          />
        ) : null}
      </div>

      <button
        className="chrome-ghost glyph"
        title={dockOpen ? "Hide panel" : "Show panel"}
        aria-label={dockOpen ? "Hide panel" : "Show panel"}
        onClick={onToggleDock}
      >
        {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
      </button>
    </header>
  );
}
