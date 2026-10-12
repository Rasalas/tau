/**
 * How a message anywhere on screen asks the transcript to bring another into
 * view: a DOM event on the transcript's scroll node, which the viewport that
 * owns the node answers. Nothing else knows the viewport.
 */
const REVEAL_EVENT = "tau:reveal-message";

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
