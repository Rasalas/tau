import { describe, expect, it } from "vitest";
import { CHAT_DROP_FEEDBACK, classifyChatDrop } from "./chat-drop.js";

describe("chat drop policy", () => {
  it("ignores string items while classifying file items", () => {
    expect(classifyChatDrop(true, [
      { kind: "string", mimeType: "text/plain" },
      { kind: "file", mimeType: "image/png" },
    ], true)).toBe("valid");
  });

  it("marks empty MIME file items as unsupported and mixed files as mixed", () => {
    expect(classifyChatDrop(true, [{ kind: "file", mimeType: "" }], true)).toBe("unsupported");
    expect(classifyChatDrop(true, [
      { kind: "file", mimeType: "image/png" },
      { kind: "file", mimeType: "" },
    ], true)).toBe("mixed");
  });

  it("uses the runtime capability and shared feedback mapping", () => {
    expect(classifyChatDrop(true, [{ kind: "file", mimeType: "image/png" }], false)).toBe("unavailable");
    expect(CHAT_DROP_FEEDBACK.unavailable.dropEffect).toBe("none");
    expect(CHAT_DROP_FEEDBACK.valid.dropEffect).toBe("copy");
  });
});
