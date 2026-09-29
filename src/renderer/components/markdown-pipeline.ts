import type { ComponentType, JSX, ReactElement, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Element, ElementContent, Parents as HastParents, Properties, Root as HastRoot } from "hast";
import type { Definition, FootnoteDefinition, ListItem, Nodes, Parents, Root, Table, TableRow } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { newlineToBreak } from "mdast-util-newline-to-break";
import { gfm } from "micromark-extension-gfm";
import { normalizeUri } from "micromark-util-sanitize-uri";

/*
 * What `react-markdown` with `remark-gfm` and `remark-breaks` does, called
 * directly: the unified processor, VFile and plugin plumbing around these
 * steps cost the initial script about 13 KB. Parse only, as before. `toHast`
 * and `toReact` replace `mdast-util-to-hast` and `hast-util-to-jsx-runtime`
 * for the closed set of trees GFM parsing builds, raw HTML as text.
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

type Hast = ElementContent | HastRoot;
type Converted = Hast | Hast[] | undefined;

const text = (value: string): ElementContent => ({ type: "text", value });
const element = (tagName: string, properties: Properties = {}, children: ElementContent[] = []): Element => ({ type: "element", tagName, properties, children });

/** Newlines between block children, and around them in a loose container, as `mdast-util-to-hast` puts them. */
function wrap(nodes: ElementContent[], loose = false): ElementContent[] {
  const result = loose ? [text("\n")] : [];
  nodes.forEach((node, index) => { if (index) result.push(text("\n")); result.push(node); });
  if (loose && nodes.length > 0) result.push(text("\n"));
  return result;
}

const itemLoose = (item: ListItem) => item.spread ?? item.children.length > 1;
const url = (value: string) => safeUrl(normalizeUri(value));

/**
 * mdast to hast as `mdast-util-to-hast` with `allowDangerousHtml` builds it,
 * then raw HTML as text and unsafe URLs emptied. Text holds no line ending
 * here: `newlineToBreak` has turned each into a break.
 */
