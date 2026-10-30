import { describe, expect, it } from "vitest";
import { maskMarkdownFrontmatter } from "./markdown-frontmatter.js";

describe("Markdown file metadata", () => {
  it.each(["\n", "\r\n", "\r"])("preserves offsets with %j line endings", (newline) => {
    const text = ["\uFEFF---", "title: Notes 📚", "tags: [work]", "---", "# Notes", "- [ ] Read"].join(newline);
    const masked = maskMarkdownFrontmatter(text);
    expect(masked).not.toContain("title:");
    expect(masked.length).toBe(text.length);
    expect(masked.indexOf("# Notes")).toBe(text.indexOf("# Notes"));
    expect(masked.split(newline).length).toBe(text.split(newline).length);
  });

  it("accepts empty metadata, whitespace and YAML's end marker", () => {
    expect(maskMarkdownFrontmatter("---\n---\n# Body").trim()).toBe("# Body");
    expect(maskMarkdownFrontmatter("--- \t\nname: skill\n... \t\n# Body").trim()).toBe("# Body");
    expect(maskMarkdownFrontmatter("---\nname: skill\n---").trim()).toBe("");
  });

  it.each(["---\nname: skill", "# Body\n---\nname: skill\n---", "---\nname: skill\n----", "---\nname: skill\n--- extra"])("keeps incomplete or non-leading blocks: %j", (text) => {
    expect(maskMarkdownFrontmatter(text)).toBe(text);
  });
});
