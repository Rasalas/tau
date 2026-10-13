/**
 * A kit's messages in the order they began, as the live view shows them. A kit
 * stores a steer when it is sent but an answer only when it ends, so a steer
 * sent mid-answer sits above that answer in its store.
 */
export function inStartOrder<T extends { timestamp?: number }>(messages: readonly T[]): T[] {
  // Without a time on every message there is nothing to order by; the store's order stands.
  if (!messages.every((message) => Number.isFinite(message.timestamp))) return [...messages];
  return [...messages].sort((left, right) => left.timestamp! - right.timestamp!);
}
