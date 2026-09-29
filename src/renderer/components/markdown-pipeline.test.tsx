import { createElement, isValidElement, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { Nodes as HastNodes, Parents as HastParents, Root as HastRoot } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { newlineToBreak } from "mdast-util-newline-to-break";
import { toHast as mdastToHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import remarkBreaks from "remark-breaks";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { TRICKY_MARKDOWN } from "./markdown-fixtures";
import { parseMarkdown, renderMarkdown, safeUrl, toHast, toReact, type MarkdownComponents } from "./markdown-pipeline";

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
  "references resolved and not": "![img][pic] ![alt][] ![pic] [text][nope] [nope][] [nope] ![gone][nope] [*em* link][docs]\n\n[pic]: ./p.png \"Pic\"\n[docs]: <https://e.com/a b> 'T'\n",
  "lists nested, numbered and loose": "3. three\n4. four\n   - inner\n\n     more\n   - [ ] box\n0. zero\n\n- \n- [x]\n- [ ] \n  second line\n\n* a\n\n  b\n* c\n",
  "footnotes odd": "x[^missing] y[^Big Name] z[^big name]\n\n[^big name]: Para one.\n\n    Para two.\n\n    ```js\n    code();\n    ```\n[^unused]: Never cited.\n",
  "breaks then indentation": "a\\\n   b  \n\t c\n*d*\\\n  **e**\\\n[  f](x)\n",
  "tables ragged": "| a | b | c |\n|---|:--|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n\n| solo |\n|------|\n",
  "headings and images": "###### six\n\n## two ##\n\n![a *b*](<./x y.png> \"t\") ![](empty.png)\n\n`multi\nline` <span>inline</span>\n",
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

// Type, key and props all the way down, so keys and `node` count as well as markup.
function shape(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { children, ...props } = node.props;
  return { type: node.type, key: node.key, props, children: shape(children as ReactNode) };
}

// The steps `toHast` replaces: the package's conversion, then raw HTML as text and unsafe URLs emptied.
function hastOf(text: string): HastRoot {
  const mdast = parseMarkdown(text);
  newlineToBreak(mdast);
  const hast = mdastToHast(mdast, { allowDangerousHtml: true }) as HastRoot;
  visit(hast as HastNodes, (node, index, parent: HastParents | undefined) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (node.type !== "element") return undefined;
    for (const [key, tags] of Object.entries(urlAttributes)) {
      if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName))) {
        node.properties[key] = safeUrl(String(node.properties[key] || ""));
      }
    }
    return undefined;
  });
  return hast;
}

// Positions and a fence's `meta` are all the package adds that nothing reads.
const bare = (tree: unknown): unknown => JSON.parse(JSON.stringify(tree, (key, value: unknown) => key === "position" || key === "data" ? undefined : value));

describe("markdown pipeline", () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`renders ${name} as react-markdown does`, () => {
      for (const components of [passthrough, probing]) {
        expect(renderToStaticMarkup(renderMarkdown(text, components))).toBe(reference(text, components));
      }
    });

    it(`converts ${name} to hast as mdast-util-to-hast does`, () => {
      const mdast = parseMarkdown(text);
      newlineToBreak(mdast);
      expect(bare(toHast(mdast))).toEqual(bare(hastOf(text)));
    });

    it(`builds the element tree for ${name} as hast-util-to-jsx-runtime does`, () => {
      const hast = hastOf(text);
      for (const components of [passthrough, probing]) {
        const expected = toJsxRuntime(hast, { Fragment, components: components as never, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true, passNode: true });
        expect(shape(toReact(hast, components))).toEqual(shape(expected));
      }
    });

    it(`parses ${name} as remark-parse with GFM does`, () => {
      expect(parseMarkdown(text)).toEqual(unified().use(remarkParse).use(remarkGfm).parse(text));
    });
  }

  // `toReact` knows HTML's properties only; raw HTML, and with it SVG, stays text.
  it("never draws an SVG element", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, null, [
      '<svg viewBox="0 0 8 8"><path d="M0 0h8"/></svg>',
      "",
      'Inline <svg width="4"><circle r="2"/></svg> too.',
    ].join("\n")));
    expect(markup).not.toMatch(/<svg|<path|<circle/u);
    expect(markup).toContain("&lt;svg");
  });

  it("empties URLs with an unsafe protocol only", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(safeUrl("./a:b")).toBe("./a:b");
    expect(safeUrl("?q=a:b")).toBe("?q=a:b");
    expect(safeUrl("#a:b")).toBe("#a:b");
    expect(safeUrl("plain")).toBe("plain");
  });
});
