import type { UiSession } from "../shared/contracts";

/** Why this window cannot rename the thread, or undefined. A thread of another machine keeps its title there. */
export function renameRefusal(session: Pick<UiSession, "machine"> | undefined): string | undefined {
  return session?.machine ? `Renaming a thread of ${session.machine.name} is not available from this window yet.` : undefined;
}

/** The title on screen, which the Rename command opens; one per window. */
interface TitleField { open(): void; refusal(): string | undefined }
let field: TitleField | undefined;

export function registerTitleField(next: TitleField): () => void {
  field = next;
  return () => { if (field === next) field = undefined; };
}

/** The Rename command's reason for being unavailable: no title on screen, or the thread cannot be renamed. */
export const titleRenameRefusal = (): string | undefined => field ? field.refusal() : "Open a thread to rename it.";

export function openTitleRename(): void {
  if (!field?.refusal()) field?.open();
}
