import { describe, expect, it } from "vitest";
import { validateImageDataUrl } from "./image-clipboard.js";

describe("validateImageDataUrl", () => {
  it("accepts supported base64 image data URLs", () => {
    expect(validateImageDataUrl("data:image/png;base64,iVBORw==")).toBe("data:image/png;base64,iVBORw==");
  });

  it.each([
    undefined,
    "https://example.com/image.png",
    "data:text/plain;base64,SGk=",
    "data:image/png;base64,not-base64",
    "data:image/png;base64,",
  ])("rejects unsafe or malformed image data: %s", (value) => {
    expect(() => validateImageDataUrl(value)).toThrow("Invalid image data.");
  });
});
