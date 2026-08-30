import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_CACHE_LIMIT,
  clearHighlightCache,
  highlightCacheSize,
  highlightedCode,
  loadHighlightLanguage,
} from "./Markdown";

describe("streaming markdown cache", () => {
  it("reuses highlights and evicts old entries at a fixed bound", async () => {
    await loadHighlightLanguage("typescript");
    clearHighlightCache();
    const first = highlightedCode("const value = 1", "typescript");
    expect(first).toContain("hljs-keyword");
    expect(first).toBe(highlightedCode("const value = 1", "typescript"));
    for (let index = 0; index < HIGHLIGHT_CACHE_LIMIT + 8; index += 1) {
      highlightedCode(`const value = ${index}`, "typescript");
    }
    expect(highlightCacheSize()).toBe(HIGHLIGHT_CACHE_LIMIT);
  });
});
