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
export function requestFind(node: Element | null | undefined): void {
  node?.dispatchEvent(new CustomEvent(FIND_EVENT));
}

export function answerFind(node: Element, open: () => void): () => void {
  node.addEventListener(FIND_EVENT, open);
  return () => node.removeEventListener(FIND_EVENT, open);
}
