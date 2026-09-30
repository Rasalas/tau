#!/usr/bin/env node
// The website's docs, rendered from the repository's Markdown into site/docs/
// with the landing page's header and footer: node scripts/site/build-docs.mjs.
// The Markdown stays the one source; the HTML is a build output (gitignored,
// built again by .github/workflows/pages.yml before every deploy).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const REPO_URL = "https://github.com/Rasalas/tau";

/** The pages, in the order the docs navigation lists them. `source` is relative to the repository. */
export const PAGES = [
  { slug: "get-started", source: "docs/site/get-started.md", group: "Guides", blurb: "Install Tau, connect your agents, start a thread, pair your phone." },
  { slug: "install", source: "docs/install.md", group: "Guides", blurb: "Every installer, Linux details, updates, the tau command, and running from a checkout." },
  { slug: "make-a-change", source: "docs/site/make-a-change.md", group: "Guides", blurb: "Write a kit of your own, or change Tau and open a pull request." },
  { slug: "updates-and-machines", source: "docs/site/updates-and-machines.md", group: "Guides", blurb: "How Tau updates itself, other computers, and a host without a window." },
  { slug: "servers", source: "docs/servers.md", group: "Guides", title: "Servers", blurb: "Work on a site that lives on a server: upload, drift, roll back." },
  { slug: "runtimes", source: "docs/runtimes.md", group: "Reference", blurb: "Claude Code, Codex, Antigravity and Pi, pull request tools, and a live Pi session." },
  { slug: "hosts", source: "docs/hosts.md", group: "Reference", title: "Hosts and devices", blurb: "The host as a service, over a socket or TLS, other machines, the web client and the phone app." },
  { slug: "push", source: "docs/push.md", group: "Reference", title: "Push notifications", blurb: "Tau's relay, what it sees, the end-to-end encryption, and your own keys." },
  { slug: "extensions", source: "docs/EXTENSIONS.md", group: "Reference", title: "Writing a package", blurb: "The manifest, the API a kit uses, permissions, isolation and signing." },
  { slug: "architecture", source: "docs/architecture.md", group: "Reference", blurb: "Core and kits, the window and the host, the extension seam." },
  { slug: "core", source: "docs/CORE.md", group: "Reference", title: "Core and kits", blurb: "What the core owns, and what each shipped kit does." },
  { slug: "host-updates", source: "docs/host-updates.md", group: "Reference", title: "Host updates", blurb: "The update design, the Linux helper and the threat model." },
  { slug: "contributing", source: "CONTRIBUTING.md", group: "Reference", title: "Contributing", blurb: "Setting up, where a change goes, and what a pull request needs." },
  { slug: "features", source: "docs/features.md", group: "Project", blurb: "The workbench's features, in one list." },
  { slug: "roadmap", source: "docs/roadmap.md", group: "Project", title: "Roadmap", blurb: "What is not done yet, and what Tau does not try to be." },
  { slug: "privacy", source: "docs/site/privacy.md", group: "Project", title: "Privacy policy", blurb: "How the Android app handles connections, notifications and your data." },
  { slug: "privacy-de", source: "docs/site/privacy-de.md", group: "Project", title: "Datenschutzerklärung", lang: "de", blurb: "Datenschutz für die Android-App, auf Deutsch." },
];

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text) => escapeText(text).replace(/"/g, "&quot;");
const LANGUAGES = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".json": "json", ".css": "css", ".md": "markdown", ".sh": "bash" };

/** A heading's anchor, the way GitHub makes it, so links written for GitHub keep working. */
export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** Where a link in `source` points on the site: a rendered page, the site itself, or the file on GitHub. */
export function rewriteHref(href, source, pages = PAGES) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [path, hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(source), path));
  const anchor = hash === undefined ? "" : `#${hash}`;
  const page = pages.find((entry) => entry.source === target);
  if (page) return `${page.slug}.html${anchor}`;
  if (target === "site/index.html" || target === "site") return `../${anchor}`;
  if (target.startsWith("site/")) return `../${target.slice(5)}${anchor}`;
  if (target.startsWith("../")) return href;
  const kind = path.endsWith("/") || !extname(target) ? "tree" : "blob";
  return `${REPO_URL}/${kind}/main/${target.replace(/\/$/, "")}${anchor}`;
}

