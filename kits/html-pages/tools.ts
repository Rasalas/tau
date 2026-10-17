import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PageError } from "./document.js";
import { HTML_PAGE_LIMITS, PREVIEW_HTML_PAGE_TOOL, SHOW_HTML_PAGE_TOOL, pageMarker } from "./protocol.js";
import type { ShowInput, ShownPage } from "./show.js";
import type { PagePreview, PagePreviewInput } from "./preview.js";

// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
type AnyTool = ToolDefinition<TSchema, any, any>;

/** Pi loads the tool on demand through `tool_search`; the description is what it lists the group by. */
const GROUP = {
  exposure: "deferred" as const,
  namespace: { name: "pages", description: "Interactive HTML pages (chart, diagram, mockup, gallery) shown in the thread." },
};

const parameters = Type.Object({
  title: Type.String({ description: "Short name for the page." }),
  html: Type.Optional(Type.String({ description: "A complete, self-contained HTML document with inline <style> and <script>. Give this or path." })),
  path: Type.Optional(Type.String({ description: "An HTML file in the project or the temp folder, for a page too long to pass inline. Give this or html." })),
  origins: Type.Optional(Type.Array(Type.String(), { description: "https origins the page loads scripts, styles, fonts or images from, e.g. https://cdn.jsdelivr.net for a chart library. Nothing else loads." })),
  height: Type.Optional(Type.Integer({ description: `The most the page may take in the thread, in CSS px, 80-2000 (${HTML_PAGE_LIMITS.defaultMaxHeight} by default). The page sizes itself to its content up to this and scrolls beyond.` })),
});

const THEME_GUIDE = [
  "Tau's theme reaches the page as CSS custom properties on :root and follows light and dark mode:",
  "--background (identical to the thread around the page), --foreground, --muted, --muted-foreground, --card, --card-foreground,",
  "--secondary, --secondary-foreground, --border, --input, --ring, --accent (brand blue), --accent-foreground, --accent-surface,",
  "--accent-surface-foreground, --destructive, --destructive-foreground, --destructive-surface, --warning, --warning-surface,",
  "--success, --info, --code-background, --code-foreground, --chart-1 to --chart-6 (categorical series), --radius, --font-sans, --font-mono.",
  "The base style sets html background, colour and font from them and body margin to 0; your own CSS overrides it.",
].join(" ");

export const SHOW_HTML_PAGE_DESCRIPTION = [
  "Show an interactive HTML page (chart, table, diagram, image collage, mockup, small tool) inline in this thread, above your reply. Call it before writing the reply; the reader already sees the page, so the reply adds only what the page does not say.",
  "Check the screenshot and errors with preview_html_page before publishing.",
  "Write one self-contained document. Scripts run in a sandbox with no network: fetch, XHR and WebSocket are blocked, and a library loads only from an https origin you list in origins.",
  "Local images (an absolute or project-relative path in src or url()) are embedded when you call this. A link opens in the reader's browser after a click. A click on an image opens it in Tau's image viewer, so build no lightbox of your own.",
  "The page sits on the thread's own background: leave html and body without a background colour, use a fluid width with no outer card or title, give charts fixed pixel heights and avoid 100vh.",
  THEME_GUIDE,
].join(" ");

/**
 * The tool a thread's agent calls to show a page. `show` is bound to the
 * thread by whoever registers it (the runtime or the MCP credential), never
 * by the call.
 */
export function showHtmlPageTool(show: (input: ShowInput) => Promise<ShownPage>): AnyTool {
  const tool: ToolDefinition<typeof parameters, undefined> = {
    annotations: { readOnlyHint: true },
    name: SHOW_HTML_PAGE_TOOL,
    label: SHOW_HTML_PAGE_TOOL,
    description: SHOW_HTML_PAGE_DESCRIPTION,
    promptSnippet: "show_html_page: show an interactive HTML page in the thread",
    parameters,
    executionMode: "sequential",
    ...GROUP,
    execute: async (_id, params): Promise<AgentToolResult<undefined> & { isError?: boolean }> => {
      try {
        const shown = await show(params);
        const text = [`Showing "${shown.title}" to the user above your reply. ${pageMarker(shown.id)}`, ...shown.notes].join(" ");
        return { content: [{ type: "text", text }], details: undefined };
      } catch (error) {
        if (!(error instanceof PageError)) throw error;
        return { content: [{ type: "text", text: error.message }], details: undefined, isError: true };
      }
    },
  };
  return tool as unknown as AnyTool;
}

const previewParameters = Type.Object({
  ...parameters.properties,
  width: Type.Optional(Type.Integer({ description: "Screenshot width in CSS pixels, 240-1600, default 1000. height sets its viewport height." })),
  colorScheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Colour scheme to check, default light. Uses Tau's default page theme." })),
});

/** The same thread-bound preparation as publishing, without a page marker. */
export function previewHtmlPageTool(preview: (input: PagePreviewInput, signal?: AbortSignal) => Promise<PagePreview>): AnyTool {
  const tool: ToolDefinition<typeof previewParameters, undefined> = {
    annotations: { readOnlyHint: true },
    name: PREVIEW_HTML_PAGE_TOOL,
    label: PREVIEW_HTML_PAGE_TOOL,
    description: "Check an HTML page before showing it: returns a PNG screenshot and up to 20 console, script or resource errors. Accepts the same title, html or path, origins and height as show_html_page. Runs in the same sandbox and network policy, in a fresh browser profile. Requires installed Chrome or Chromium. This does not show or save the page; call show_html_page explicitly after checking and fixing it.",
    promptSnippet: "preview_html_page: check an HTML page's screenshot and errors before showing it",
    parameters: previewParameters,
    executionMode: "sequential",
    ...GROUP,
    execute: async (_id, params, signal): Promise<AgentToolResult<undefined> & { isError?: boolean }> => {
      try {
        const page = await preview(params, signal);
        return {
          content: [
            { type: "image", mimeType: "image/png", data: page.base64 },
            { type: "text", text: [
              `HTML preview ${page.width} × ${page.height}. Not published. Call show_html_page to show the page.`,
              ...page.notes,
              page.consoleErrors.length ? `Errors (up to 20, 2000 characters each):\n${page.consoleErrors.join("\n")}` : "No console or resource errors observed during this capture.",
            ].join("\n") },
          ], details: undefined,
        };
      } catch (error) {
        if (!(error instanceof PageError)) throw error;
        return { content: [{ type: "text", text: error.message }], details: undefined, isError: true };
      }
    },
  };
  return tool as unknown as AnyTool;
}

/** The section of the MCP instructions for runtimes that see every tool at once. */
export const SHOW_PAGE_INSTRUCTIONS = `When a chart, table, diagram, image collage or mockup says more than prose, build a self-contained HTML page, check its screenshot and errors with ${PREVIEW_HTML_PAGE_TOOL}, then show it with ${SHOW_HTML_PAGE_TOOL} before your reply. The reader sees the page above the reply, so do not announce or restate it.`;
