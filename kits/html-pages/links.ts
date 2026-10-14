import type { WorkbenchActions } from "tau";
import type { PreviewLinksService } from "./protocol.js";

/** Preview Kit's link rule, while that kit is on. */
let preview: PreviewLinksService | undefined;

export function holdPreviewLinks(service: PreviewLinksService): () => void {
  preview = service;
  return () => { if (preview === service) preview = undefined; };
}

/**
 * Opens a link a page handed over the way a link in a reply opens: in the
 * Preview when Settings → Preview says so, otherwise in the system browser.
 */
export function openPageLink(url: string, event: { metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, actions: Pick<WorkbenchActions, "openPanel" | "openExternal">): void {
  if (!preview?.open(url, event, actions)) actions.openExternal(url);
}
