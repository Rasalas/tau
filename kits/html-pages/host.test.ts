import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostThreadLifecycle, RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit, kitMcpEndpoint } from "../../src/main/test-support/host-kit-harness.js";
import { createHtmlPagesHostExtension } from "./host.js";
import { HTML_PAGES_EXTENSION_ID, PREVIEW_HTML_PAGE_TOOL, SHOW_HTML_PAGE_TOOL, pageIdOf, type HtmlPageOpen } from "./protocol.js";

let stateDir: string;
let project: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tau-pages-state-"));
  project = await mkdtemp(join(tmpdir(), "tau-pages-project-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

async function world() {
  const endpoint = kitMcpEndpoint(() => true);
  const lifecycles: HostThreadLifecycle[] = [];
  const runtime: RuntimeExtensionContribution[] = [];
  const published: Array<{ html: string; csp?: unknown; colorScheme?: string }> = [];
  const released: string[] = [];
  const kit = await activateHostKit(createHtmlPagesHostExtension(), {
    stateDir,
    mcp: endpoint.mcp,
    registerThreadLifecycle: (lifecycle: HostThreadLifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerRuntimeExtension: (name: string, factory: RuntimeExtensionContribution["factory"]) => { runtime.push({ name, factory }); return () => undefined; },
    browserResources: { publish: () => "/p", publishFrame: (document: unknown) => { published.push(document as never); return "/resources/frame-1"; }, release: (path: string) => { released.push(path); } },
  } as never);
  const invoke = (command: string, input?: unknown) => kit.invoke(HTML_PAGES_EXTENSION_ID, command, input);
  return { endpoint, lifecycles, runtime, published, released, invoke, close: async () => { await kit.dispose(); await endpoint.close(); } };
}

const textOf = (result: unknown) => (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? "").join("");

describe("HTML Pages host extension", () => {
  it("offers the tool over MCP and keeps what it was given for the calling thread", async () => {
    const w = await world();
    const client = new Client({ name: "fake-runtime", version: "1.0.0" });
    try {
      const connection = (await w.endpoint.mcp.connect({ sessionId: "thread-1", cwd: project }))!;
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }));
      expect(client.getInstructions()).toContain(SHOW_HTML_PAGE_TOOL);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(SHOW_HTML_PAGE_TOOL);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(PREVIEW_HTML_PAGE_TOOL);

      const invalidPreview = await client.callTool({ name: PREVIEW_HTML_PAGE_TOOL, arguments: { title: "Invalid", html: "<p>x</p>", origins: ["https://localhost"] } });
      expect(invalidPreview.isError).toBe(true);
      expect(textOf(invalidPreview)).toContain("local and private addresses");
      expect(pageIdOf(textOf(invalidPreview))).toBeUndefined();
      expect(w.published).toHaveLength(0);

      const call = (args: Record<string, unknown>) => client.callTool({ name: SHOW_HTML_PAGE_TOOL, arguments: args });
      const shown = await call({ title: "Totals", html: "<h1>Totals</h1>", origins: ["https://cdn.jsdelivr.net"], height: 400 });
      expect(shown.isError).not.toBe(true);
      const id = pageIdOf(textOf(shown))!;
      expect(id).toBeTruthy();

      const open = await w.invoke("open", { threadId: "thread-1", id, colorScheme: "dark", theme: { "--background": "teal" } }) as HtmlPageOpen;
      expect(open).toEqual({ state: "ready", path: "/resources/frame-1", title: "Totals", maxHeight: 400, origins: ["https://cdn.jsdelivr.net"] });
      expect(w.published).toHaveLength(1);
      expect(w.published[0]).toMatchObject({ colorScheme: "dark", csp: { resourceDomains: ["https://cdn.jsdelivr.net"] } });
      expect(w.published[0]!.html).toContain("<h1>Totals</h1>");
      expect(w.published[0]!.html).toContain("--background:teal;");

      // Another thread cannot open it by id.
      expect(await w.invoke("open", { threadId: "thread-2", id, colorScheme: "light" })).toEqual({ state: "missing" });
      await w.invoke("release", { path: "/resources/frame-1" });
      expect(w.released).toEqual(["/resources/frame-1"]);

      // Without declared origins the policy gets none.
      const plain = pageIdOf(textOf(await call({ title: "Plain", html: "<p>x</p>" })))!;
      await w.invoke("open", { threadId: "thread-1", id: plain, colorScheme: "light" });
      expect(w.published[1]).not.toHaveProperty("csp");

      for (const bad of [
        { title: "Both", html: "<p>x</p>", path: "a.html" },
        { title: "Neither" },
        { title: "Local", html: "<p>x</p>", origins: ["https://localhost"] },
      ]) {
        const refused = await call(bad);
        expect(refused.isError).toBe(true);
      }
    } finally {
      await client.close();
      await w.close();
    }
  });

  it("reads a page file and embeds its images, but only from the project", async () => {
    const w = await world();
    const client = new Client({ name: "fake-runtime", version: "1.0.0" });
    try {
      await mkdir(join(project, "out"));
      await writeFile(join(project, "out", "shot.png"), Buffer.from([1, 2, 3]));
      await writeFile(join(project, "out", "page.html"), '<img src="shot.png"><img src="/etc/hosts.png">');
      const connection = (await w.endpoint.mcp.connect({ sessionId: "thread-1", cwd: project }))!;
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }));
      const shown = await client.callTool({ name: SHOW_HTML_PAGE_TOOL, arguments: { title: "Gallery", path: "out/page.html" } });
      expect(textOf(shown)).toContain("Could not embed: /etc/hosts.png (not found)");
      await w.invoke("open", { threadId: "thread-1", id: pageIdOf(textOf(shown)), colorScheme: "light" });
      expect(w.published[0]!.html).toContain('<img src="data:image/png;base64,AQID">');

      const outside = await client.callTool({ name: SHOW_HTML_PAGE_TOOL, arguments: { title: "Secrets", path: "/etc/hosts" } });
      expect(outside.isError).toBe(true);
      expect(textOf(outside)).toContain("outside the project");
    } finally {
      await client.close();
      await w.close();
    }
  });

  it("registers the Pi tool as deferred and deletes a purged thread's pages", async () => {
    const w = await world();
    try {
      expect(w.runtime.map((entry) => entry.name)).toEqual(["tau-html-pages"]);
      const tools: Array<Record<string, unknown>> = [];
      w.runtime[0]!.factory({ registerTool: (tool: Record<string, unknown>) => { tools.push(tool); } } as never, { sessionId: "pi-thread", cwd: project } as never);
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ name: SHOW_HTML_PAGE_TOOL, exposure: "deferred", namespace: { name: "pages" } });
      expect(tools[1]).toMatchObject({ name: PREVIEW_HTML_PAGE_TOOL, exposure: "deferred", namespace: { name: "pages" } });

      const result = await (tools[0]!.execute as (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>)("call", { title: "Pi page", html: "<p>pi</p>" });
      const id = pageIdOf(result.content[0]!.text)!;
      expect(await w.invoke("open", { threadId: "pi-thread", id, colorScheme: "light" })).toMatchObject({ state: "ready", title: "Pi page" });

      await w.lifecycles[0]!.threadDeleted!("pi-thread", project);
      expect(await w.invoke("open", { threadId: "pi-thread", id, colorScheme: "light" })).toEqual({ state: "missing" });
    } finally {
      await w.close();
    }
  });
});
