import type { NativeMenuEntry } from "tau/host-extension";

/** The part of Electron's `context-menu` params the menu is built from. */
export interface PreviewMenuParams {
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export type PreviewMenuAction = "open-link" | "copy-link" | "copy-image" | "copy-image-address" | "copy" | "cut" | "paste" | "select-all";

const item = (id: PreviewMenuAction, label: string, enabled = true): NativeMenuEntry => ({ type: "item", id, label, ...(enabled ? {} : { enabled: false }) });

/** A page's link opens in the user's browser only when it is a web link. */
export const isWebLink = (url: string): boolean => /^https?:\/\//iu.test(url);
const copyableLink = (url: string): boolean => url !== "" && !/^javascript:/iu.test(url);

/**
 * What a right-click in the preview offers (T3 #17555): the link under the
 * pointer, the image under it, the selection or the field's own edits. A click
 * on plain page gets no menu, as before.
 */
export function previewMenuEntries(params: PreviewMenuParams): NativeMenuEntry[] {
  const groups: NativeMenuEntry[][] = [];
  if (copyableLink(params.linkURL)) {
    groups.push([
      ...(isWebLink(params.linkURL) ? [item("open-link", "Open Link in Browser")] : []),
      item("copy-link", "Copy Link Address"),
    ]);
  }
  if (params.mediaType === "image" && params.srcURL) {
    groups.push([
      item("copy-image", "Copy Image"),
      ...(params.srcURL.startsWith("data:") ? [] : [item("copy-image-address", "Copy Image Address")]),
    ]);
  }
  if (params.isEditable) {
    groups.push([
      item("cut", "Cut", params.editFlags.canCut),
      item("copy", "Copy", params.editFlags.canCopy),
      item("paste", "Paste", params.editFlags.canPaste),
      item("select-all", "Select All", params.editFlags.canSelectAll),
    ]);
  } else if (params.selectionText) {
    groups.push([item("copy", "Copy", params.editFlags.canCopy)]);
  }
  return groups.flatMap((group, index) => index === 0 ? group : [{ type: "separator" } as NativeMenuEntry, ...group]);
}
