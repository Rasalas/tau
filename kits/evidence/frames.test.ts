import { describe, expect, it } from "vitest";
import { changedPixels, isDuplicate, isScreenTool, previewCaption, previewToolName, screenCaption, type Luma } from "./frames.js";

const luma = (values: number[], width = values.length): Luma => ({ width, height: 1, pixels: Uint8Array.from(values) });

describe("frame comparison", () => {
  it("counts pixels whose brightness moved past compression noise", () => {
    expect(changedPixels(luma([10, 10, 10]), luma([20, 30, 10]))).toBe(1);
    expect(changedPixels(luma([0, 0]), luma([0, 0, 0]))).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps any visible change after an action, only a real one on the clock, and always the agent's own", () => {
    const blank = luma(Array.from({ length: 1000 }, () => 200));
    const oneGlyph = luma(Array.from({ length: 1000 }, (_value, index) => index === 3 ? 20 : 200));
    expect(isDuplicate(undefined, blank, "action")).toBe(false);
    expect(isDuplicate(blank, blank, "action")).toBe(true);
    expect(isDuplicate(blank, oneGlyph, "action")).toBe(false);
    expect(isDuplicate(blank, oneGlyph, "periodic")).toBe(true);
    expect(isDuplicate(blank, blank, "agent")).toBe(false);
  });
});

describe("captions", () => {
  it("finds the Preview tool behind any runtime's prefix", () => {
    expect(previewToolName("preview_click")).toBe("preview_click");
    expect(previewToolName("mcp__tau__preview_click")).toBe("preview_click");
    expect(previewToolName("read")).toBeUndefined();
    expect(isScreenTool("computer_use_click")).toBe(true);
    expect(isScreenTool("mcp__tau__preview_open")).toBe(false);
  });

  it("says what a Preview call did without repeating what was typed", () => {
    expect(previewCaption("preview_open", { url: "http://localhost:5173/" })).toBe("Opened http://localhost:5173/");
    expect(previewCaption("preview_navigate", { action: "reload" })).toBe("Reloaded the page");
    expect(previewCaption("preview_click", { text: "Save" })).toBe("Clicked “Save”");
    expect(previewCaption("mcp__tau__preview_type", { text: "hunter2", submit: true })).toBe("Typed 7 characters and submitted");
    expect(previewCaption("preview_snapshot", {})).toBe("Looked at the page");
  });

  it("says what an input to the driven window did", () => {
    expect(screenCaption({ id: "1", kind: "key", at: 1, keys: ["cmd", "a"] }, "TextEdit")).toBe("Pressed ⌘A");
    expect(screenCaption({ id: "1", kind: "type", at: 1, text: "hello" }, "TextEdit")).toBe("Typed 5 characters");
    expect(screenCaption(undefined, "TextEdit")).toBe("Looked at TextEdit");
  });
});
