import { HostCommandError, type HostExtension, type HostExtensionContext, type RuntimeExtensionFactory } from "tau/host-extension";
import { join } from "node:path";
import { preparePageDocument } from "./document.js";
import { HTML_PAGES_EXTENSION_ID, HTML_PAGE_COMMANDS, type HtmlPageOpen } from "./protocol.js";
import { showPage } from "./show.js";
import { PageStore } from "./store.js";
import { SHOW_PAGE_INSTRUCTIONS, showHtmlPageTool } from "./tools.js";

const MAX_ID = 200;

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HostCommandError("The request is malformed.");
  return input as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new HostCommandError(`The request names no valid ${what}.`);
  return value;
}

/**
 * HTML Pages Kit's host entry: the `show_html_page` tool for Pi (deferred) and
 * over MCP, the pages kept per thread under the kit's state folder, and the
 * command that publishes one as a sandboxed frame for a client to draw.
 */
export function createHtmlPagesHostExtension(): HostExtension {
  return {
    id: HTML_PAGES_EXTENSION_ID,
    name: "HTML Pages",
    permissions: ["sessions", "runtime:extend", "network"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const store = new PageStore({ directory: join(services.stateDir, "pages") });
      const disposers: Array<() => void> = [];

      // Minting a frame and releasing it change nothing a device paired Read only could not see.
      context.registerCommand(HTML_PAGE_COMMANDS.open, async (input): Promise<HtmlPageOpen> => {
        const call = record(input);
        const resources = services.browserResources;
        if (!resources) throw new HostCommandError("This machine serves no sandboxed frames.");
        const page = await store.get(text(call.threadId, "thread"), text(call.id, "page"));
        if (!page) return { state: "missing" };
        const colorScheme = call.colorScheme === "dark" ? "dark" : "light";
        const path = resources.publishFrame({
          html: preparePageDocument(page.html, { theme: call.theme }),
          ...(page.meta.origins.length > 0 ? { csp: { resourceDomains: page.meta.origins } } : {}),
          colorScheme,
        });
        return { state: "ready", path, title: page.meta.title, maxHeight: page.meta.maxHeight, origins: page.meta.origins };
      }, { access: "read" });

      context.registerCommand(HTML_PAGE_COMMANDS.release, (input) => {
        const call = record(input);
        if (typeof call.path === "string") services.browserResources?.release(call.path);
        return {};
      }, { access: "read" });

      // A thread in the trash keeps its pages; only a purge takes them.
      disposers.push(services.registerThreadLifecycle({ threadDeleted: (threadId) => store.forgetThread(threadId) }));

      const factory: RuntimeExtensionFactory = (pi, session) => {
        pi.registerTool(showHtmlPageTool((input) => showPage(store, { sessionId: session.sessionId, cwd: session.cwd }, input)));
      };
      disposers.push(services.registerRuntimeExtension("tau-html-pages", factory));
      disposers.push(services.mcp.registerTools((thread) => [
        showHtmlPageTool((input) => showPage(store, { sessionId: thread.sessionId, cwd: thread.cwd }, input)),
      ]));
      const instructions = services.mcp.registerInstructions?.(() => SHOW_PAGE_INSTRUCTIONS);
      if (instructions) disposers.push(instructions);

      return () => { for (const dispose of disposers.reverse()) dispose(); };
    },
  };
}

export default createHtmlPagesHostExtension;
