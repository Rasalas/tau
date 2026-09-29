import { ChevronDown, ExternalLink } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { hostHasLocalFiles, Menu, type UiEditor } from "tau";
import type { WorkspaceStoreLike } from "./kit.js";

const FILE_MANAGER_ID = "file-manager";
const EMPTY = { editors: [] as UiEditor[] };

function menuLabel(editor: UiEditor): string {
  return editor.id === FILE_MANAGER_ID ? `Reveal in ${editor.name}` : editor.name;
}

/**
 * The "Open in" picker: the editor used last opens with one click, the
 * chevron lists every editor this machine has, and the file manager reveals
 * the file rather than becoming the default.
 */
export function OpenInPicker({ store, relPath, line }: { store: WorkspaceStoreLike; relPath: string; line?: () => number | undefined }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot) ?? EMPTY;
  const [open, setOpen] = useState(false);
  const preferred = store.activeEditor();
  const primary = preferred && preferred.id !== FILE_MANAGER_ID ? preferred : state.editors.find((editor) => editor.id !== FILE_MANAGER_ID) ?? preferred;
  const openWith = (editorId: string) => {
    const at = line?.();
    void store.openInEditor(relPath, editorId, at ? { line: at } : undefined);
  };
  // The host's editors open on the host's screen, not on a phone's or a tablet's.
  if (state.editors.length === 0 || !hostHasLocalFiles()) return null;
  return <div className="menu-anchor files-open-in">
    <div className="chrome-group" aria-label="Open in editor">
      <button
        type="button"
        className="chrome-button split-main"
        disabled={!primary}
        title={primary ? `Open in ${primary.name}` : undefined}
        onClick={() => { if (primary) openWith(primary.id); }}
      >
        <ExternalLink size={12} />
        <span>{primary ? primary.name : "Open"}</span>
      </button>
      <button type="button" className="chrome-button split-trigger" aria-label="Choose editor" onClick={() => setOpen(true)}>
        <ChevronDown size={13} />
      </button>
    </div>
    {open ? <Menu
      align="right"
      heading="Open in"
      items={state.editors.map((editor) => ({ id: editor.id, label: menuLabel(editor), selected: editor.id === primary?.id }))}
      onSelect={(id) => {
        setOpen(false);
        if (id !== FILE_MANAGER_ID) store.chooseEditor(id);
        openWith(id);
      }}
      onClose={() => setOpen(false)}
    /> : null}
  </div>;
}
