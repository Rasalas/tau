import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TranscriptFindMode } from "../../workbench/transcript-find";
import type { UiMessage } from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { clearTranscriptHighlights, highlightTranscript } from "./transcript-highlights";
import { answerReveal } from "./transcript-reveal";
import { findMessageElement } from "./transcript-scroll-controller";

/** How long the row a reveal lands on stays marked; the animation in styles.css is as long. */
const FLASH_MS = 1_600;
/** Frames to wait for a virtualized row to mount before giving up on marking it. */
const FLASH_FRAMES = 60;

interface RevealOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  messages: readonly UiMessage[];
  jumpToMessage(messageId: string): void;
  /** Loads older turns until the message is among them; false when the thread does not reach back to it. */
  loadThrough?(messageId: string): Promise<boolean>;
}

function flash(node: HTMLElement, messageId: string): () => void {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let marked: HTMLElement | undefined;
  const mark = () => {
    marked = findMessageElement(node, messageId);
    if (marked) {
      marked.classList.add("reveal-flash");
      timer = setTimeout(() => marked?.classList.remove("reveal-flash"), FLASH_MS);
    } else if (attempts++ < FLASH_FRAMES) frame = requestAnimationFrame(mark);
  };
  mark();
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    marked?.classList.remove("reveal-flash");
  };
}

/**
 * Answers `requestReveal` on the transcript: loads the turns a message sits in
 * when they are not there, scrolls to it once the row exists and marks it.
 */
export function useTranscriptReveal({ scrollRef, sessionId, messages, jumpToMessage, loadThrough }: RevealOptions): (messageId: string) => Promise<boolean> {
  const [pending, setPending] = useState<{ messageId: string; sessionId?: string }>();
  const lifetime = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    lifetime.current = {};
    return () => { lifetime.current = undefined; };
  }, [sessionId]);
  const latest = useRef({ messages, loadThrough, sessionId });
  useLayoutEffect(() => { latest.current = { messages, loadThrough, sessionId }; });

  const reveal = useCallback(async (messageId: string): Promise<boolean> => {
    if (latest.current.sessionId !== sessionId) return false;
    const scope = lifetime.current;
    const { messages: loaded, loadThrough: load } = latest.current;
    if (!loaded.some((message) => message.id === messageId) && !(await load?.(messageId))) return false;
    if (!scope || lifetime.current !== scope) return false;
    setPending({ messageId, sessionId });
    return true;
  }, [sessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    return node ? answerReveal(node, reveal) : undefined;
  }, [reveal, scrollRef]);

  // The mark outlives the effect that sets it, so it has a slot of its own.
  const unflash = useRef<() => void>(() => {});
  useEffect(() => () => unflash.current(), [sessionId]);
  useEffect(() => { setPending(undefined); }, [sessionId]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!pending || pending.sessionId !== sessionId || !node || !messages.some((message) => message.id === pending.messageId)) return;
    jumpToMessage(pending.messageId);
    setPending(undefined);
    unflash.current();
    unflash.current = flash(node, pending.messageId);
  }, [jumpToMessage, messages, pending, scrollRef, sessionId]);
  return reveal;
}

/**
 * What the transcript search needs from the window: the finder an extension
 * registered, and the words marked in the text as the search moves.
 */
export function useTranscriptFind(scrollRef: RefObject<HTMLDivElement | null>, sessionId: string | undefined) {
  const registry = useContext(WorkbenchShellContext)?.registry;
  const finder = registry?.getTranscriptFinder();
  const find = useMemo(
    () => sessionId && finder ? (query: string, mode?: TranscriptFindMode) => finder.find({ sessionId, query, ...(mode ? { mode } : {}) }) : undefined,
    [finder, sessionId],
  );
  const [active, setActive] = useState<{ query: string; messageId?: string; mode?: TranscriptFindMode; sessionId?: string }>({ query: "" });
  const onActive = useCallback((query: string, messageId?: string, mode?: TranscriptFindMode) => {
    setActive((current) => current.query === query && current.messageId === messageId && current.mode === mode && current.sessionId === sessionId ? current : { query, messageId, mode, sessionId });
  }, [sessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !active.query || active.sessionId !== sessionId) { clearTranscriptHighlights(); return; }
    let frame = 0;
    // Rows mount and unmount as the reader scrolls: mark again after the next change.
    const paint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => highlightTranscript(node, active.query, active.messageId, active.mode)); };
    const observer = new MutationObserver(paint);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    paint();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); clearTranscriptHighlights(); };
  }, [active, scrollRef, sessionId]);

  return { find, onActive };
}
