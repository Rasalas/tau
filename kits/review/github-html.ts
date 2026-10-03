import type { Element, ElementContent, Properties, Root as HastRoot, RootContent } from "hast";
import type {} from "mdast-util-to-hast";
import type { MarkdownHtml } from "tau";

/*
 * Raw HTML in Markdown, the subset GitHub renders. The Markdown tree and its
 * raw fragments go through the browser's parser together, so a `<details>`
 * can wrap Markdown; each element the parser builds then passes an allowlist.
 */

const TAGS = new Set(("a img video source details summary p div span em strong b i s del ins blockquote ul ol li code pre h1 h2 h3 h4 h5 h6 "
  + "br hr sub sup kbd dl dt dd table thead tbody tfoot tr th td caption").split(" "));
/** Dropped with their text; any other tag outside `TAGS` keeps its content. */
const DROPPED = /^(script|style|textarea|title|iframe|noscript|noembed|noframes|xmp)$/u;
const NUMBER = /^\d{1,4}$/u;
const ATTRIBUTES: Record<string, RegExp | undefined> = {
  title: undefined, alt: undefined, width: NUMBER, height: NUMBER, start: NUMBER, colspan: NUMBER, rowspan: NUMBER,
  align: /^(left|center|right)$/u,
};
// Links open http(s) outside the app; images load only over https.
const MEDIA_URL = /^(?:https:\/\/|\/?uploads\/[a-f\d]{32}\/[^/\\\s]+$)/iu;
const URLS: Record<string, [string, RegExp]> = { a: ["href", /^https?:\/\//iu], img: ["src", MEDIA_URL], video: ["src", MEDIA_URL], source: ["src", MEDIA_URL] };

const escapeText = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function hasRawHtml(root: HastRoot): boolean {
  const visit = (node: RootContent | HastRoot): boolean =>
    node.type === "raw" || ("children" in node && (node.children as RootContent[]).some(visit));
  return visit(root);
}

/** `Markdown`'s `html` for a request's description and comments: GitHub's HTML, through an allowlist. */
export const githubHtml: MarkdownHtml = (root) => hasRawHtml(root) ? resolveRawHtml(root) : root;

function resolveRawHtml(root: HastRoot): HastRoot {
  // A random tag name marks the Markdown's own elements, so raw HTML cannot name one.
  const marker = `tau-md-${Math.random().toString(36).slice(2, 10)}`;
  const own: Element[] = [];
  const serialize = (nodes: readonly RootContent[]): string => nodes.map((node) => {
    if (node.type === "raw") return node.value;
    if (node.type === "text") return escapeText(node.value);
    if (node.type !== "element") return "";
    own.push(node);
    return `<${marker} data-i="${own.length - 1}">${serialize(node.children)}</${marker}>`;
  }).join("");

  // DOMParser's document is inert: it runs no script and loads no image.
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${serialize(root.children)}`, "text/html");
  const convert = (parent: ParentNode): ElementContent[] => {
    const result: ElementContent[] = [];
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) result.push({ type: "text", value: child.textContent ?? "" });
      if (child.nodeType !== 1) continue;
      const element = child as globalThis.Element;
      const tag = element.localName;
      if (tag === marker) {
        const original = own[Number(element.getAttribute("data-i"))];
        if (original) result.push({ ...original, children: convert(element) });
        else result.push(...convert(element));
        continue;
      }
      if (DROPPED.test(tag) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      const url = URLS[tag];
      const target = url && element.getAttribute(url[0])?.trim();
      if (!TAGS.has(tag) || (url && !(tag === "video" && !target) && !url[1].test(target ?? ""))) {
        if (tag !== "img") result.push(...convert(element));
        continue;
      }
      const properties: Properties = url && target ? { [url[0]]: target } : {};
      for (const [name, pattern] of Object.entries(ATTRIBUTES)) {
        const value = element.getAttribute(name);
        if (value !== null && (!pattern || pattern.test(value))) properties[name.replace("span", "Span")] = value;
      }
      // Code blocks render from their text, as a fenced block does.
      const children: ElementContent[] = tag === "pre"
        ? [{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: element.textContent ?? "" }] }]
        : convert(element);
      result.push({ type: "element", tagName: tag, properties, children });
    }
    return result;
  };
  return { type: "root", children: convert(parsed.body) };
}
