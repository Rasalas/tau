import { pathToFileURL } from "node:url";
import type { ThreadBackendCapabilities, TurnActivityStore, UiPromptAttachment } from "tau/host-extension";
import type { AcpContentBlock } from "./session.js";

/**
 * Text first, then images as native content and files as links the agent
 * opens itself; the agent reads a slash command from the leading text.
 */
export function promptBlocks(text: string, attachments: readonly UiPromptAttachment[] | undefined): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = text.trim() ? [{ type: "text", text }] : [];
  for (const attachment of attachments ?? []) {
    blocks.push(attachment.kind === "image"
      ? { type: "image", data: attachment.data, mimeType: attachment.mimeType }
      : { type: "resource_link", uri: pathToFileURL(attachment.path).href, name: attachment.name, mimeType: attachment.mimeType });
  }
  return blocks;
}

export function imagesOf(attachments: readonly UiPromptAttachment[] | undefined): Array<{ mimeType: string; data: string }> {
  return (attachments ?? []).flatMap((attachment) => attachment.kind === "image" ? [{ mimeType: attachment.mimeType, data: attachment.data }] : []);
}

/** The capability over a kit's store; the agent's own history is not read back. */
export function activityHistory(threadId: string, store: TurnActivityStore | undefined): Pick<ThreadBackendCapabilities, "activityHistory"> {
  return store ? { activityHistory: { load: () => store.load(threadId), save: (entry) => store.save(threadId, entry) } } : {};
}

/** The first line of a text, without Markdown emphasis or closing punctuation, as a thread title. */
export function derivedTitle(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}
