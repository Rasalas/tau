import { useState } from "react";
import { WindowControlsInset } from "./WindowControlsInset";
import { ChevronDown, ExternalLink, GitCommitHorizontal, PanelRight, PanelRightClose } from "lucide-react";
import type { UiEditor } from "../../shared/contracts";
import { shortenPath } from "../path-display";
import { Menu } from "./Menu";

function workspaceName(cwd?: string): string {
  return cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

/** The folder the project sits in — the name beside it already says which project. */
function parentPath(cwd?: string): string {
  if (!cwd) return "starting host…";
  const parent = cwd.slice(0, cwd.lastIndexOf("/"));
  return parent ? shortenPath(parent, 34) : "/";
}

export function TitleBar({
  cwd,
  editors,
  activeEditor,
  changedCount,
  dockOpen,
  onOpenInEditor,
  onChooseEditor,
  onCommit,
  onOpenPalette,
  onToggleDock,
}: {
  cwd?: string;
  editors: UiEditor[];
  activeEditor?: UiEditor;
  changedCount: number;
  dockOpen: boolean;
  onOpenInEditor(): void;
  onChooseEditor(id: string): void;
  onCommit(): void;
  onOpenPalette(): void;
  onToggleDock(): void;
}) {
  const [editorMenu, setEditorMenu] = useState(false);

  return (
    <header className="title-bar">
      <WindowControlsInset />
      <div className="title-identity">
        <strong>{workspaceName(cwd)}</strong>
        <span title={cwd}>{parentPath(cwd)}</span>
      </div>
      <div className="title-spacer" />

      <div className="menu-anchor">
        <button
          className="chrome-button"
          disabled={editors.length === 0}
          title={editors.length === 0 ? "No supported editor found on PATH" : undefined}
          onClick={() => (activeEditor ? onOpenInEditor() : setEditorMenu(true))}
        >
          <ExternalLink size={13} />
          {activeEditor ? `Open in ${activeEditor.name}` : "Open in editor"}
          <b onClick={(event) => { event.stopPropagation(); setEditorMenu(true); }}>
            <ChevronDown size={12} />
          </b>
        </button>
        {editorMenu ? (
          <Menu
            heading="Editor"
            items={editors.map((editor) => ({
              id: editor.id,
              label: editor.name,
              selected: editor.id === activeEditor?.id,
            }))}
            onSelect={onChooseEditor}
            onClose={() => setEditorMenu(false)}
          />
        ) : null}
      </div>

      <button
        className="chrome-button accent"
        disabled={changedCount === 0}
        title={changedCount === 0 ? "No changes to commit" : `${changedCount} changed files`}
        onClick={onCommit}
      >
        <GitCommitHorizontal size={13} /> Commit &amp; push <b><ChevronDown size={12} /></b>
      </button>

      <button className="chrome-ghost" title="Command palette" onClick={onOpenPalette}>⌘K</button>
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
