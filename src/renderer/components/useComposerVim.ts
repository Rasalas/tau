import { useState, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { ComposerKillRing } from "./useComposerReadline";

export type VimMode = "normal" | "insert";

export interface UseComposerVimOptions {
  enabled: boolean;
  text: string;
  updateDraft: (next: string) => void;
  setCaret: (pos: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit?: () => void;
  killRing?: ComposerKillRing;
}

export interface UseComposerVimResult {
  isVimEnabled: boolean;
  vimMode: VimMode;
  setVimMode: (mode: VimMode) => void;
  handleVimKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

const deferFrame = (callback: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 0);
  }
};

/**
 * Implements modal Vim editing for the Composer when enabled in Settings.
 * Supports Normal / Insert modes, motions (h,j,k,l,w,b,e,0,^,$,gg,G),
 * edits (x, dd, dw, d$, cw, cc, c$, p, P) and mode switching.
 */
export function useComposerVim(options: UseComposerVimOptions): UseComposerVimResult {
  const {
    enabled,
    text,
    updateDraft,
    setCaret,
    textareaRef,
    onSubmit,
    killRing,
  } = options;

  const [vimMode, setVimModeState] = useState<VimMode>("insert");
  const pendingOpRef = useRef<string | null>(null);
  const registerRef = useRef<string>("");

  const moveCursor = useCallback(
    (newPos: number) => {
      const clamped = Math.max(0, Math.min(text.length, newPos));
      setCaret(clamped);
      deferFrame(() => {
        textareaRef.current?.setSelectionRange(clamped, clamped);
      });
    },
    [text.length, setCaret, textareaRef],
  );

  const setVimMode = useCallback((mode: VimMode) => {
    pendingOpRef.current = null;
    setVimModeState(mode);
  }, []);

  const handleVimKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!enabled) return false;

      const el = textareaRef.current;
      const pos = el ? el.selectionStart ?? 0 : 0;

      // In INSERT mode: Escape switches to NORMAL mode
      if (vimMode === "insert") {
        if (event.key === "Escape" || (event.ctrlKey && event.key === "[")) {
          event.preventDefault();
          setVimMode("normal");
          // In Vim, leaving insert mode moves cursor left by 1 if not at line start
          if (pos > 0 && text[pos - 1] !== "\n") {
            moveCursor(pos - 1);
          }
          return true;
        }
        return false;
      }

      // In NORMAL mode: handle modal navigation and operations
      if (vimMode === "normal") {
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
      }

      return false;
    },
    [
      enabled,
      vimMode,
      text,
      updateDraft,
      moveCursor,
      setVimMode,
      onSubmit,
      killRing,
      textareaRef,
    ],
  );

  return {
    isVimEnabled: enabled,
    vimMode,
    setVimMode,
    handleVimKeyDown,
  };
}
