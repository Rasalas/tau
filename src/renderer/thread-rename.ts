/** The title on screen, which the Rename command opens; one per window. */
interface TitleField { open(): void }
let field: TitleField | undefined;

export function registerTitleField(next: TitleField): () => void {
  field = next;
  return () => { if (field === next) field = undefined; };
}

/** The Rename command's reason for being unavailable: no title on screen. */
export const titleRenameRefusal = (): string | undefined => field ? undefined : "Open a thread to rename it.";

export function openTitleRename(): void {
  field?.open();
}
