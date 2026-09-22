import { describe, expect, it } from "vitest";
import type { UiPromptAttachment } from "../shared/contracts.js";
import { selectAttachmentCandidates } from "../shared/prompt-attachment-limits.js";
import { promptFiles, promptImages } from "./prompt-attachments.js";

const image: UiPromptAttachment = {
  kind: "image",
  name: "diagram.png",
  mimeType: "image/png",
  data: "iVBORw==",
  size: 4,
};

describe("prompt image adapter", () => {
  it("validates renderer attachments and maps them to Pi image content", () => {
    expect(promptImages([image])).toEqual([
      { type: "image", mimeType: "image/png", data: "iVBORw==" },
    ]);
  });

  it("rejects oversized and unsupported payloads at the host boundary", () => {
    expect(() => promptImages([{ ...image, mimeType: "image/svg+xml" }])).toThrow(/not supported/u);
    expect(() => promptImages([{ ...image, size: 11 * 1024 * 1024 }])).toThrow(/10 MB/u);
  });

  it("filters invalid items before applying attachment slots", () => {
    const result = selectAttachmentCandidates([
      { name: "notes.txt", mimeType: "text/plain", size: 12 },
      { name: "valid.png", mimeType: "image/png", size: 12 },
    ]);
    expect(result.accepted.map((item) => item.name)).toEqual(["valid.png"]);
    expect(result.rejected[0]?.reason).toBe("unsupported-type");
  });

  it("keeps images and files apart: Pi never sees a file, and a file is checked for its path", () => {
    const file: UiPromptAttachment = { kind: "file", name: "spec.pdf", mimeType: "application/pdf", path: "/state/spec.pdf", size: 10 };
    expect(promptImages([image, file])).toHaveLength(1);
    expect(promptFiles([image, file])).toEqual([file]);
    expect(() => promptFiles([{ ...file, path: "../spec.pdf" }])).toThrow(/absolute path/u);
  });
});
