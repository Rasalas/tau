/** Brings the queued messages into view and puts the keyboard on the first one; false when none is drawn. */
export function revealQueuedMessages(transcript: ParentNode | null | undefined): boolean {
  const list = transcript?.querySelector<HTMLElement>(".queued-messages");
  if (!list) return false;
  list.scrollIntoView?.({ block: "nearest" });
  list.querySelector<HTMLElement>("button")?.focus();
  return true;
}
