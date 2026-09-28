import type { ComponentType, JSX, ReactElement, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Element, ElementContent, Nodes as HastNodes, Parents as HastParents, Root as HastRoot } from "hast";
import type { Root } from "mdast";
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
 * steps cost the initial script about 13 KB. Parse only, as before. `toReact`
 * replaces `hast-util-to-jsx-runtime` for the closed set of trees `toHast` builds.
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

const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
const UPPER = /[A-Z]/gu;

/** React's name for a hast property: `ariaLabel` is `aria-label`, `dataFootnoteRef` is `data-footnote-ref`. */
function propName(name: string): string {
  if (/^aria[A-Z]/u.test(name)) return `aria-${name.slice(4).toLowerCase()}`;
  return /^data[A-Z]/u.test(name) ? `data${name.slice(4).replace(UPPER, (letter) => `-${letter.toLowerCase()}`)}` : name;
}

function elementProps(node: Element): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  let align: string | undefined;
  for (const [name, value] of Object.entries(node.properties)) {
    if (name === "children" || value == null || Number.isNaN(value)) continue;
    const prop = propName(name);
    const text = Array.isArray(value) ? value.join(" ").trim() : value;
    if (prop === "align" && typeof text === "string" && (node.tagName === "td" || node.tagName === "th")) align = text;
    else props[prop] = text;
  }
  if (align) props.style = { textAlign: align };
  return props;
}

function reactChildren(node: HastParents, components: MarkdownComponents): ReactNode[] {
  const counts = new Map<string, number>();
  const children: ReactNode[] = [];
  for (const child of node.children as ElementContent[]) {
    if (child.type === "text") children.push(child.value);
    if (child.type !== "element") continue;
    const count = counts.get(child.tagName) ?? 0;
    counts.set(child.tagName, count + 1);
    children.push(reactElement(child, components, `${child.tagName}-${count}`));
  }
  return children;
}

function create(type: unknown, props: Record<string, unknown>, children: ReactNode[], key?: string): ReactElement {
  if (children.length > 1) props.children = children;
  else if (children[0]) props.children = children[0];
  return (children.length > 1 ? jsxs : jsx)(type as never, props, key);
}

function reactElement(node: Element, components: MarkdownComponents, key: string): ReactElement {
  const component = Object.hasOwn(components, node.tagName) ? components[node.tagName as keyof MarkdownComponents] : undefined;
  const props = elementProps(node);
  let children = reactChildren(node, components);
  if (TABLE_PARTS.has(node.tagName)) children = children.filter((child) => typeof child !== "string" || /[^ \t\n\f\r]/u.test(child));
  if (component && typeof component !== "string") props.node = node;
  return create(component ?? node.tagName, props, children, key);
}

/** What `toJsxRuntime` with `passKeys` and `passNode` renders for trees without raw HTML, MDX or SVG. */
export function toReact(tree: HastRoot, components: MarkdownComponents): ReactElement {
  return create(Fragment, {}, reactChildren(tree, components));
}

export function renderMarkdown(source: string, components: MarkdownComponents): ReactElement {
  const mdast = parseMarkdown(source);
  newlineToBreak(mdast);
  const hast = toHast(mdast, { allowDangerousHtml: true }) as HastRoot;
  sanitize(hast);
  return toReact(hast, components);
}
