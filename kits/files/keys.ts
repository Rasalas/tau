/**
 * Which keys the editor keeps from the workbench's bubble-phase bindings once
 * CodeMirror has seen them. Escape does not stop the agent, and text-editing
 * keys never reach a binding. Saving is `files.save`, a keybinding under
 * `editorFocus` that the window runs before the editor.
 */
export type EditorKeyOutcome =
  /** The editor's alone; nothing else hears it. */
  | "keep"
  /** A workbench chord: the palette, closing the tab, moving between tabs. */
  | "pass";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EDITING_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);

export function editorKeyOutcome(event: KeyLike, mac: boolean): EditorKeyOutcome {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Stage tabs move with ctrl+tab even from inside the editor.
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey) return "pass";
  if (mod && !event.altKey && EDITING_KEYS.has(key)) return "keep";
  if (mod) return "pass";
  // ⌃ and ⌥ chords edit text on macOS (⌃A, ⌃K, ⌥←, ⌥-letters for accents).
  if (mac && !event.metaKey) return "keep";
  if (!event.ctrlKey && !event.metaKey) return "keep";
  return "pass";
}

/** The indentation a file already uses: tabs when most indented lines start with one. */
export function indentUnit(text: string): string {
  let tabs = 0;
  let spaces = 0;
  for (const line of text.split("\n", 2_000)) {
    if (line.startsWith("\t")) tabs += 1;
    else if (line.startsWith("  ")) spaces += 1;
  }
  return tabs > spaces ? "\t" : "  ";
}
