/** The title on screen, which the Rename command opens; one per window. */
interface TitleField { open(): void }
let field: TitleField | undefined;
let named: ((threadId: string) => void) | undefined;

/** A rail can rename its focused row while the open conversation stays put. */
export function registerThreadRenameHandler(handler: (threadId: string) => void): () => void {
  named = handler;
  return () => { if (named === handler) named = undefined; };
}

export function registerTitleField(next: TitleField): () => void {
  field = next;
  return () => { if (field === next) field = undefined; };
}

/** The Rename command's reason for being unavailable: no title on screen. */
export const titleRenameRefusal = (): string | undefined => field ? undefined : "Open a thread to rename it.";

export function openTitleRename(threadId?: string): void {
  if (threadId && named) named(threadId);
  else field?.open();
}
