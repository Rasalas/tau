import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_CACHE_BYTES,
  Markdown,
  clearHighlightCache,
  highlightCacheBytes,
  highlightCacheSize,
  highlightedCode,
  isInlineMarkdown,
  loadHighlightLanguage,
} from "./Markdown";

describe("streaming markdown cache", () => {
  it("reuses highlights and evicts the oldest entries at a byte bound", async () => {
    await loadHighlightLanguage("typescript");
    clearHighlightCache();
    const first = highlightedCode("const value = 1", "typescript");
    expect(first).toContain("hljs-keyword");
    expect(first).toBe(highlightedCode("const value = 1", "typescript"));
    const block = (index: number) => `const value${index} = ${index};\n`.repeat(2_000);
    for (let index = 0; highlightCacheBytes() < HIGHLIGHT_CACHE_BYTES * 0.9; index += 1) highlightedCode(block(index), "typescript");
    const size = highlightCacheSize();
    for (let index = 10_000; index < 10_040; index += 1) highlightedCode(block(index), "typescript");
    expect(highlightCacheBytes()).toBeLessThanOrEqual(HIGHLIGHT_CACHE_BYTES);
    expect(highlightCacheSize()).toBeLessThanOrEqual(size + 1);
    clearHighlightCache();
    expect(highlightCacheBytes()).toBe(0);
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
