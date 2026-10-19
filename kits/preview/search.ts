/** What the Preview address bar does with text that is not an address. */

export const SEARCH_ENGINES = [
  { id: "duckduckgo", label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  { id: "google", label: "Google", template: "https://www.google.com/search?q=%s" },
  { id: "bing", label: "Bing", template: "https://www.bing.com/search?q=%s" },
  { id: "brave", label: "Brave", template: "https://search.brave.com/search?q=%s" },
  { id: "kagi", label: "Kagi", template: "https://kagi.com/search?q=%s" },
  { id: "startpage", label: "Startpage", template: "https://www.startpage.com/do/search?query=%s" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"] | "custom";

export interface PreviewSearch {
  engine: SearchEngineId;
  /** The template for `custom`, with `%s` where the query goes. */
  custom: string;
}

export const DEFAULT_SEARCH: PreviewSearch = { engine: "duckduckgo", custom: "" };

export function readSearch(engine: unknown, custom: unknown): PreviewSearch {
  const known = engine === "custom" || SEARCH_ENGINES.some((entry) => entry.id === engine);
  return { engine: known ? engine as SearchEngineId : DEFAULT_SEARCH.engine, custom: typeof custom === "string" ? custom.trim() : "" };
}

const fill = (template: string, query: string) => template.replaceAll("%s", encodeURIComponent(query));

/** Why a custom template is refused, or `undefined` when it is usable. */
export function searchTemplateProblem(template: string): string | undefined {
  const text = template.trim();
  if (!text.includes("%s")) return "Put %s where the search text goes.";
  try {
    // `%s` before the path would make the host depend on the query.
    const authority = (url: URL) => `${url.username}:${url.password}@${url.host}`;
    const first = new URL(fill(text, "a"));
    const second = new URL(fill(text, "b"));
    if (first.protocol !== "https:") return "Use an https:// address.";
    if (authority(first) !== authority(second)) return "Keep %s out of the host name.";
  } catch {
    return "That is not a web address.";
  }
  return undefined;
}

/** The engine's search URL for `query`; a missing or unusable custom template falls back to DuckDuckGo. */
export function searchUrl(query: string, search: PreviewSearch = DEFAULT_SEARCH): string {
  const entry = SEARCH_ENGINES.find((engine) => engine.id === search.engine);
  const custom = search.engine === "custom" && search.custom && !searchTemplateProblem(search.custom) ? search.custom : undefined;
  return fill(custom ?? entry?.template ?? SEARCH_ENGINES[0].template, query);
}

const SCHEMES_AS_URLS = new Set(["http", "https", "file", "about", "javascript", "data", "blob", "ws", "wss", "ftp", "view-source", "chrome", "devtools"]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;
// A bare `README.md` or `app.js` is a file name, not a site.
const FILE_EXTENSIONS = new Set(["html", "htm", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "css", "scss", "md", "mdx", "txt", "py", "rs", "sh", "rb", "pl", "go", "java", "php", "yml", "yaml", "toml", "xml", "svg", "png", "jpg", "jpeg", "gif", "pdf", "log", "lock", "zip", "csv", "sql", "env", "conf", "cfg", "ini", "vue", "map", "wasm"]);

function isHost(authority: string, bare: boolean): boolean {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/iu.test(host)) return true;
  const port = /:(\d{1,5})$/u.exec(host);
  const name = port ? host.slice(0, -port[0].length) : host;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label))) return false;
  if (name.toLowerCase() === "localhost" || name.toLowerCase().endsWith(".localhost")) return true;
  const numeric = labels.length === 4 && labels.every((label) => /^\d{1,3}$/u.test(label) && Number(label) <= 255);
  if (numeric) return true;
  if (port) return true;
  if (labels.length < 2) return false;
  const tld = labels.at(-1)!.toLowerCase();
  if (!/^(?:[a-z]{2,24}|xn--[a-z0-9-]+)$/u.test(tld)) return false;
  return !(bare && labels.length === 2 && FILE_EXTENSIONS.has(tld));
}

/**
 * Whether text typed in the address bar names a page (a URL, host, `localhost:port`, IP,
 * workspace path or `about:` page) or is words to search for.
 */
export function looksLikeAddress(input: string): boolean {
  const text = input.trim();
  if (!text) return true;
  // A leading `?` forces a search, as in other browsers.
  if (text.startsWith("?")) return false;
  if (text.startsWith("/") || /^[a-z]:[\\/]/iu.test(text) || text.startsWith("\\\\")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/iu.exec(text);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (/\s/u.test(text)) return (name === "http" || name === "https" || name === "file") && text.startsWith(`${name}://`);
    return SCHEMES_AS_URLS.has(name) || text.startsWith(`${name}://`);
  }
  if (/\s/u.test(text)) return false;
  const end = text.search(/[/?#]/u);
  return isHost(end < 0 ? text : text.slice(0, end), end < 0);
}

/** What the address bar loads for typed text: the address itself, or the search results. */
export function resolveTypedInput(input: string, search: PreviewSearch): string {
  const text = input.trim();
  if (looksLikeAddress(text)) return text;
  return searchUrl(text.startsWith("?") ? text.slice(1).trim() : text, search);
}
