/**
 * The contexts a `when` clause reads, taken from the page when a key goes
 * down. An element marked `data-keybinding-context="terminal"` (several names
 * may be space-separated) makes `terminalFocus` true while the keyboard is
 * inside it and `terminalOpen` true while it is drawn at all. Two contexts no
 * element marks: `editableFocus` (a text field, a select or anything
 * `contenteditable` has the keyboard) and `overlayOpen` (see `OVERLAY_SELECTOR`).
 */
export const KEYBINDING_CONTEXT_ATTRIBUTE = "data-keybinding-context";
/** Marks an element that records chords: while it has the keyboard, no chord runs. */
export const KEYBINDING_CAPTURE_ATTRIBUTE = "data-keybinding-capture";

/** What owns the keyboard for text editing, so a chord native editing shares (`mod+z`) yields to it. */
const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/**
 * What floats over the workbench and closes on Escape: a modal, a dialog or
 * popover, a menu, or anything marked `data-overlay`. `data-overlay="false"`
 * opts a non-modal tool window (the theme editor) out.
 */
export const OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  "[data-overlay]",
].map((selector) => `${selector}:not([data-overlay="false"])`).join(",");

/** Whether an overlay is drawn; a closed one kept mounted but hidden does not count. */
export function overlayOpen(root: ParentNode = document): boolean {
  return [...root.querySelectorAll(OVERLAY_SELECTOR)].some(visible);
}

function visible(element: Element): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
}

function marked(name: string): string {
  return `[${KEYBINDING_CONTEXT_ATTRIBUTE}~="${name.replace(/["\\]/gu, "")}"]`;
}

export function domKeybindingContext(root: Document | undefined = typeof document === "undefined" ? undefined : document): (name: string) => boolean {
  const answers = new Map<string, boolean>();
  const read = (name: string): boolean => {
    if (!root) return false;
    if (name === "editableFocus") {
      const active = root.activeElement;
      return Boolean(active?.isConnected && active.closest(EDITABLE_SELECTOR));
    }
    if (name === "overlayOpen") return overlayOpen(root);
    const focus = /^(.+)Focus$/u.exec(name);
    if (focus) {
      const active = root.activeElement;
      return Boolean(active?.isConnected && active.closest(marked(focus[1]!)));
    }
    const open = /^(.+)Open$/u.exec(name);
    if (open) {
      // Mounted but hidden (a closed dock keeps its panels) does not count as open.
      return [...root.querySelectorAll(marked(open[1]!))].some(visible);
    }
    return false;
  };
  return (name) => {
    let answer = answers.get(name);
    if (answer === undefined) answers.set(name, answer = read(name));
    return answer;
  };
}