export function toHast(tree: Root): HastRoot {
  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  const order: string[] = [];
  const counts = new Map<string, number>();
  const collect = (node: Nodes) => {
    if (node.type === "definition" || node.type === "footnoteDefinition") {
      const map: Map<string, Nodes> = node.type === "definition" ? definitions : footnotes;
      const id = node.identifier.toUpperCase();
      if (!map.has(id)) map.set(id, node);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(tree);
  const footnoteId = (identifier: string) => normalizeUri(identifier.toLowerCase());

  const all = (parent: Parents): ElementContent[] => {
    const values: ElementContent[] = [];
    parent.children.forEach((child, index) => {
      const result = one(child, parent) as ElementContent | ElementContent[] | undefined;
      if (!result) return;
      if (index && parent.children[index - 1]!.type === "break" && !Array.isArray(result)) {
        const head = result.type === "element" ? result.children[0] : result;
        if (head?.type === "text") head.value = head.value.replace(/^[\t ]+/u, "");
      }
      if (Array.isArray(result)) values.push(...result);
      else values.push(result);
    });
    return values;
  };

  // An unresolved reference is its source text again.
  const revert = (node: Extract<Nodes, { type: "linkReference" | "imageReference" }>): ElementContent[] => {
    const suffix = `]${node.referenceType === "collapsed" ? "[]" : node.referenceType === "full" ? `[${node.label || node.identifier}]` : ""}`;
    if (node.type === "imageReference") return [text(`![${node.alt}${suffix}`)];
    const contents = all(node);
    const head = contents[0];
    if (head?.type === "text") head.value = `[${head.value}`;
    else contents.unshift(text("["));
    const tail = contents[contents.length - 1];
    if (tail?.type === "text") tail.value += suffix;
    else contents.push(text(suffix));
    return contents;
  };

  const listItem = (node: ListItem, parent: Parents | undefined): Element => {
    const results = all(node);
    const loose = parent ? parent.type === "list" && (Boolean(parent.spread) || parent.children.some(itemLoose)) : itemLoose(node);
    const properties: Properties = {};
    if (typeof node.checked === "boolean") {
      let paragraph = results[0];
      if (paragraph?.type !== "element" || paragraph.tagName !== "p") {
        paragraph = element("p");
        results.unshift(paragraph);
      }
      if (paragraph.children.length > 0) paragraph.children.unshift(text(" "));
      paragraph.children.unshift(element("input", { type: "checkbox", checked: node.checked, disabled: true }));
      properties.className = ["task-list-item"];
    }
    const children: ElementContent[] = [];
    const isParagraph = (child: ElementContent | undefined) => child?.type === "element" && child.tagName === "p";
    results.forEach((child, index) => {
      if (loose || index !== 0 || !isParagraph(child)) children.push(text("\n"));
      if (isParagraph(child) && !loose) children.push(...(child as Element).children);
      else children.push(child);
    });
    const tail = results[results.length - 1];
    if (tail && (loose || !isParagraph(tail))) children.push(text("\n"));
    return element("li", properties, children);
  };

  const tableRow = (node: TableRow, table: Table): Element => {
    const tagName = table.children.indexOf(node) === 0 ? "th" : "td";
    const cells: ElementContent[] = [];
    const length = table.align ? table.align.length : node.children.length;
    for (let index = 0; index < length; index += 1) {
      const align = table.align?.[index];
      const cell = node.children[index];
      cells.push(element(tagName, align ? { align } : {}, cell ? all(cell) : []));
    }
    return element("tr", {}, wrap(cells, true));
  };

  function one(node: Nodes, parent?: Parents): Converted {
    switch (node.type) {
      case "root": return { type: "root", children: wrap(all(node)) };
      case "blockquote": return element("blockquote", {}, wrap(all(node), true));
      case "break": return [element("br"), text("\n")];
      case "code": {
        const language = node.lang ? node.lang.split(/\s+/u) : [];
        return element("pre", {}, [element("code", language.length > 0 ? { className: [`language-${language[0]}`] } : {}, [text(node.value ? `${node.value}\n` : "")])]);
      }
      case "delete": return element("del", {}, all(node));
      case "emphasis": return element("em", {}, all(node));
      case "strong": return element("strong", {}, all(node));
      case "heading": return element(`h${node.depth}`, {}, all(node));
      case "paragraph": return element("p", {}, all(node));
      case "thematicBreak": return element("hr");
      case "html": return text(node.value);
      case "text": return text(node.value);
      case "inlineCode": return element("code", {}, [text(node.value.replace(/\r?\n|\r/gu, " "))]);
      case "footnoteReference": {
        const id = node.identifier.toUpperCase();
        const safe = footnoteId(id);
        const seen = counts.get(id) ?? 0;
        if (!seen) order.push(id);
        counts.set(id, seen + 1);
        return element("sup", {}, [element("a", {
          href: url(`#user-content-fn-${safe}`),
          id: `user-content-fnref-${safe}${seen ? `-${seen + 1}` : ""}`,
          dataFootnoteRef: true,
          ariaDescribedBy: ["footnote-label"],
        }, [text(String(order.indexOf(id) + 1))])]);
      }
      case "link":
      case "linkReference": {
        const target = node.type === "link" ? node : definitions.get(node.identifier.toUpperCase());
        if (!target) return revert(node as Extract<Nodes, { type: "linkReference" }>);
        return element("a", { href: url(target.url || ""), ...(target.title != null ? { title: target.title } : {}) }, all(node));
      }
      case "image":
      case "imageReference": {
        const target = node.type === "image" ? node : definitions.get(node.identifier.toUpperCase());
        if (!target) return revert(node as Extract<Nodes, { type: "imageReference" }>);
        return element("img", {
          src: url(target.url || ""),
          ...(node.alt != null ? { alt: node.alt } : {}),
          ...(target.title != null ? { title: target.title } : {}),
        });
      }
      case "list": {
        const results = all(node);
        const properties: Properties = {};
        if (typeof node.start === "number" && node.start !== 1) properties.start = node.start;
        if (results.some((child) => child.type === "element" && (child.properties.className as string[] | undefined)?.includes("task-list-item"))) {
          properties.className = ["contains-task-list"];
        }
        return element(node.ordered ? "ol" : "ul", properties, wrap(results, true));
      }
      case "listItem": return listItem(node, parent);
      case "table": {
        const rows = node.children.map((row) => tableRow(row, node));
        const first = rows.shift();
        const content: ElementContent[] = [];
        if (first) content.push(element("thead", {}, wrap([first], true)));
        if (rows.length > 0) content.push(element("tbody", {}, wrap(rows, true)));
        return element("table", {}, wrap(content, true));
      }
      case "definition":
      case "footnoteDefinition":
        return undefined;
      default:
        return "value" in node ? text(String(node.value)) : element("div", {}, all(node as Parents));
    }
  }

  const root = one(tree) as HastRoot;
  const items: ElementContent[] = [];
  order.forEach((id, index) => {
    const definition = footnotes.get(id);
    if (!definition) return;
    const content = all(definition);
    const safe = footnoteId(id);
    const backReferences: ElementContent[] = [];
    for (let again = 1; again <= counts.get(id)!; again += 1) {
      if (backReferences.length > 0) backReferences.push(text(" "));
      backReferences.push(element("a", {
        href: url(`#user-content-fnref-${safe}${again > 1 ? `-${again}` : ""}`),
        dataFootnoteBackref: "",
        ariaLabel: `Back to reference ${index + 1}${again > 1 ? `-${again}` : ""}`,
        className: ["data-footnote-backref"],
      }, again > 1 ? [text("↩"), element("sup", {}, [text(String(again))])] : [text("↩")]));
    }
    const tail = content[content.length - 1];
    if (tail?.type === "element" && tail.tagName === "p") {
      const last = tail.children[tail.children.length - 1];
      if (last?.type === "text") last.value += " ";
      else tail.children.push(text(" "));
      tail.children.push(...backReferences);
    } else {
      content.push(...backReferences);
    }
    items.push(element("li", { id: `user-content-fn-${safe}` }, wrap(content, true)));
  });
  if (items.length > 0) {
    root.children.push(text("\n"), element("section", { dataFootnotes: true, className: ["footnotes"] }, [
      element("h2", { className: ["sr-only"], id: "footnote-label" }, [text("Footnotes")]),
      text("\n"),
      element("ol", {}, wrap(items, true)),
      text("\n"),
    ]));
  }
  return root;
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
    const joined = Array.isArray(value) ? value.join(" ").trim() : value;
    if (prop === "align" && typeof joined === "string" && (node.tagName === "td" || node.tagName === "th")) align = joined;
    else props[prop] = joined;
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
  return toReact(toHast(mdast), components);
}
