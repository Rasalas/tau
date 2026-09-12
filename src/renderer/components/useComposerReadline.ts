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
  onDequeue?: () => void;
  killRing?: ComposerKillRing;
}

/**
 * Emacs / GNU Readline Kill-Ring implementation.
 * Stores deleted chunks of text, supports yanking (Ctrl+Y) and yank-pop cycling (Alt+Y).
 */
export class ComposerKillRing {
  private ring: string[] = [];
  private yankIndex = 0;
  private lastAction: "kill" | "yank" | "other" = "other";
  public lastYankLength = 0;

  push(text: string): void {
    if (!text) return;
    if (this.lastAction === "kill" && this.ring.length > 0) {
      // Consecutive kills merge into the current kill ring entry
      this.ring[0] = this.ring[0] + text;
    } else {
      this.ring.unshift(text);
      if (this.ring.length > 50) this.ring.pop();
    }
    this.yankIndex = 0;
    this.lastAction = "kill";
    this.lastYankLength = 0;
  }

  peek(): string | undefined {
    return this.ring[0];
  }

  currentYank(): string | undefined {
    if (this.ring.length === 0) return undefined;
    return this.ring[this.yankIndex % this.ring.length];
  }

  cycleYank(): string | undefined {
    if (this.ring.length <= 1) return this.currentYank();
    this.yankIndex = (this.yankIndex + 1) % this.ring.length;
    return this.ring[this.yankIndex];
  }

  markYank(length: number): void {
    this.lastAction = "yank";
    this.lastYankLength = length;
  }

  resetAction(): void {
    this.lastAction = "other";
    this.lastYankLength = 0;
  }

  get isYanking(): boolean {
    return this.lastAction === "yank";
  }
}

export const defaultKillRing = new ComposerKillRing();

/**
 * Handles Readline / Emacs keyboard shortcuts and shell-like prompt history
 * navigation in the composer textarea.
 */
