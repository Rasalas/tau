import { useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, Download, GitCommitHorizontal, TerminalSquare, Upload } from "lucide-react";
import { Menu, useHostCapabilities, usePreferences, type RegionProps } from "tau";
import { EditorIcon } from "./EditorIcon.js";
import { ProjectActionsControl } from "./project-actions.js";
import { resolveGitQuickAction, type GitQuickActionKind } from "./actions.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";

/**
 * The title-bar controls Workspace Kit owns: project actions, "Open in
 * editor", and the Git quick action. Core's title bar only lends the place.
 */
export function WorkspaceTitleActions({ actions }: RegionProps) {
  const workspaceStore = useWorkspaceStore();
  const preferences = usePreferences();
  const state = useWorkspaceKit();
  const { localFiles } = useHostCapabilities();
  // Re-render when the editor preference changes.
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const [editorMenu, setEditorMenu] = useState(false);
  const [terminalMenu, setTerminalMenu] = useState(false);
  const [gitMenu, setGitMenu] = useState(false);
  const activeEditor = workspaceStore.activeEditor();
  const activeTerminal = workspaceStore.activeTerminal();
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
  void actions;

  return (
    <>
      <ProjectActionsControl cwd={state.workspaceId ?? state.cwd} onRun={(command, includeInContext, name) => void workspaceStore.runShellAction(command, includeInContext, name)} />

      {localFiles ? <div className="menu-anchor">
        <div className="chrome-group" aria-label="Open in editor">
          <button
            className="chrome-button split-main"
            disabled={!activeEditor}
            title={activeEditor ? `Open in ${activeEditor.name} (${typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform) ? "⌘O" : "Ctrl+O"})` : "No supported editor found on PATH"}
            onClick={() => activeEditor && void workspaceStore.openInEditor(undefined, activeEditor.id)}
          >
            <EditorIcon editorId={activeEditor?.id} className="editor-icon" />
            Open
          </button>
          <button
            className="chrome-button split-trigger"
            disabled={state.editors.length === 0}
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
            items={state.editors.map((editor) => ({
              id: editor.id,
              label: editor.name,
              selected: editor.id === activeEditor?.id,
              icon: <EditorIcon editorId={editor.id} className="menu-editor-icon" />,
            }))}
            onSelect={(id) => { workspaceStore.chooseEditor(id); void workspaceStore.openInEditor(undefined, id); }}
            onClose={() => setEditorMenu(false)}
          />
        ) : null}
      </div> : null}

      {localFiles ? (
        <div className="menu-anchor">
          {state.terminals.length > 1 ? (
            <div className="chrome-group" aria-label="Open in terminal">
              <button
                className="chrome-button split-main"
                disabled={!activeTerminal}
                aria-label="Open in terminal"
                title={activeTerminal ? `Open in ${activeTerminal.name} (${typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform) ? "⌘J" : "Ctrl+J"})` : "No supported terminal found"}
                onClick={() => void workspaceStore.openTerminal()}
              >
                <TerminalSquare size={13} />
              </button>
              <button
                className="chrome-button split-trigger"
                aria-label="Choose terminal"
                onClick={() => setTerminalMenu(true)}
              >
                <ChevronDown size={13} />
              </button>
            </div>
          ) : (
            <button
              className="chrome-button"
              disabled={!activeTerminal}
              aria-label="Open in terminal"
              title={activeTerminal ? `Open in ${activeTerminal.name} (${typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform) ? "⌘J" : "Ctrl+J"})` : "No supported terminal found"}
              onClick={() => void workspaceStore.openTerminal()}
            >
              <TerminalSquare size={13} />
            </button>
          )}
          {terminalMenu ? (
            <Menu
              align="right"
              heading="Terminal"
              items={state.terminals.map((terminal) => ({
                id: terminal.id,
                label: terminal.name,
                selected: terminal.id === activeTerminal?.id,
                icon: <TerminalSquare size={13} />,
              }))}
              onSelect={(id) => { workspaceStore.chooseTerminal(id); void workspaceStore.openTerminal(id); }}
              onClose={() => setTerminalMenu(false)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="menu-anchor">
        <div className="chrome-group" aria-label="Git actions">
          <button
            className="chrome-button accent split-main"
            disabled={gitAction.disabled}
            title={gitAction.hint}
            onClick={() => runGitAction(gitAction.kind)}
          >
            {gitAction.kind === "pull" ? <Download size={13} /> : gitAction.kind === "push" ? <Upload size={13} /> : <GitCommitHorizontal size={13} />}
            {gitAction.label}
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
      </div>
    </>
  );
}
