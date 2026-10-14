/**
 * HTML Pages Kit: what its host half, its desktop half and its tool agree on.
 * No imports, so both halves can take it.
 */

export const HTML_PAGES_EXTENSION_ID = "tau.html-pages";

/** The tool as Pi names it; other runtimes see it as `mcp__tau__show_html_page`. */
export const SHOW_HTML_PAGE_TOOL = "show_html_page";

export const HTML_PAGE_STAGE_TAB = "tau.html-pages.page";

export const HTML_PAGE_COMMANDS = { open: "open", release: "release" } as const;

/**
 * Preview Kit's link service, copied rather than imported (a kit never imports
 * another kit): the part a page's links use.
 */
export const PREVIEW_LINKS_SERVICE = "tau.preview/links";

export interface PreviewLinksService {
  /** Opens `url` in the Preview and answers true, or answers false when the system browser is the place and the caller opens it. */
  open(url: string, event: { metaKey: boolean; ctrlKey: boolean }, actions: { openPanel(id: string): void }): boolean;
}

export const HTML_PAGE_LIMITS = {
  /** The document the agent writes or points at. */
  htmlBytes: 1024 * 1024,
  /** One local image, and all of them together, embedded into a page. */
  imageBytes: 3 * 1024 * 1024,
  imagesBytes: 4 * 1024 * 1024,
  titleLength: 120,
  origins: 8,
  pagesPerThread: 40,
  bytesPerThread: 50 * 1024 * 1024,
  /** The most a card takes of the thread, in CSS px, unless the agent asks for more. */
  defaultMaxHeight: 720,
} as const;

/** What a page and its card say about images, besides the MCP Apps size and link messages. */
export const PAGE_MESSAGES = {
  /** Page → card: whether the page shows only images and text. */
  media: "tau/notifications/page-media",
  /** Page → card, on a click: the page's images and the one clicked. */
  openImages: "tau/open-images",
  /** Card → page, a request: the page's images, for Expand. */
  listImages: "tau/list-images",
} as const;

const MCP_TAU_PREFIX = "mcp__tau__";

/** Whether a tool run is this kit's tool, whichever runtime reported it. */
export function isShowHtmlPage(toolName: string): boolean {
  return (toolName.startsWith(MCP_TAU_PREFIX) ? toolName.slice(MCP_TAU_PREFIX.length) : toolName) === SHOW_HTML_PAGE_TOOL;
}

const MARKER = /\[tau-html-page:([A-Za-z0-9_-]{6,64})\]/u;

/** The line of a tool result that names the page; a card reads it back from the transcript. */
export const pageMarker = (id: string): string => `[tau-html-page:${id}]`;

export function pageIdOf(output: string | undefined): string | undefined {
  return output ? MARKER.exec(output)?.[1] : undefined;
}

/** Tau's tokens, by the variable a page reads them as. The card resolves them; the host writes them into the page. */
export const PAGE_THEME_TOKENS: Readonly<Record<string, string>> = {
  "--background": "--stage",
  "--foreground": "--ink",
  "--muted": "--sunken",
  "--muted-foreground": "--muted",
  "--card": "--field",
  "--card-foreground": "--ink-2",
  "--secondary": "--raised",
  "--secondary-foreground": "--ink-2",
  "--border": "--line-card",
  "--input": "--line-field",
  "--ring": "--focus",
  "--accent": "--acid",
  "--accent-foreground": "--acid-ink",
  "--accent-surface": "--acid-bg",
  "--accent-surface-foreground": "--acid-text",
  "--destructive": "--stop",
  "--destructive-foreground": "--stop-ink",
  "--destructive-surface": "--danger-bg",
  "--warning": "--warn",
  "--warning-surface": "--warn-chip",
  "--success": "--ready",
  "--info": "--info",
  "--code-background": "--code-bg",
  "--code-foreground": "--ink-code",
  "--font-sans": "--sans",
  "--font-mono": "--mono",
  "--radius": "--radius-md",
};

export interface HtmlPageOpenInput {
  threadId: string;
  id: string;
  colorScheme: "light" | "dark";
  /** The page variables resolved from `PAGE_THEME_TOKENS`; whatever is missing falls back to a built-in value. */
  theme?: Record<string, string>;
}

export type HtmlPageOpen =
  | {
    state: "ready";
    /** The capability path for `host.resourceUrl`. */
    path: string;
    title: string;
    /** The most the card may take, in CSS px. */
    maxHeight: number;
    /** The https origins the page declared; empty for a page that loads nothing. */
    origins: readonly string[];
  }
  | { state: "missing" };
