import { describe, expect, it, vi } from "vitest";
import type { UiPromptImageAttachment } from "tau";
import { attachAnnotations, attachPickedElement, attachRecording } from "./attach.js";
import type { ComposerContextChips, PreviewChipInput } from "./protocol.js";

const ELEMENT = {
  url: "http://localhost:8000/",
  title: "Home",
  selector: "#save",
  tag: "button",
  text: "Save",
  rect: { x: 1, y: 2, width: 3, height: 4 },
  html: "<button id=\"save\">Save</button>",
  viewport: { width: 800, height: 600 },
};

function composer(options: { images?: boolean } = {}) {
  let draft = "typed";
  let images: readonly UiPromptImageAttachment[] = [{ kind: "image", name: "earlier.png", mimeType: "image/png", data: "AAAA", size: 3 }];
  const actions = {
    composerDraft: () => draft,
    setComposerDraft: (text: string) => { draft = text; },
    focusComposer: vi.fn(),
    ...(options.images === false ? {} : {
      composerImages: () => images,
      setComposerImages: (next: readonly UiPromptImageAttachment[]) => { images = next; },
    }),
  };
  const added: PreviewChipInput[] = [];
  const chips: ComposerContextChips = { addChip: (chip) => { added.push(chip); return `chip-${added.length}`; }, removeChip: () => undefined };
  return { actions, chips, added, draft: () => draft, images: () => images };
}

describe("handing results to the composer", () => {
  it("puts a picked element in as an excerpt chip and its image beside the draft's images", () => {
    const target = composer();
    expect(attachPickedElement(target.actions, { element: ELEMENT, image: { data: "iVBORw0KGgo=", width: 10, height: 10 } }, target.chips)).toBeUndefined();
    expect(target.added).toEqual([expect.objectContaining({ kind: "text-excerpt", label: "<button> · localhost:8000" })]);
    expect((target.added[0]!.payload as { source: string }).source).toContain("the attached image shows it");
    expect(target.images().map((image) => [image.name, image.size])).toEqual([["earlier.png", 3], ["preview-button.png", 8]]);
  });

  it("does not promise an image a composer cannot take", () => {
    const target = composer({ images: false });
    attachPickedElement(target.actions, { element: ELEMENT, image: { data: "iVBORw0KGgo=", width: 10, height: 10 } }, target.chips);
    expect((target.added[0]!.payload as { source: string }).source).not.toContain("image");
  });

  it("writes the excerpt into the draft when Composer Context is off", () => {
    const target = composer();
    attachAnnotations(target.actions, { annotations: { url: "http://localhost:8000/", title: "", viewport: { width: 8, height: 6 }, items: [] } }, undefined);
    expect(target.draft()).toBe("typed\n\nFrom the Preview, annotations the user drew on http://localhost:8000/:\nviewport: 8×6 CSS px\n(the user drew nothing)");
  });

  it("says why when no composer is open, and adds no image then", () => {
    const target = composer();
    const chips: ComposerContextChips = { addChip: () => { throw new Error("No composer is open to take the chip."); }, removeChip: () => undefined };
    expect(attachPickedElement(target.actions, { element: ELEMENT, image: { data: "AAAA", width: 1, height: 1 } }, chips)).toBe("No composer is open to take the chip.");
    expect(target.images()).toHaveLength(1);
  });

  it("attaches a recording as a file chip, and names a huge one's path instead", () => {
    const target = composer();
    const recording = { path: "/state/recordings/preview-1.webm", name: "preview-1.webm", size: 1_000, durationMs: 4_400, mimeType: "video/webm" };
    attachRecording(target.actions, recording, target.chips);
    expect(target.added.at(-1)).toEqual({
      kind: "attachment",
      label: "preview-1.webm · 4 s",
      payload: { name: "preview-1.webm", mimeType: "video/webm", size: 1_000, path: "/state/recordings/preview-1.webm" },
    });
    attachRecording(target.actions, { ...recording, size: 80 * 1024 * 1024 }, target.chips);
    expect(target.added.at(-1)).toMatchObject({ kind: "text-excerpt", payload: { text: "4 s of video (video/webm), saved at /state/recordings/preview-1.webm" } });
  });
});
