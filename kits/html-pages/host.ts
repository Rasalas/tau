import { HostCommandError, type HostExtension, type HostExtensionContext, type RuntimeExtensionFactory } from "tau/host-extension";
import { join } from "node:path";
import { preparePageDocument, readOrigins } from "./document.js";
import { HTML_PAGES_EXTENSION_ID, HTML_PAGE_COMMANDS, HTML_PAGE_LIMITS, type HtmlPageOpen } from "./protocol.js";
import { showPage } from "./show.js";
import { PageStore, type StoredPage } from "./store.js";
import { SHOW_PAGE_INSTRUCTIONS, previewHtmlPageTool, showHtmlPageTool } from "./tools.js";
import { PagePreviewer } from "./preview.js";

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
    permissions: ["sessions", "runtime:extend", "network", "process", "machines"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const store = new PageStore({ directory: join(services.stateDir, "pages") });
      const preview = new PagePreviewer({
        stateDir: services.stateDir,
        findCommand: (name) => services.findCommand(name),
        noteSubprocess: () => services.noteSubprocess(),
      });
      const disposers: Array<() => void> = [];

      context.registerCommand(HTML_PAGE_COMMANDS.document, (input) => {
        const call = record(input);
        return store.get(text(call.threadId, "thread"), text(call.id, "page")).then((page) => page ?? null);
      }, { access: "read" });

      const readPage = async (threadId: string, id: string): Promise<StoredPage | undefined> => {
        const split = threadId.indexOf("~");
        const machine = split > 0 && services.machines?.list().find((entry) => entry.id === threadId.slice(0, split));
        if (!machine) return store.get(threadId, id);
        const answer = await services.machines!.call(machine.id, HTML_PAGES_EXTENSION_ID, HTML_PAGE_COMMANDS.document, { threadId: threadId.slice(split + 1), id });
        if (answer === null || answer === undefined) return undefined;
        const page = record(answer);
        const meta = record(page.meta);
        if (page.id !== id || typeof page.html !== "string" || Buffer.byteLength(page.html, "utf8") > 5 * 1024 * 1024
          || typeof meta.title !== "string" || typeof meta.maxHeight !== "number" || !Number.isFinite(meta.maxHeight) || meta.maxHeight <= 0) {
          throw new HostCommandError("The machine returned an invalid HTML page.");
        }
        return { id, html: page.html, meta: { title: meta.title.slice(0, HTML_PAGE_LIMITS.titleLength), maxHeight: meta.maxHeight, origins: readOrigins(meta.origins), createdAt: 0 } };
      };

      // Minting a frame and releasing it change nothing a device paired Read only could not see.
      context.registerCommand(HTML_PAGE_COMMANDS.open, async (input): Promise<HtmlPageOpen> => {
        const call = record(input);
        const resources = services.browserResources;
        if (!resources) throw new HostCommandError("This machine serves no sandboxed frames.");
        const page = await readPage(text(call.threadId, "thread"), text(call.id, "page"));
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
        pi.registerTool(previewHtmlPageTool((input, signal) => preview.render({ cwd: session.cwd }, input, signal)));
      };
      disposers.push(services.registerRuntimeExtension("tau-html-pages", factory));
      disposers.push(services.mcp.registerTools((thread) => [
        showHtmlPageTool((input) => showPage(store, { sessionId: thread.sessionId, cwd: thread.cwd }, input)),
        previewHtmlPageTool((input, signal) => preview.render({ cwd: thread.cwd }, input, signal)),
      ]));
      const instructions = services.mcp.registerInstructions?.(() => SHOW_PAGE_INSTRUCTIONS);
      if (instructions) disposers.push(instructions);

      return async () => { for (const dispose of disposers.reverse()) dispose(); await preview.dispose(); };
    },
  };
}

export default createHtmlPagesHostExtension;
