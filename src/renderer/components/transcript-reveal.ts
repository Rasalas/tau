import type { RefObject } from "react";
import { PendingThreadFind, type TranscriptFindMode, type TranscriptFindOptions } from "../../workbench/transcript-find";

/**
 * How a message anywhere on screen asks the transcript to bring another into
 * view, and how a command asks it to open its find bar: DOM events on the
 * transcript's scroll node, which the viewport that owns the node answers.
 * Nothing else knows the viewport.
 */
const REVEAL_EVENT = "tau:reveal-message";
const FIND_EVENT = "tau:find-in-transcript";

interface RevealRequest {
  messageId: string;
  result?: Promise<boolean>;
}

/** Resolves true once the message is in view, false when the thread has no such message or nothing answers. */
export function requestReveal(node: Element | null | undefined, messageId: string): Promise<boolean> {
  if (!node) return Promise.resolve(false);
  const detail: RevealRequest = { messageId };
  node.dispatchEvent(new CustomEvent<RevealRequest>(REVEAL_EVENT, { detail }));
  return detail.result ?? Promise.resolve(false);
}

export function answerReveal(node: Element, reveal: (messageId: string) => Promise<boolean>): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<RevealRequest>).detail;
    detail.result ??= reveal(detail.messageId);
  };
  node.addEventListener(REVEAL_EVENT, listener);
  return () => node.removeEventListener(REVEAL_EVENT, listener);
}

/** Opens the transcript's find bar, or moves the keyboard back into it when it is open; nothing happens without a transcript. */
export function requestFind(node: Element | null | undefined, query?: string, mode?: TranscriptFindMode): void {
  node?.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: { query, mode } }));
}

export function answerFind(node: Element, open: (query?: string, mode?: TranscriptFindMode) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ query?: string; mode?: TranscriptFindMode }>).detail;
    open(detail?.query, detail?.mode);
  };
  node.addEventListener(FIND_EVENT, listener);
  return () => node.removeEventListener(FIND_EVENT, listener);
}

// The ref belongs to the workbench window, outliving each thread's DOM node.
const pendingFinds = new WeakMap<RefObject<HTMLDivElement | null>, PendingThreadFind>();
function pendingFind(ref: RefObject<HTMLDivElement | null>): PendingThreadFind {
  let pending = pendingFinds.get(ref);
  if (!pending) { pending = new PendingThreadFind(); pendingFinds.set(ref, pending); }
  return pending;
}

export function requestTranscriptFind(ref: RefObject<HTMLDivElement | null>, query?: string, options?: TranscriptFindOptions): void {
  const pending = pendingFind(ref);
  if (options?.sessionId) pending.request({ sessionId: options.sessionId, query, mode: options.mode });
  else {
    pending.clear();
    requestFind(ref.current, query, options?.mode);
  }
}

/** Register only once the viewport owns this ref and its session. Consumed requests never replay on return. */
export function answerTranscriptFind(ref: RefObject<HTMLDivElement | null>, sessionId: string | undefined, open: (query?: string, mode?: TranscriptFindMode) => void): () => void {
  const stopEvent = ref.current ? answerFind(ref.current, open) : undefined;
  const stopPending = sessionId ? pendingFind(ref).answer(sessionId, request => open(request.query, request.mode)) : undefined;
  return () => { stopEvent?.(); stopPending?.(); };
}
