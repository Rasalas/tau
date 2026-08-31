import { describe, expect, it } from "vitest";
import { THREAD_DROP_FEEDBACK, classifyThreadDrop } from "./thread-drop.js";
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./prompt-attachment-limits.js";

describe("thread drop policy", () => {
  it("ignores string items while classifying file items", () => {
    expect(classifyThreadDrop(true, [
      { kind: "string", mimeType: "text/plain" },
      { kind: "file", mimeType: "image/png", size: 1 },
    ], true)).toBe("valid");
  });

  it("reports an exact type reason and mixed files as mixed", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "", size: 1 }], true)).toBe("invalid-type");
    expect(classifyThreadDrop(true, [
      { kind: "file", mimeType: "image/png", size: 1 },
      { kind: "file", mimeType: "", size: 1 },
    ], true)).toBe("mixed");
  });

  it("uses the runtime capability and shared feedback mapping", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png", size: 1 }], false)).toBe("unavailable");
    expect(THREAD_DROP_FEEDBACK.unavailable.dropEffect).toBe("none");
    expect(THREAD_DROP_FEEDBACK.valid.dropEffect).toBe("copy");
  });

  it("marks a known oversized file as rejected before the drop", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png", size: MAX_IMAGE_BYTES + 1 }], true)).toBe("invalid-size");
    expect(THREAD_DROP_FEEDBACK["invalid-size"].dropEffect).toBe("none");
    expect(classifyThreadDrop(true, [
      { kind: "file", mimeType: "image/png", size: 1 },
      { kind: "file", mimeType: "image/png", size: MAX_IMAGE_BYTES + 1 },
    ], true)).toBe("mixed");
  });

  it("reports attachment-count and total-size reasons", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png", size: 1 }], true, MAX_ATTACHMENTS)).toBe("too-many");
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png", size: 1 }], true, 1, MAX_TOTAL_IMAGE_BYTES)).toBe("total-size");
  });

  it("never presents unknown file metadata as a valid copy", () => {
    expect(classifyThreadDrop(true, [], true)).toBe("unknown");
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png" }], true)).toBe("unknown");
    expect(classifyThreadDrop(true, [
      { kind: "file", mimeType: "image/png", size: 1 },
      { kind: "file", mimeType: "image/png" },
    ], true)).toBe("unknown");
    expect(THREAD_DROP_FEEDBACK.unknown.dropEffect).toBe("none");
    expect(classifyThreadDrop(true, [{ kind: "other", mimeType: "" }], true)).toBe("unknown");
  });
});