export function handleComposerReadlineKey(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  options: UseComposerReadlineOptions,
): boolean {
  const {
    textareaRef,
    text,
    updateDraft,
    setCaret,
    promptHistory,
    onOpenPromptEditor,
    onToggleExpanded,
    onDequeue,
    killRing = defaultKillRing,
  } = options;
  const selectionStart = event.currentTarget.selectionStart;
  const selectionEnd = event.currentTarget.selectionEnd;
  const atTopLine = !text.slice(0, selectionStart).includes("\n");

  // Dequeue shortcut: Alt+ArrowUp or Alt+Q
  if (
    onDequeue &&
    ((event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "ArrowUp") ||
      (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "q"))
  ) {
    event.preventDefault();
    onDequeue();
    killRing.resetAction();
    return true;
  }

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
      killRing.resetAction();
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
      killRing.resetAction();
      updateDraft(next);
      setCaret(next.length);
      deferFrame(() => textareaRef.current?.setSelectionRange(next.length, next.length));
      return true;
    }
  }

  const el = textareaRef.current;
  const pos = el ? el.selectionStart ?? 0 : 0;

  // Alt+Y: Yank-pop (cycle through kill ring after yank)
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "y") {
    if (el && killRing.isYanking && killRing.lastYankLength > 0) {
      event.preventDefault();
      const oldLen = killRing.lastYankLength;
      const nextYank = killRing.cycleYank();
      if (nextYank !== undefined) {
        const replaceStart = Math.max(0, pos - oldLen);
        const nextText = text.slice(0, replaceStart) + nextYank + text.slice(pos);
        updateDraft(nextText);
        const newPos = replaceStart + nextYank.length;
        killRing.markYank(nextYank.length);
        setCaret(newPos);
        deferFrame(() => el.setSelectionRange(newPos, newPos));
        return true;
      }
    }
  }

  // Alt+B / Alt+Left: Move cursor word left
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key.toLowerCase() === "b" || event.key === "ArrowLeft")) {
    if (el) {
      event.preventDefault();
      killRing.resetAction();
      const before = text.slice(0, pos);
      const match = before.match(/(\S+\s*)$/);
      const moveLen = match ? match[0].length : 1;
      const newPos = Math.max(0, pos - moveLen);
      el.setSelectionRange(newPos, newPos);
      setCaret(newPos);
      return true;
    }
  }

  // Alt+F / Alt+Right: Move cursor word right
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key.toLowerCase() === "f" || event.key === "ArrowRight")) {
    if (el) {
      event.preventDefault();
      killRing.resetAction();
      const after = text.slice(pos);
      const match = after.match(/^(\s*\S+)/);
      const moveLen = match ? match[0].length : 1;
      const newPos = Math.min(text.length, pos + moveLen);
      el.setSelectionRange(newPos, newPos);
      setCaret(newPos);
      return true;
    }
  }

  // Alt+D / Alt+Delete: Delete word forward into kill ring
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key.toLowerCase() === "d" || event.key === "Delete")) {
    if (el) {
      event.preventDefault();
      const after = text.slice(pos);
      const match = after.match(/^(\s*\S+)/);
      if (match) {
        const killed = match[0];
        killRing.push(killed);
        const nextText = text.slice(0, pos) + text.slice(pos + killed.length);
        updateDraft(nextText);
        setCaret(pos);
        deferFrame(() => el.setSelectionRange(pos, pos));
        return true;
      }
    }
  }

  // Readline / Emacs line editing shortcuts (Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, Ctrl+Y, Ctrl+D)
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (el) {
      if (event.key === "a") {
        event.preventDefault();
        killRing.resetAction();
        const startOfLine = text.lastIndexOf("\n", pos - 1) + 1;
        el.setSelectionRange(startOfLine, startOfLine);
        setCaret(startOfLine);
        return true;
      }
      if (event.key === "e") {
        event.preventDefault();
        killRing.resetAction();
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
        const killed = text.slice(pos, endOfLine);
        killRing.push(killed);
        const nextText = text.slice(0, pos) + text.slice(endOfLine);
        updateDraft(nextText);
        setCaret(pos);
        deferFrame(() => el.setSelectionRange(pos, pos));
        return true;
      }
      if (event.key === "u") {
        event.preventDefault();
        const startOfLine = text.lastIndexOf("\n", pos - 1) + 1;
        const killed = text.slice(startOfLine, pos);
        killRing.push(killed);
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
        const killed = text.slice(newPos, pos);
        killRing.push(killed);
        const nextText = text.slice(0, newPos) + text.slice(pos);
        updateDraft(nextText);
        setCaret(newPos);
        deferFrame(() => el.setSelectionRange(newPos, newPos));
        return true;
      }
      if (event.key === "y") {
        event.preventDefault();
        const yank = killRing.currentYank();
        if (yank) {
          const nextText = text.slice(0, pos) + yank + text.slice(pos);
          updateDraft(nextText);
          const newPos = pos + yank.length;
          killRing.markYank(yank.length);
          setCaret(newPos);
          deferFrame(() => el.setSelectionRange(newPos, newPos));
          return true;
        }
      }
      if (event.key === "d" && pos < text.length) {
        event.preventDefault();
        killRing.resetAction();
        const nextText = text.slice(0, pos) + text.slice(pos + 1);
        updateDraft(nextText);
        setCaret(pos);
        deferFrame(() => el.setSelectionRange(pos, pos));
        return true;
      }
    }
  }

  // External prompt editor shortcut (Mod+E or Ctrl+G)
  if (
    (event.key.toLowerCase() === "g" && event.ctrlKey && !event.metaKey && !event.altKey) ||
    (event.key.toLowerCase() === "e" && (event.metaKey || event.ctrlKey) && !event.shiftKey)
  ) {
    if (onOpenPromptEditor) {
      event.preventDefault();
      killRing.resetAction();
      onOpenPromptEditor();
      return true;
    }
  }

  // Expand/collapse composer shortcut (Mod+Shift+E)
  if (event.key.toLowerCase() === "e" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
    if (onToggleExpanded) {
      event.preventDefault();
      killRing.resetAction();
      onToggleExpanded();
      return true;
    }
  }

  return false;
}
