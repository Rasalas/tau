/**
 * What a key in the editor does: Escape does not stop the agent, and the text
 * field's own editing keys never reach a binding. Saving is `files.save`, a
 * keybinding under `editorFocus` that the window runs before the field.
 */
export type EditorKeyOutcome =
  | "indent"
  | "outdent"
  /** A new line indented like the one above. */
  | "newline"
  /** Nothing happens and nothing else hears it. */
  | "swallow"
  /** The text field's own behaviour; no workbench binding runs. */
  | "native"
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

export function editorKeyOutcome(event: KeyLike, mac: boolean, readOnly = false): EditorKeyOutcome {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Stage tabs move with ctrl+tab even from inside the editor.
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey) return "pass";
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.key === "Escape" && plain && !event.shiftKey) return "swallow";
  if (!readOnly && event.key === "Tab" && plain) return event.shiftKey ? "outdent" : "indent";
  if (!readOnly && event.key === "Enter" && plain && !event.shiftKey) return "newline";
  if (mod && !event.altKey && EDITING_KEYS.has(key)) return "native";
  if (mod) return "pass";
  // ⌃ and ⌥ chords edit text on macOS (⌃A, ⌃K, ⌥←, ⌥-letters for accents).
  if (mac && !event.metaKey) return "native";
  if (!event.ctrlKey && !event.metaKey) return "native";
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

/**
 * Indents or outdents every line the selection touches: the new text and
 * selection, and the range `from`–`to` of the old text that `replacement` takes.
 */
export function shiftLines(text: string, start: number, end: number, unit: string, outdent: boolean): { text: string; start: number; end: number; from: number; to: number; replacement: string } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at a line's start does not take that line with it.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = text.indexOf("\n", last);
  const to = lineEnd < 0 ? text.length : lineEnd;
  const lines = text.slice(from, to).split("\n");
  let firstDelta = 0;
  let total = 0;
  const shifted = lines.map((line, index) => {
    let delta: number;
    let next: string;
    if (!outdent) {
      next = unit + line;
      delta = unit.length;
    } else {
      const strip = line.startsWith(unit) ? unit.length : line.startsWith("\t") ? 1 : Math.min(line.length - line.trimStart().length, unit.length);
      next = line.slice(strip);
      delta = -strip;
    }
    if (index === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  const replacement = shifted.join("\n");
  return {
    text: text.slice(0, from) + replacement + text.slice(to),
    start: Math.max(from, start + firstDelta),
    end: Math.max(from, end + total),
    from,
    to,
    replacement,
  };
}

/** The leading whitespace of the line the caret is on. */
export function lineIndent(text: string, caret: number): string {
  const from = text.lastIndexOf("\n", caret - 1) + 1;
  return /^[\t ]*/u.exec(text.slice(from, caret))?.[0] ?? "";
}
