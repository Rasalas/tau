import { combineWakes } from "../shared/message-turns";
import type { ClientStorage } from "../workbench/client-storage";
import { allocateAttachmentId, type ComposerScopeStore } from "../workbench/composer-scope-store";
import { draftKey, readComposerDraft, writeComposerDraft } from "../workbench/draft-store";
import type { UiPromptImageAttachment, UiQueuedMessage, UiQueuedPrompt } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import type { ComposerPort } from "./use-follow-up-queue";
import type { WorkbenchActions } from "./extension-system";

/** The composer of a thread that is not on screen: its scope, starting from its saved draft when the scope was never loaded. */
export function threadComposer(scopes: ComposerScopeStore, storage: ClientStorage, threadId: string, notify: ComposerPort["notify"]): ComposerPort {
  const key = draftKey(threadId)!;
  return {
    composerDraft: () => scopes.getSnapshot(key).draft || readComposerDraft(storage, key),
    setComposerDraft: (text) => { scopes.setDraft(key, text); writeComposerDraft(storage, key, text); },
    composerImages: () => scopes.getSnapshot(key).attachments.map(({ id: _id, previewUrl: _url, ...image }) => image),
    setComposerImages: (images) => scopes.setAttachments(key, images.map((image) => ({
      ...image, id: allocateAttachmentId(), previewUrl: `data:${image.mimeType};base64,${image.data}`,
    }))),
    notify,
  };
}

/** Several waiting wakes leave as one prompt; a normal message keeps its identity. */
export async function takeForSteer(take: (id?: string, threadId?: string) => Promise<UiQueuedPrompt[]>, threadId: string, id: string, queue: readonly UiQueuedMessage[]): Promise<UiQueuedPrompt | undefined> {
  const wakes = queue.some((entry) => entry.id === id && entry.wake) ? queue.filter((entry) => entry.wake) : [];
  const taken = wakes.length > 1 ? (await Promise.all(wakes.map((entry) => take(entry.id, threadId)))).flat() : await take(id, threadId);
  return taken.length > 1 ? { ...taken[0]!, ...combineWakes(taken.map((entry) => entry.text)), attachments: taken.flatMap((entry) => entry.attachments) } : taken[0];
}

/** Puts messages that were not sent back into the composer, below its draft; images come back as images. */
export function returnToComposer(actions: ComposerPort | undefined, taken: readonly UiQueuedPrompt[]): void {
  // A wake is not the user's text: taking it out drops it.
  const items = taken.filter((item) => !item.wake);
  if (!actions || items.length === 0) return;
  const texts = items.map((item) => item.text.trim()).filter(Boolean);
  if (texts.length > 0) actions.setComposerDraft?.([actions.composerDraft().trimEnd(), ...texts].filter(Boolean).join("\n\n"));
  const images = items.flatMap((item) => item.attachments.filter((attachment): attachment is UiPromptImageAttachment => attachment.kind === "image"));
  if (images.length > 0) actions.setComposerImages?.([...(actions.composerImages?.() ?? []), ...images]);
  if (items.some((item) => item.attachments.some((attachment) => attachment.kind === "file"))) {
    actions.notify("The queued message's files did not come back; attach them again.");
  }
}

/** Puts a message taken out of the queue back where it stood: queued again, then moved to its old place in the line. */
export async function requeue(client: Pick<HostClient, "queueMessage" | "moveQueued">, sessionId: string, item: UiQueuedPrompt, index: number): Promise<void> {
  const { id } = await client.queueMessage(sessionId, item.text, item.attachments, item.skillDraft, item.deliverAt);
  if (item.deliverAt === undefined) await client.moveQueued(sessionId, id, index);
}

/** Removes a message with Undo, on the thread captured before loading this module. */
export async function removeQueued(client: HostClient, threadId: string, id: string, index: number, toast: WorkbenchActions["toast"] | undefined, report: (error: unknown) => void): Promise<void> {
  const [item] = await client.takeQueued(threadId, id);
  if (!item || item.wake || !toast) return;
  const line = item.text.trim().split("\n")[0] ?? "";
  toast({
    id: "tau.queue.removed",
    type: "success",
    title: "Removed from the queue",
    ...(line ? { description: line.length > 80 ? `${line.slice(0, 79)}…` : line } : {}),
    actions: [{ label: "Undo", run: () => { void requeue(client, threadId, item, index).catch(report); } }],
  });
}