/** `<!-- include: path -->` on a line of its own becomes that file as a code block, at the same indent. */
export function expandIncludes(markdown, readFile) {
  return markdown.replace(/^( *)<!-- include: (\S+) -->$/gm, (_line, indent, path) => {
    const body = readFile(path).replace(/\n$/, "");
    const fence = ["```" + (LANGUAGES[extname(path)] ?? ""), ...body.split("\n"), "```"];
    return fence.map((line) => (line ? indent + line : line)).join("\n");
  });
}

/** A hast property's attribute name: `className` is `class`, `ariaDescribedBy` is `aria-describedby`, `dataFootnoteRef` is `data-footnote-ref`. */
function attributeName(key) {
  if (key === "className") return "class";
  if (key === "htmlFor") return "for";
  if (/^aria[A-Z]/.test(key)) return `aria-${key.slice(4).toLowerCase()}`;
  if (/^data[A-Z]/.test(key)) return `data${key.slice(4).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  return key.toLowerCase();
}

/** hast to HTML. Raw HTML in the Markdown is shown as text, never passed through. */
function toHtml(node) {
  if (node.type === "root") return node.children.map(toHtml).join("");
  if (node.type === "text" || node.type === "raw") return escapeText(node.value);
  if (node.type === "comment" || node.type === "doctype") return "";
  if (node.type !== "element") return "";
  const attributes = Object.entries(node.properties ?? {}).map(([key, value]) => {
    const name = attributeName(key);
    if (value === false || value === undefined || value === null) return "";
    if (value === true) return ` ${name}`;
    return ` ${name}="${escapeAttr(Array.isArray(value) ? value.join(" ") : String(value))}"`;
  }).join("");
  if (VOID.has(node.tagName)) return `<${node.tagName}${attributes}>`;
  return `<${node.tagName}${attributes}>${node.children.map(toHtml).join("")}</${node.tagName}>`;
}

const textOf = (node) => node.type === "text" ? node.value : (node.children ?? []).map(textOf).join("");

/** One Markdown file as the docs article's HTML, its title and the first paragraph for the description. */
export function renderMarkdown(markdown, { source, pages = PAGES, readFile = (path) => readFileSync(join(ROOT, path), "utf8") }) {
  const tree = toHast(fromMarkdown(expandIncludes(markdown, readFile), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), { allowDangerousHtml: true });
  const used = new Map();
  let title;
  let description;
  const headings = [];
  const visit = (node, parent) => {
    if (node.type !== "element") return;
    if (/^h[1-6]$/.test(node.tagName)) {
      const text = textOf(node).trim();
      if (node.tagName === "h1") title ??= text;
      let id = slugify(text);
      const seen = used.get(id) ?? 0;
      used.set(id, seen + 1);
      if (seen) id = `${id}-${seen}`;
      node.properties = { ...node.properties, id };
      if (node.tagName !== "h1") {
        node.children.push({ type: "element", tagName: "a", properties: { className: ["anchor"], href: `#${id}`, ariaLabel: `Link to ${text}` }, children: [{ type: "text", value: "#" }] });
        if (node.tagName === "h2") headings.push({ id, text });
      }
    }
    if (node.tagName === "p" && !description && parent?.type === "root") description = textOf(node).trim();
    if (node.tagName === "a" && typeof node.properties?.href === "string") node.properties.href = rewriteHref(node.properties.href, source, pages);
    if (node.tagName === "img" && typeof node.properties?.src === "string" && !/^[a-z]+:/i.test(node.properties.src)) {
      node.properties.src = `https://raw.githubusercontent.com/Rasalas/tau/main/${posix.normalize(posix.join(posix.dirname(source), node.properties.src))}`;
    }
    // Blocks that may scroll sideways take the focus, so a keyboard can scroll them.
    if (node.tagName === "table") node.properties = { ...node.properties, tabIndex: 0 };
    if (node.tagName === "pre") {
      // Wrapped so the copy button can sit over a block that scrolls.
      const pre = { ...node, properties: { ...node.properties, tabIndex: 0 } };
      node.tagName = "div";
      node.properties = { className: ["code"] };
      node.children = [pre];
      return;
    }
    for (const child of node.children ?? []) visit(child, node);
  };
  for (const child of tree.children) visit(child, tree);
  return { html: toHtml(tree), title: title ?? source, description: description ?? "", headings };
}

