import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remarkBreaks from "remark-breaks";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";
import { describe, expect, it } from "vitest";
import { TRICKY_MARKDOWN } from "./markdown-fixtures";
import { parseMarkdown, renderMarkdown, safeUrl, type MarkdownComponents } from "./markdown-pipeline";

// The processor the pipeline replaces: react-markdown with remark-gfm's parse half and remark-breaks.
function remarkGfm(this: Processor): void {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
}

const CASES: Record<string, string> = {
  ...TRICKY_MARKDOWN,
  "unsafe and odd URLs": "[js](javascript:alert(1)) [data](data:text/html,x) [rel](./a:b) [q](?a=b:c) [hash](#x:y) [mail](mailto:a@b.c)\n\n[vb](vbscript:x \"t\") ![ok](https://e.com/i.png)\n\n<https://auto.link> www.example.com a@b.co\n",
  "raw HTML in blocks and spans": "<details><summary>s</summary>\n\nbody\n\n</details>\n\ntext <kbd>k</kbd> <img src=x onerror=alert(1)> <svg><circle r=\"2\"/></svg>\n",
  "soft breaks and hard breaks": "one\ntwo\\\nthree  \nfour\n\n> a\n> b\n\n- x\n  y\n",
  "tables with alignment": "| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n",
  "footnote reuse": "a[^x] b[^x] c[^y]\n\n[^x]: X\n[^y]: Y *emph*\n",
  "entities and escapes": "&copy; &#x41; \\*not\\* `a\\b` ~single~ ~~double~~\n",
};

const passthrough: MarkdownComponents = {};
const probing: MarkdownComponents = {
  a: ({ node, children, ...props }) => createElement("a", { ...props, "data-tag": node?.tagName }, children),
  code: ({ node: _node, className, children }) => createElement("code", { className, "data-probe": "" }, children),
  input: ({ node: _node, type, checked }) => createElement("span", { "data-input": type, "data-checked": String(checked) }),
  p: ({ node: _node, children }) => createElement("span", { className: "p" }, children),
};

function reference(text: string, components: MarkdownComponents): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkBreaks], components: components as never }, text));
}

describe("markdown pipeline", () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`renders ${name} as react-markdown does`, () => {
      for (const components of [passthrough, probing]) {
        expect(renderToStaticMarkup(renderMarkdown(text, components))).toBe(reference(text, components));
      }
    });

    it(`parses ${name} as remark-parse with GFM does`, () => {
      expect(parseMarkdown(text)).toEqual(unified().use(remarkParse).use(remarkGfm).parse(text));
    });
  }

  it("empties URLs with an unsafe protocol only", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(safeUrl("./a:b")).toBe("./a:b");
    expect(safeUrl("?q=a:b")).toBe("?q=a:b");
    expect(safeUrl("#a:b")).toBe("#a:b");
    expect(safeUrl("plain")).toBe("plain");
  });
});
