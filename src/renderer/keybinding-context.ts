/**
 * The contexts a `when` clause reads, taken from the page when a key goes
 * down. An element marked `data-keybinding-context="terminal"` (several names
 * may be space-separated) makes `terminalFocus` true while the keyboard is
 * inside it and `terminalOpen` true while it is drawn at all.
 */
export const KEYBINDING_CONTEXT_ATTRIBUTE = "data-keybinding-context";

function marked(name: string): string {
  return `[${KEYBINDING_CONTEXT_ATTRIBUTE}~="${name.replace(/["\\]/gu, "")}"]`;
}

export function domKeybindingContext(root: Document | undefined = typeof document === "undefined" ? undefined : document): (name: string) => boolean {
  const answers = new Map<string, boolean>();
  const read = (name: string): boolean => {
    if (!root) return false;
    const focus = /^(.+)Focus$/u.exec(name);
    if (focus) {
      const active = root.activeElement;
      return Boolean(active?.isConnected && active.closest(marked(focus[1]!)));
    }
    const open = /^(.+)Open$/u.exec(name);
    if (open) {
      // Mounted but hidden (a closed dock keeps its panels) does not count as open.
      return [...root.querySelectorAll(marked(open[1]!))].some((element) => typeof element.checkVisibility === "function" ? element.checkVisibility() : true);
    }
    return false;
  };
  return (name) => {
    let answer = answers.get(name);
    if (answer === undefined) answers.set(name, answer = read(name));
    return answer;
  };
}
