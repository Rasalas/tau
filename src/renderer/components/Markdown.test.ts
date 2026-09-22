import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_CACHE_LIMIT,
  Markdown,
  clearHighlightCache,
  highlightCacheSize,
  highlightedCode,
  isInlineMarkdown,
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

  it("keeps GFM tables and indented code as block Markdown beside a skill chip", () => {
    expect(isInlineMarkdown("| name | value |\n| --- | --- |\n| tdd | ready |\n"))
      .toBe(false);
    expect(isInlineMarkdown("| skill |\n| --- |\n| tdd |\n"))
      .toBe(false);
    expect(isInlineMarkdown("Review **the parser**"))
      .toBe(true);
    expect(isInlineMarkdown("Review this:\n    preserve code"))
      .toBe(false);
  });

  it("renders every GFM extension with the parse-only plugin", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "~~gone~~ https://example.com\n\n- [x] done\n\nNote[^1]\n\n[^1]: Footnote\n"));
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("md-check on");
    expect(html).toContain("data-footnotes");
  });
});