/** The landing page's marked block (`<!-- site-header -->`…`<!-- /site-header -->`), with its links made to work one folder down. */
export function sharedBlock(indexHtml, name, { current } = {}) {
  const match = indexHtml.match(new RegExp(`<!-- ${name}[^>]*-->\\n([\\s\\S]*?)<!-- /${name} -->`));
  if (!match) throw new Error(`site/index.html has no <!-- ${name} --> block`);
  return match[1].replace(/href="([^"]+)"/g, (_all, href) => {
    const next = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : href === "./" ? "../" : href.startsWith("./") ? `../${href.slice(2)}` : `../${href}`;
    const here = current && next === current ? ' aria-current="page"' : "";
    return `href="${next}"${here}`;
  });
}

function navigation(pages, currentSlug) {
  const groups = [...new Set(pages.map((page) => page.group))];
  return groups.map((group) => `<p class="nav-group">${escapeText(group)}</p><ul>${pages.filter((page) => page.group === group).map((page) => `<li><a href="${page.slug}.html"${page.slug === currentSlug ? ' aria-current="page"' : ""}>${escapeText(page.navTitle)}</a></li>`).join("")}</ul>`).join("");
}

function pageHtml({ title, description, body, nav, header, footer, lang = "en" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)} · Tau docs</title>
<meta name="description" content="${escapeAttr(description.slice(0, 200))}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="preload" href="../assets/fonts/figtree-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="../style.css">
<script src="../site.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header}<div class="docs wrap">
<nav class="docs-nav" aria-label="Docs">${nav}</nav>
<main id="main" class="doc" lang="${escapeAttr(lang)}">
${body}
</main>
</div>
${footer}</body>
</html>
`;
}

/** Renders every page and the docs index into `out`; answers the files it wrote. */
export function buildDocs({ root = ROOT, out = join(ROOT, "site", "docs"), pages = PAGES } = {}) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const index = read("site/index.html");
  const header = sharedBlock(index, "site-header", { current: "../docs/" });
  const footer = sharedBlock(index, "site-footer");
  const rendered = pages.map((page) => {
    const result = renderMarkdown(read(page.source), { source: page.source, pages, readFile: read });
    return { ...page, ...result, navTitle: page.title ?? result.title };
  });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const page of rendered) {
    const contents = page.headings.length >= 6
      ? `<details class="contents"><summary>On this page</summary><ul>${page.headings.map((heading) => `<li><a href="#${heading.id}">${escapeText(heading.text)}</a></li>`).join("")}</ul></details>`
      : "";
    const body = page.html.replace(/(<\/h1>)/, `$1${contents}`) + `<p class="source">This page is <a href="${REPO_URL}/blob/main/${page.source}">${escapeText(page.source)}</a> in Tau's repository.</p>`;
    const file = join(out, `${page.slug}.html`);
    writeFileSync(file, pageHtml({ title: page.navTitle, description: page.description, body, nav: navigation(rendered, page.slug), header, footer, lang: page.lang }));
    written.push(file);
  }
  const cards = (group) => `<ul class="doc-cards">${rendered.filter((page) => page.group === group).map((page) => `<li><a href="${page.slug}.html"><strong>${escapeText(page.navTitle)}</strong>${escapeText(page.blurb)}</a></li>`).join("")}</ul>`;
  const home = `<h1 id="docs">Docs</h1><p>Start with the guides. The reference pages are the documents Tau's own code follows.</p>${[...new Set(rendered.map((page) => page.group))].map((group) => `<h2 id="${slugify(group)}">${escapeText(group)}</h2>${cards(group)}`).join("")}<p>The rest of the documentation, the decision records among it, lives in the <a href="${REPO_URL}/tree/main/docs">docs folder</a> on GitHub.</p>`;
  writeFileSync(join(out, "index.html"), pageHtml({ title: "Docs", description: "Guides and reference for Tau, a workbench for coding agents.", body: home, nav: navigation(rendered), header, footer }));
  written.push(join(out, "index.html"));
  return written.map((file) => relative(root, file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const written = buildDocs();
  console.log(`[site] ${written.length} pages in ${relative(ROOT, dirname(join(ROOT, written[0])))}`);
}
