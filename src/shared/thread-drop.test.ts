import { describe, expect, it } from "vitest";
import { THREAD_DROP_FEEDBACK, classifyThreadDrop } from "./thread-drop.js";

describe("thread drop policy", () => {
  it("ignores string items while classifying file items", () => {
    expect(classifyThreadDrop(true, [
      { kind: "string", mimeType: "text/plain" },
      { kind: "file", mimeType: "image/png" },
    ], true)).toBe("valid");
  });

  it("marks empty MIME file items as unsupported and mixed files as mixed", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "" }], true)).toBe("unsupported");
    expect(classifyThreadDrop(true, [
      { kind: "file", mimeType: "image/png" },
      { kind: "file", mimeType: "" },
    ], true)).toBe("mixed");
  });

  it("uses the runtime capability and shared feedback mapping", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "image/png" }], false)).toBe("unavailable");
    expect(THREAD_DROP_FEEDBACK.unavailable.dropEffect).toBe("none");
    expect(THREAD_DROP_FEEDBACK.valid.dropEffect).toBe("copy");
  });
});
