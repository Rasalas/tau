import type { ComponentType, JSX, ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Element, Nodes as HastNodes, Parents as HastParents } from "hast";
import type { Root } from "mdast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { newlineToBreak } from "mdast-util-newline-to-break";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

/*
 * What `react-markdown` with `remark-gfm` and `remark-breaks` does, called
 * directly: the unified processor, VFile and plugin plumbing around these
 * steps cost the initial script about 13 KB. Parse only, as before.
 */

export type MarkdownComponents = {
  [Tag in keyof JSX.IntrinsicElements]?: ComponentType<JSX.IntrinsicElements[Tag] & { node?: Element }>;
};

/** GFM Markdown to mdast, without the line-break transform: the block splitter's grammar. */
export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/iu;

/** Keeps relative URLs and safe protocols; anything else (`javascript:`) becomes empty. */
export function safeUrl(value: string): string {
  const colon = value.indexOf(":");
  if (colon === -1) return value;
  for (const mark of ["/", "?", "#"]) {
    const at = value.indexOf(mark);
    if (at !== -1 && colon > at) return value;
  }
  return SAFE_PROTOCOL.test(value.slice(0, colon)) ? value : "";
}

function sanitize(tree: HastNodes): void {
  visit(tree, (node, index, parent: HastParents | undefined) => {
    // Raw HTML stays inert text.
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
}

export function renderMarkdown(source: string, components: MarkdownComponents): ReactElement {
  const mdast = parseMarkdown(source);
  newlineToBreak(mdast);
  const hast = toHast(mdast, { allowDangerousHtml: true });
  sanitize(hast);
  return toJsxRuntime(hast, {
    Fragment,
    components: components as never,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  }) as ReactElement;
}
