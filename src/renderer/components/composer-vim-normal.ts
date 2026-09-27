import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ComposerKillRing } from "./useComposerReadline";
import type { VimMode } from "./useComposerVim";

/** What a Normal-mode key reads and changes; the hook owns the state. */
export interface VimNormalContext {
  text: string;
  pos: number;
  pendingOpRef: { current: string | null };
  registerRef: { current: string };
  updateDraft(next: string): void;
  moveCursor(pos: number): void;
  setVimMode(mode: VimMode): void;
  onSubmit?: () => void;
  killRing?: ComposerKillRing;
}

/**
 * Vim's Normal mode for the composer: motions, operators, edits and the way
 * back to Insert. Its own chunk, loaded once Vim mode is on (`useComposerVim`).
 */
export function handleVimNormalKey(event: ReactKeyboardEvent<HTMLTextAreaElement>, context: VimNormalContext): boolean {
  const { text, pos, pendingOpRef, registerRef, updateDraft, moveCursor, setVimMode, onSubmit, killRing } = context;
  // Prevent typing characters directly in normal mode
  // 1. If an operator was pending (e.g. 'd', 'c', 'g'):
  const pending = pendingOpRef.current;
  if (pending) {
    pendingOpRef.current = null;

    // dd: Delete whole line
    if (pending === "d" && event.key === "d") {
      event.preventDefault();
      const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
      let lineEnd = text.indexOf("\n", pos);
      if (lineEnd === -1) {
        lineEnd = text.length;
      } else {
        lineEnd += 1; // Include the newline
      }
      const deleted = text.slice(lineStart, lineEnd);
      registerRef.current = deleted;
      killRing?.push(deleted);
      const next = text.slice(0, lineStart) + text.slice(lineEnd);
      updateDraft(next);
      moveCursor(Math.min(lineStart, Math.max(0, next.length - 1)));
      return true;
    }

    // dw: Delete word forward
    if (pending === "d" && event.key === "w") {
      event.preventDefault();
      const after = text.slice(pos);
      const match = after.match(/^(\s*\S+|\s+)/);
      if (match) {
        const deleted = match[0];
        registerRef.current = deleted;
        killRing?.push(deleted);
        const next = text.slice(0, pos) + text.slice(pos + deleted.length);
        updateDraft(next);
        moveCursor(pos);
      }
      return true;
    }

    // d$ or D: Delete to line end
    if (pending === "d" && (event.key === "$" || event.key === "D")) {
      event.preventDefault();
      let lineEnd = text.indexOf("\n", pos);
      if (lineEnd === -1) lineEnd = text.length;
      const deleted = text.slice(pos, lineEnd);
      registerRef.current = deleted;
      killRing?.push(deleted);
      const next = text.slice(0, pos) + text.slice(lineEnd);
      updateDraft(next);
      moveCursor(Math.max(0, pos - 1));
      return true;
    }

    // cc: Change line
    if (pending === "c" && event.key === "c") {
      event.preventDefault();
      const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
      let lineEnd = text.indexOf("\n", pos);
      if (lineEnd === -1) lineEnd = text.length;
      const deleted = text.slice(lineStart, lineEnd);
      registerRef.current = deleted;
      killRing?.push(deleted);
      const next = text.slice(0, lineStart) + text.slice(lineEnd);
      updateDraft(next);
      moveCursor(lineStart);
      setVimMode("insert");
      return true;
    }

    // cw: Change word
    if (pending === "c" && event.key === "w") {
      event.preventDefault();
      const after = text.slice(pos);
      const match = after.match(/^(\S+)/);
      if (match) {
        const deleted = match[0];
        registerRef.current = deleted;
        killRing?.push(deleted);
        const next = text.slice(0, pos) + text.slice(pos + deleted.length);
        updateDraft(next);
        moveCursor(pos);
        setVimMode("insert");
      }
      return true;
    }

    // gg: Go to document start
    if (pending === "g" && event.key === "g") {
      event.preventDefault();
      moveCursor(0);
      return true;
    }

    return true;
  }

  // Mode switches
  if (event.key === "i") {
    event.preventDefault();
    setVimMode("insert");
    return true;
  }
  if (event.key === "a") {
    event.preventDefault();
    moveCursor(pos + 1);
    setVimMode("insert");
    return true;
  }
  if (event.key === "I") {
    event.preventDefault();
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const lineText = text.slice(lineStart);
    const indent = lineText.match(/^\s*/)?.[0].length ?? 0;
    moveCursor(lineStart + indent);
    setVimMode("insert");
    return true;
  }
  if (event.key === "A") {
    event.preventDefault();
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    moveCursor(lineEnd);
    setVimMode("insert");
    return true;
  }
  if (event.key === "o") {
    event.preventDefault();
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const next = text.slice(0, lineEnd) + "\n" + text.slice(lineEnd);
    updateDraft(next);
    moveCursor(lineEnd + 1);
    setVimMode("insert");
    return true;
  }
  if (event.key === "O") {
    event.preventDefault();
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const next = text.slice(0, lineStart) + "\n" + text.slice(lineStart);
    updateDraft(next);
    moveCursor(lineStart);
    setVimMode("insert");
    return true;
  }

  // Enter submits prompt in normal mode
  if (event.key === "Enter") {
    event.preventDefault();
    onSubmit?.();
    return true;
  }

  // Escape cancels pending operator or clears selection
  if (event.key === "Escape") {
    event.preventDefault();
    pendingOpRef.current = null;
    return true;
  }

  // Single key motions
  if (event.key === "h" || event.key === "ArrowLeft") {
    event.preventDefault();
    moveCursor(pos - 1);
    return true;
  }
  if (event.key === "l" || event.key === "ArrowRight") {
    event.preventDefault();
    moveCursor(pos + 1);
    return true;
  }
  if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    const currentLineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const col = pos - currentLineStart;
    if (currentLineStart > 0) {
      const prevLineEnd = currentLineStart - 1;
      const prevLineStart = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
      const prevLineLen = prevLineEnd - prevLineStart;
      moveCursor(prevLineStart + Math.min(col, prevLineLen));
    }
    return true;
  }
  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    const currentLineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const col = pos - currentLineStart;
    const currentLineEnd = text.indexOf("\n", pos);
    if (currentLineEnd !== -1) {
      const nextLineStart = currentLineEnd + 1;
      let nextLineEnd = text.indexOf("\n", nextLineStart);
      if (nextLineEnd === -1) nextLineEnd = text.length;
      const nextLineLen = nextLineEnd - nextLineStart;
      moveCursor(nextLineStart + Math.min(col, nextLineLen));
    }
    return true;
  }
  if (event.key === "0") {
    event.preventDefault();
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    moveCursor(lineStart);
    return true;
  }
  if (event.key === "^") {
    event.preventDefault();
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const lineText = text.slice(lineStart);
    const indent = lineText.match(/^\s*/)?.[0].length ?? 0;
    moveCursor(lineStart + indent);
    return true;
  }
  if (event.key === "$") {
    event.preventDefault();
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    moveCursor(Math.max(0, lineEnd - 1));
    return true;
  }
  if (event.key === "w") {
    event.preventDefault();
    const after = text.slice(pos);
    const match = after.match(/^(\S+\s*|\s+)/);
    const jump = match ? match[0].length : 1;
    moveCursor(pos + jump);
    return true;
  }
  if (event.key === "b") {
    event.preventDefault();
    const before = text.slice(0, pos);
    const match = before.match(/(\s*\S+|\s+)$/);
    const jump = match ? match[0].length : 1;
    moveCursor(pos - jump);
    return true;
  }
  if (event.key === "G") {
    event.preventDefault();
    moveCursor(text.length);
    return true;
  }

  // Operator triggers
  if (event.key === "d" || event.key === "c" || event.key === "g") {
    event.preventDefault();
    pendingOpRef.current = event.key;
    return true;
  }

  // x: Delete single character
  if (event.key === "x") {
    event.preventDefault();
    if (pos < text.length) {
      const deleted = text[pos];
      registerRef.current = deleted;
      const next = text.slice(0, pos) + text.slice(pos + 1);
      updateDraft(next);
      moveCursor(pos);
    }
    return true;
  }

  // D: Delete to end of line
  if (event.key === "D") {
    event.preventDefault();
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const deleted = text.slice(pos, lineEnd);
    registerRef.current = deleted;
    killRing?.push(deleted);
    const next = text.slice(0, pos) + text.slice(lineEnd);
    updateDraft(next);
    moveCursor(Math.max(0, pos - 1));
    return true;
  }

  // C: Change to end of line
  if (event.key === "C") {
    event.preventDefault();
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const deleted = text.slice(pos, lineEnd);
    registerRef.current = deleted;
    killRing?.push(deleted);
    const next = text.slice(0, pos) + text.slice(lineEnd);
    updateDraft(next);
    moveCursor(pos);
    setVimMode("insert");
    return true;
  }

  // p: Paste after cursor
  if (event.key === "p") {
    event.preventDefault();
    const content = registerRef.current || killRing?.peek();
    if (content) {
      const insertPos = pos + 1;
      const next = text.slice(0, insertPos) + content + text.slice(insertPos);
      updateDraft(next);
      moveCursor(insertPos + content.length - 1);
    }
    return true;
  }

  // P: Paste before cursor
  if (event.key === "P") {
    event.preventDefault();
    const content = registerRef.current || killRing?.peek();
    if (content) {
      const next = text.slice(0, pos) + content + text.slice(pos);
      updateDraft(next);
      moveCursor(pos + content.length - 1);
    }
    return true;
  }

  // Catch-all: In normal mode, ignore unmapped letter keystrokes so they don't insert text
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    return true;
  }
  return false;
}
