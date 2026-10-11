import { describe, expect, it } from "vitest";
import { previewMenuEntries, type PreviewMenuParams } from "./context-menu.js";

const page: PreviewMenuParams = {
  linkURL: "", srcURL: "", mediaType: "none", selectionText: "", isEditable: false,
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
};
const ids = (params: Partial<PreviewMenuParams>) => previewMenuEntries({ ...page, ...params }).map((entry) => entry.type === "item" ? entry.id : entry.type);

describe("the preview's right-click menu", () => {
  it("offers nothing on plain page, as before", () => {
    expect(ids({})).toEqual([]);
  });

  it("opens a web link in the browser and copies any link but a script", () => {
    expect(ids({ linkURL: "https://example.com/a" })).toEqual(["open-link", "copy-link"]);
    expect(ids({ linkURL: "mailto:a@example.com" })).toEqual(["copy-link"]);
    expect(ids({ linkURL: "javascript:alert(1)" })).toEqual([]);
  });

  it("copies the image and its address, and a data image only itself", () => {
    expect(ids({ mediaType: "image", srcURL: "https://example.com/a.png" })).toEqual(["copy-image", "copy-image-address"]);
    expect(ids({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" })).toEqual(["copy-image"]);
    expect(ids({ mediaType: "video", srcURL: "https://example.com/a.mp4" })).toEqual([]);
  });

  it("separates a linked image's groups", () => {
    expect(ids({ linkURL: "https://example.com", mediaType: "image", srcURL: "https://example.com/a.png" }))
      .toEqual(["open-link", "copy-link", "separator", "copy-image", "copy-image-address"]);
  });

  it("copies a selection, and gives a field its edits as the page allows them", () => {
    expect(ids({ selectionText: "hi", editFlags: { ...page.editFlags, canCopy: true } })).toEqual(["copy"]);
    const entries = previewMenuEntries({ ...page, isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
    expect(entries.map((entry) => entry.type === "item" ? [entry.id, entry.enabled !== false] : [])).toEqual([["cut", false], ["copy", false], ["paste", true], ["select-all", true]]);
  });
});
