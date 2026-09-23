import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { StreamingMarkdownBlocks, type MarkdownBlock } from "./markdown-blocks";
import { parseMarkdown } from "./markdown-pipeline";
import { TRICKY_MARKDOWN } from "./markdown-fixtures";

const parse = parseMarkdown;

function withoutPositions(node: Root | RootContent): unknown {
  return JSON.parse(JSON.stringify(node, (key, value: unknown) => key === "position" ? undefined : value));
}

/** Feeds `text` in deltas of `step` characters, then ends the stream. */
function stream(text: string, step: number, blocks = new StreamingMarkdownBlocks(parse)) {
  const frames: Array<readonly MarkdownBlock[] | undefined> = [];
  for (let end = step; end < text.length; end += step) frames.push(blocks.update(text.slice(0, end), false));
  return { frames, final: blocks.update(text, true), blocks };
}

describe("streaming Markdown blocks", () => {
  for (const [name, text] of Object.entries(TRICKY_MARKDOWN)) {
    it(`ends with the one-document blocks for ${name}`, () => {
      for (const step of [1, 3, 17]) {
        const { final } = stream(text, step);
        const document = parse(text);
        const definitions = /^\[[^\]]+\]:/mu.test(text);
        if (definitions) {
          expect(final).toBeUndefined();
          continue;
        }
        expect(final?.map((block) => withoutPositions(parse(block.source).children[0]!)))
          .toEqual(document.children.map(withoutPositions));
        expect(final?.every((block) => parse(block.source).children.length === 1)).toBe(true);
      }
    });

    it(`never changes a settled block of ${name}`, () => {
      const settled = new Map<number, string>();
      const { frames, final } = stream(text, 1);
      for (const blocks of [...frames, final]) {
        for (const block of blocks ?? []) {
          const earlier = settled.get(block.start);
          if (earlier !== undefined) expect(block.source).toBe(earlier);
          if (block.settled) settled.set(block.start, block.source);
        }
      }
    });
  }

  it("keeps a fence with blank lines in one block while it streams", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\n\nconst c = 3;\n```\n\nAfter.\n";
    const { frames } = stream(text, 1);
    for (const blocks of frames) {
      const fences = (blocks ?? []).filter((block) => block.code);
      expect(fences.length).toBeLessThanOrEqual(1);
      const fence = fences[0];
      if (fence) expect(text.slice(fence.start).startsWith(fence.source)).toBe(true);
    }
    const middle = frames[text.indexOf("const b") + 1]!; // the prefix ending in "co"
    expect(middle.map((block) => block.code?.value ?? block.source)).toEqual(["Intro.", "const a = 1;\n\nco"]);
  });

  it("reads an open fence like the parser does, without the parser", () => {
    const text = "```typescript\nconst a = 1;\n\n  indented();\n~~~\n``\n````js\nend();\n```";
    const blocks = new StreamingMarkdownBlocks(parse);
    for (let end = 16; end <= text.length; end += 1) {
      const prefix = text.slice(0, end);
      const block = blocks.update(prefix, false)!.at(-1)!;
      const node = parse(prefix).children.at(-1)!;
      expect(node.type).toBe("code");
      const partial = prefix.slice(prefix.lastIndexOf("\n") + 1);
      // A half-typed closing fence is hidden rather than flashed as code.
      const expected = /^`{1,2}$/u.test(partial) ? (node as { value: string }).value.slice(0, -partial.length - 1) : (node as { value: string }).value;
      expect(block.code?.value).toBe(expected);
      expect(block.code?.language).toBe("typescript");
    }
    expect(blocks.update(text, false)!.at(-1)!.code?.closed).toBe(true);
  });

  it("parses each settled block once while a long answer streams", () => {
    const section = (index: number) => `## Step ${index}\n\nSome prose for step ${index}.\n\n\`\`\`ts\nconst step${index} = ${index};\n\nexport { step${index} };\n\`\`\`\n\n| a | b |\n| - | - |\n| ${index} | x |\n\n`;
    const text = Array.from({ length: 60 }, (_, index) => section(index)).join("");
    const { blocks, final } = stream(text, 40);
    expect(final).toHaveLength(parse(text).children.length);
    // A whole-document parse per delta would be about text.length² / 80 characters.
    expect(blocks.parsedCharacters).toBeLessThan(text.length * 4);
  });

  it("parses only the open blocks when the stream ends", () => {
    const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} of a long answer.\n\n`).join("") + "Last paragraph";
    const blocks = new StreamingMarkdownBlocks(parse);
    blocks.update(text.slice(0, -4), false);
    const before = blocks.parsedCharacters;
    expect(blocks.update(text, true)).toHaveLength(201);
    expect(blocks.parsedCharacters - before).toBeLessThan(64);
  });

  it("parses an open fence once, however long it grows", () => {
    const text = "```ts\n" + "const value = 1;\n".repeat(5_000);
    const { blocks } = stream(text, 64);
    expect(blocks.parsedCharacters).toBeLessThan(200 + text.length);
  });

  it("renders as one document once a definition appears", () => {
    const blocks = new StreamingMarkdownBlocks(parse);
    expect(blocks.update("See [docs].\n\nMore text.\n\n", false)).toHaveLength(2);
    expect(blocks.update("See [docs].\n\nMore text.\n\n[docs]: https://example.com\n", false)).toBeUndefined();
    expect(blocks.update("See [docs].\n\nMore text.\n\n[docs]: https://example.com\n\nEnd.", true)).toBeUndefined();
  });

  it("starts over when the text is replaced instead of extended", () => {
    const blocks = new StreamingMarkdownBlocks(parse);
    blocks.update("First paragraph.\n\nSecond paragraph.\n", false);
    const replaced = blocks.update("Other text.\n\nMore.\n", true);
    expect(replaced?.map((block) => block.source)).toEqual(["Other text.", "More."]);
  });

  it("does not settle a block whose follower might still join it", () => {
    const blocks = new StreamingMarkdownBlocks(parse);
    // "2" could still become "2. item", which continues the list.
    const partial = blocks.update("1. one\n\n2", false)!;
    expect(partial.every((block) => !block.settled)).toBe(true);
    const joined = blocks.update("1. one\n\n2. two\n", false)!;
    expect(joined).toHaveLength(1);
  });
});
