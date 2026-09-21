import { useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import type { DesktopExtension, StageTabHandle } from "tau";

/**
 * A stage tab of your own. Copy this file to ~/.tau/extensions/ (or to
 * <project>/.tau/extensions/ in a project Pi trusts) and run /reload in Tau,
 * then open it from the command palette: "Open a scratch note".
 *
 * Core keeps the tab strip, the placement and the preview rules; this kind
 * supplies the title, the glyph and the content, and talks back through the
 * handle it is rendered with.
 */
interface NoteParams extends Record<string, unknown> {
  /** Everything a tab needs to come back after a restart goes in the params. */
  name: string;
}

function noteParams(params: Record<string, unknown>): NoteParams {
  return { name: String(params.name ?? "scratch") };
}

function Note({ params, handle }: { params: NoteParams; handle: StageTabHandle }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");

  // The handle is the tab's own: a title it renames itself with, a dirty mark
  // core asks about before the tab closes, and the closing itself.
  useEffect(() => handle.onClose(() => console.log(`note ${params.name} closed`)), [handle, params.name]);
  useEffect(() => handle.setDirty(text !== saved), [handle, saved, text]);

  return (
    <div style={{ padding: 16, display: "grid", gap: 8, font: "13px/1.5 var(--sans)", color: "var(--ink-2)" }}>
      <textarea
        aria-label="Scratch note"
        value={text}
        rows={12}
        onChange={(event) => setText(event.target.value)}
        style={{ font: "12px var(--mono)", background: "var(--sunken)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="text-button" onClick={() => { setSaved(text); handle.setTitle(`${params.name} ✓`); }}>Save</button>
        <span>{text === saved ? "saved" : "unsaved"}</span>
      </div>
    </div>
  );
}

const extension: DesktopExtension = {
  id: "example.notes",
  name: "Scratch Notes",
  activate(plugin) {
    plugin.registerStageTab<NoteParams>({
      kind: "example.note",
      profiles: ["desktop", "web"],
      title: (params) => `Note: ${params.name}`,
      Icon: StickyNote,
      render: (params, handle) => <Note params={noteParams(params)} handle={handle} />,
      // A tab that came back from storage: answer false for params that name
      // nothing any more, and core drops the tab instead of drawing a ruin.
      restore: (params) => Boolean(params.name),
    });
    plugin.registerCommand({
      id: "example.note.open",
      label: "Open a scratch note",
      group: "Extensions",
      run: (app) => { app.openStageTab("example.note", { name: "scratch" }); },
    });
  },
};

export default extension;
