import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { PromptHistory } from "../../workbench/prompt-history";

const deferFrame = (callback: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 0);
  }
};

export interface UseComposerReadlineOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  updateDraft: (next: string) => void;
  setCaret: (pos: number) => void;
  promptHistory: PromptHistory;
  onOpenPromptEditor?: () => void;
  onToggleExpanded?: () => void;
}

/**
 * Handles Readline / Emacs keyboard shortcuts and shell-like prompt history
 * navigation in the composer textarea.
 */
export function handleComposerReadlineKey(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  options: UseComposerReadlineOptions,
): boolean {
  const { textareaRef, text, updateDraft, setCaret, promptHistory, onOpenPromptEditor, onToggleExpanded } = options;
  const selectionStart = event.currentTarget.selectionStart;
  const selectionEnd = event.currentTarget.selectionEnd;
  const atTopLine = !text.slice(0, selectionStart).includes("\n");

  // ArrowUp: History back (when navigating or at start of top line)
  if (
    event.key === "ArrowUp" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    (promptHistory.isNavigating || (atTopLine && selectionStart === 0 && selectionEnd === 0))
  ) {
    const previous = promptHistory.navigateBack(text);
    if (previous !== undefined) {
      event.preventDefault();
      updateDraft(previous);
      setCaret(previous.length);
      deferFrame(() => textareaRef.current?.setSelectionRange(previous.length, previous.length));
      return true;
    }
  }

  // ArrowDown: History forward
  if (
    event.key === "ArrowDown" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    promptHistory.isNavigating
  ) {
    const next = promptHistory.navigateForward();
    if (next !== undefined) {
      event.preventDefault();
      updateDraft(next);
      setCaret(next.length);
      deferFrame(() => textareaRef.current?.setSelectionRange(next.length, next.length));
      return true;
    }
  }

  // Readline / Emacs line editing shortcuts (Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W)
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    const el = textareaRef.current;
    if (el) {
      const pos = el.selectionStart ?? 0;
      if (event.key === "a") {
        event.preventDefault();
        const startOfLine = text.lastIndexOf("\n", pos - 1) + 1;
        el.setSelectionRange(startOfLine, startOfLine);
        setCaret(startOfLine);
        return true;
      }
      if (event.key === "e") {
        event.preventDefault();
        let endOfLine = text.indexOf("\n", pos);
        if (endOfLine === -1) endOfLine = text.length;
        el.setSelectionRange(endOfLine, endOfLine);
        setCaret(endOfLine);
        return true;
      }
      if (event.key === "k") {
        event.preventDefault();
        let endOfLine = text.indexOf("\n", pos);
        if (endOfLine === -1) endOfLine = text.length;
        else if (endOfLine === pos) endOfLine = pos + 1;
        const nextText = text.slice(0, pos) + text.slice(endOfLine);
        updateDraft(nextText);
        setCaret(pos);
        deferFrame(() => el.setSelectionRange(pos, pos));
        return true;
      }
      if (event.key === "u") {
        event.preventDefault();
        const startOfLine = text.lastIndexOf("\n", pos - 1) + 1;
        const nextText = text.slice(0, startOfLine) + text.slice(pos);
        updateDraft(nextText);
        setCaret(startOfLine);
        deferFrame(() => el.setSelectionRange(startOfLine, startOfLine));
        return true;
      }
      if (event.key === "w") {
        event.preventDefault();
        const before = text.slice(0, pos);
        const match = before.match(/(\s*\S+)\s*$/);
        const deleteLen = match ? match[0].length : 0;
        const newPos = Math.max(0, pos - deleteLen);
        const nextText = text.slice(0, newPos) + text.slice(pos);
        updateDraft(nextText);
        setCaret(newPos);
        deferFrame(() => el.setSelectionRange(newPos, newPos));
        return true;
      }
    }
  }

  // External editor shortcut (Mod+E or Ctrl+O)
  if (
    (event.key === "o" && event.ctrlKey && !event.metaKey && !event.altKey) ||
    (event.key.toLowerCase() === "e" && (event.metaKey || event.ctrlKey) && !event.shiftKey)
  ) {
    if (onOpenPromptEditor) {
      event.preventDefault();
      onOpenPromptEditor();
      return true;
    }
  }

  // Expand/collapse composer shortcut (Mod+Shift+E)
  if (event.key.toLowerCase() === "e" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
    if (onToggleExpanded) {
      event.preventDefault();
      onToggleExpanded();
      return true;
    }
  }

  return false;
}
