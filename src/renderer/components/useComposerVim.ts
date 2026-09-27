import { useState, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { ComposerKillRing } from "./useComposerReadline";
import { loadVimNormalKeys } from "../deferred-surfaces";

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

  // Normal mode's keys are a chunk of their own; Vim starts in Insert, so they arrive before they are needed.
  useEffect(() => {
    if (enabled) void loadVimNormalKeys().catch(() => undefined);
  }, [enabled]);

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
        const normalKeys = loadVimNormalKeys.current;
        if (normalKeys) {
          return normalKeys.handleVimNormalKey(event, { text, pos, pendingOpRef, registerRef, updateDraft, moveCursor, setVimMode, onSubmit, killRing });
        }
        // Its chunk is still on the way: a letter must not land in the text meanwhile.
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
