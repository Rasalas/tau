import { describe, expect, it } from "vitest";
import type { UiPromptAttachment } from "../shared/contracts.js";
import { promptImages } from "./prompt-attachments.js";

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
});
