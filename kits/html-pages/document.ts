import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { HTML_PAGE_LIMITS, PAGE_MESSAGES, PAGE_THEME_TOKENS } from "./protocol.js";

/** Why a page cannot be shown; the text goes back to the agent. */
export class PageError extends Error {}

// ------------------------------------------------------------------ origins

const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".home.arpa"];

function isAddress(host: string): boolean {
  // A bare number is read as an address by URL parsers (`http://2130706433`), and `[…]` is IPv6.
  return /^\d+$/u.test(host) || /^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.startsWith("[") || host.includes(":");
}

/**
 * The https origins a page asks to load scripts, styles, fonts and images from
 * (a chart library's CDN). A CSP cannot tell a private address from a public
 * one, so only named public hosts are accepted: no addresses, `localhost` or
 * local-network suffixes, no wildcards, no plain http.
 */
export function readOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PageError("origins must be a list of https origins.");
  if (value.length > HTML_PAGE_LIMITS.origins) throw new PageError(`At most ${HTML_PAGE_LIMITS.origins} origins.`);
  const out: string[] = [];
  for (const entry of value) {
    let url: URL;
    try { url = new URL(typeof entry === "string" ? entry : ""); } catch { throw new PageError(`"${String(entry)}" is not an origin like https://cdn.jsdelivr.net.`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") throw new PageError(`"${String(entry)}": only https origins can be declared.`);
    if (url.username || url.password) throw new PageError(`"${String(entry)}": an origin carries no credentials.`);
    if (isAddress(host) || host === "localhost" || !host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new PageError(`"${String(entry)}": local and private addresses cannot be declared.`);
    }
    if (!/^[a-z0-9.-]+$/u.test(host)) throw new PageError(`"${String(entry)}" is not a plain host name.`);
    const origin = `https://${host}${url.port ? `:${url.port}` : ""}`;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

// ------------------------------------------------------------ local images

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
};

export interface InlineImagesOptions {
  /** Where a relative path starts. */
  baseDir: string;
  /** Folders an image may come from. */
  roots: readonly string[];
}

export interface InlinedImages { html: string; embedded: number; skipped: string[] }

const SRC = /(<(?:img|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*?)\2/giu;
const URL_FN = /url\(\s*(["']?)([^)"']+?)\1\s*\)/giu;

function localCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const local = /^file:\/\//iu.test(trimmed) || /^[a-z]:[\\/]/iu.test(trimmed);
  if (!local && /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(trimmed)) return undefined;
  const path = trimmed.replace(/^file:\/\//iu, "").replace(/[?#].*$/u, "");
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
  if (!extension || !(extension in IMAGE_TYPES)) return undefined;
  try { return decodeURI(path); } catch { return path; }
}

async function inside(roots: readonly string[], path: string): Promise<boolean> {
  for (const root of roots) {
    let real: string;
    try { real = await realpath(root); } catch { continue; }
    if (path === real || path.startsWith(real.endsWith(sep) ? real : real + sep)) return true;
  }
  return false;
}

/**
 * Embeds the local images a page names (`src="/abs/a.png"`, `url(./b.webp)`)
 * as data URLs, so the page keeps working after the files move and needs no
 * file access. Only files under `roots` are read; whatever cannot be embedded
 * stays as written and is reported.
 */
export async function inlineLocalImages(html: string, options: InlineImagesOptions): Promise<InlinedImages> {
  const wanted = new Set<string>();
  for (const match of html.matchAll(SRC)) { const candidate = localCandidate(match[3]!); if (candidate) wanted.add(candidate); }
  for (const match of html.matchAll(URL_FN)) { const candidate = localCandidate(match[2]!); if (candidate) wanted.add(candidate); }
  if (wanted.size === 0) return { html, embedded: 0, skipped: [] };

  const loaded = new Map<string, string>();
  const skipped: string[] = [];
  let total = 0;
  for (const candidate of wanted) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(options.baseDir, candidate);
    try {
      const real = await realpath(absolute);
      if (!(await inside(options.roots, real))) { skipped.push(`${candidate} (outside the project)`); continue; }
      const bytes = await readFile(real);
      if (bytes.length > HTML_PAGE_LIMITS.imageBytes || total + bytes.length > HTML_PAGE_LIMITS.imagesBytes) { skipped.push(`${candidate} (too large to embed)`); continue; }
      total += bytes.length;
      const extension = /\.([a-z0-9]+)$/iu.exec(real)?.[1]?.toLowerCase() ?? "";
      loaded.set(candidate, `data:${IMAGE_TYPES[extension]};base64,${bytes.toString("base64")}`);
    } catch {
      skipped.push(`${candidate} (not found)`);
    }
  }
  const swap = (value: string) => { const candidate = localCandidate(value); return candidate ? loaded.get(candidate) : undefined; };
  const result = html
    .replace(SRC, (whole, head: string, quote: string, value: string) => { const data = swap(value); return data ? `${head}${quote}${data}${quote}` : whole; })
    .replace(URL_FN, (whole, quote: string, value: string) => { const data = swap(value); return data ? `url(${quote}${data}${quote})` : whole; });
  return { html: result, embedded: loaded.size, skipped };
}

/** Where a page file may be read from: under the project or the temp folder. */
export async function readPageFile(path: string, options: { cwd: string; roots: readonly string[] }): Promise<{ html: string; baseDir: string }> {
  const absolute = isAbsolute(path) ? path : join(options.cwd, path);
  let real: string;
  try { real = await realpath(absolute); } catch { throw new PageError(`No file at ${path}.`); }
  if (!(await inside(options.roots, real))) throw new PageError(`${path} is outside the project and the temp folder.`);
  const bytes = await readFile(real);
  if (bytes.length > HTML_PAGE_LIMITS.htmlBytes) throw new PageError(`${path} is larger than ${HTML_PAGE_LIMITS.htmlBytes / 1024} KiB.`);
  return { html: bytes.toString("utf8"), baseDir: dirname(real) };
}

// ----------------------------------------------------------------- document

// The values the page falls back to when the client sent none (an old client, a bare test).
const FALLBACK_THEME: Record<string, string> = {
  "--background": "light-dark(#fbfaf8, #0f1116)",
  "--foreground": "light-dark(#1c1b19, #e3e6ec)",
  "--muted": "light-dark(#f4f2ef, #13161b)",
  "--muted-foreground": "light-dark(#6d665d, #9197a1)",
  "--card": "light-dark(#f0eeea, #171a1f)",
  "--card-foreground": "light-dark(#35312c, #d0d4db)",
  "--secondary": "light-dark(#e1dfdb, #24272c)",
  "--secondary-foreground": "light-dark(#35312c, #d0d4db)",
  "--border": "light-dark(#1c1b191a, #e3e6ec1c)",
  "--input": "light-dark(#1c1b1929, #e3e6ec29)",
  "--ring": "light-dark(#4f79c9, #6b93e0)",
  "--accent": "light-dark(#4b75c5, #6b93e0)",
  "--accent-foreground": "light-dark(#ffffff, #10131a)",
  "--accent-surface": "light-dark(#e9effa, #121d36)",
  "--accent-surface-foreground": "light-dark(#2f4f8f, #a6bfee)",
  "--destructive": "light-dark(#c2282d, #e5484d)",
  "--destructive-foreground": "#ffffff",
  "--destructive-surface": "light-dark(#fbe9e7, #301613)",
  "--warning": "light-dark(#82601a, #ffbd34)",
  "--warning-surface": "light-dark(#fcf3dc, #291e05)",
  "--success": "light-dark(#2f633c, #56dc85)",
  "--info": "light-dark(#4f79c9, #6b93e0)",
  "--code-background": "light-dark(#f0eeea, #171a1f)",
  "--code-foreground": "light-dark(#433e38, #c2c6ce)",
  "--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  "--radius": "10px",
};

// Categorical series after the accent; the same in every client.
const CHARTS = [
  "light-dark(#0d9488, #2dd4bf)", "light-dark(#d97706, #fbbf24)", "light-dark(#9333ea, #c084fc)", "light-dark(#e11d48, #fb7185)", "light-dark(#65a30d, #a3e635)",
];

const MAX_THEME_VARIABLES = 80;
const MAX_THEME_VALUE = 240;

/** Variables a client sent, reduced to the names the kit knows and values that cannot leave their declaration. */
export function readTheme(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value).slice(0, MAX_THEME_VARIABLES)) {
    if (!(name in PAGE_THEME_TOKENS) || typeof raw !== "string") continue;
    const cleaned = raw.replace(/[;{}<>\\]/gu, "").trim();
    if (!cleaned || cleaned.length > MAX_THEME_VALUE || /url\s*\(|@import|expression\s*\(/iu.test(cleaned)) continue;
    out[name] = cleaned;
  }
  return out;
}

function themeCss(theme: Record<string, string>): string {
  const variables = { ...FALLBACK_THEME, ...theme };
  const declarations = Object.entries(variables).map(([name, value]) => `${name}:${value};`).join("");
  const charts = ["var(--accent)", ...CHARTS].map((color, index) => `--chart-${index + 1}:${color};`).join("");
  return `:root{${declarations}${charts}}`
    + "html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}"
    + "body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}img:not(a[href] img,button img){cursor:zoom-in}";
}

const MESSAGES = { size: "ui/notifications/size-changed", link: "ui/open-link", media: PAGE_MESSAGES.media, openImages: PAGE_MESSAGES.openImages, listImages: PAGE_MESSAGES.listImages } as const;

// Anything but images and text keeps Expand on the page itself.
const NOT_A_GALLERY = "canvas,video,audio,iframe,object,embed,input,select,textarea,button,table";

// Reports the page's height to the card and hands a clicked http(s) link, with its ⌘ and Ctrl state, to it; the frame cannot open a window itself.
// Images go to the card too: a click opens Tau's viewer, and a page of only images says so, for Expand.
const BOOTSTRAP = `(function(){var n=0,h,g;function post(m){try{window.parent.postMessage(m,"*");}catch(e){}}`
  + `function imgs(){return Array.prototype.filter.call(document.images,function(i){return i.complete&&i.naturalWidth>0&&(i.currentSrc||i.src)&&!i.closest("a[href],button");});}`
  + `function list(a){return a.map(function(i){return{src:i.currentSrc||i.src,alt:i.alt||i.title||""};});}`
  + `document.addEventListener("click",function(e){if(!e.isTrusted)return;var p=e.composedPath(),a=p.find(function(t){return t&&t.matches&&t.matches("a[href]");});`
  + `if(!a){var t=p[0];if(!t||t.tagName!=="IMG")return;var l=imgs(),k=l.indexOf(t);if(k<0)return;e.preventDefault();post({jsonrpc:"2.0",method:${JSON.stringify(MESSAGES.openImages)},params:{images:list(l),index:k}});return;}`
  + `var u=a.getAttribute("href")||"";if(!/^https?:\\/\\//i.test(u))return;e.preventDefault();post({jsonrpc:"2.0",id:"tau-link-"+(++n),method:${JSON.stringify(MESSAGES.link)},params:{url:u,metaKey:e.metaKey,ctrlKey:e.ctrlKey}});},true);`
  + `window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||d.method!==${JSON.stringify(MESSAGES.listImages)})return;post({jsonrpc:"2.0",id:d.id,result:{images:list(imgs())}});});`
  + `function m(){var v=imgs().length>0&&!document.querySelector(${JSON.stringify(NOT_A_GALLERY)})&&!Array.prototype.some.call(document.querySelectorAll("svg"),function(s){var r=s.getBoundingClientRect();return r.width>=100&&r.height>=100;});`
  + `if(v===g)return;g=v;post({jsonrpc:"2.0",method:${JSON.stringify(MESSAGES.media)},params:{gallery:v}});}`
  + `function z(){m();var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;post({jsonrpc:"2.0",method:${JSON.stringify(MESSAGES.size)},params:{height:v}});}`
  + `var o;if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}`
  + `document.addEventListener("load",m,true);document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`;

/**
 * The page as the frame loads it: Tau's theme variables and base style, the
 * height and link reporter, then the agent's markup. Core adds the doctype,
 * the policy and the colour scheme in front of all of it.
 */
export function preparePageDocument(html: string, options: { theme?: unknown } = {}): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="tau-page-theme">${themeCss(readTheme(options.theme))}</style><script>${BOOTSTRAP}</script>`;
  const doctype = /^﻿?\s*<!doctype[^>]*>/iu.exec(html);
  const body = doctype ? html.slice(doctype[0].length) : html;
  const opening = /<head(?:\s[^>]*)?>/iu.exec(body.slice(0, 8192));
  const at = opening ? opening.index + opening[0].length : 0;
  return `${doctype?.[0] ?? ""}${body.slice(0, at)}${head}${body.slice(at)}`;
}
