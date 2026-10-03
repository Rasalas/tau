import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HostEvent } from "../shared/contracts.js";
import type { HostExtension, HostExtensionContext, HostMcpConnection } from "./host-extensions.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

function idleThread(threadId: string, cwd: string) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd,
    turnReporting: "streamed" as const,
    capabilities: {},
    state: () => ({ streaming: false, idle: true, hasMessages: true, sessionFile: `/${threadId}.jsonl`, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never);
}

/** A kit that offers one tool and asks before running it. */
const toolKit: HostExtension = {
  id: "test.tools",
  name: "Tools",
  permissions: ["runtime:extend"],
  activate: (context) => {
    const tools = context.services.mcp.registerTools((thread) => [{
      name: "where",
      label: "where",
      description: "Names the thread it serves",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: thread.sessionId }], details: undefined }),
    }]);
    const gate = context.services.mcp.gate(async (call) => (await call.confirm(`Run ${call.toolName}?`, call.cwd)) ? undefined : { block: true, reason: "declined" });
    return () => { tools(); gate(); };
  },
};

async function host(extensions: HostExtension[]) {
  const events: HostEvent[] = [];
  const pi = new PiHost("/repo", (event) => events.push(event), {} as never, false, false, { hostExtensions: extensions });
  const internals = pi as unknown as Record<string, any>;
  await internals.activateHostExtensions();
  await internals.threads.adopt({ threadId: "codex-thread", cwd: "/repo", runtime: idleThread("codex-thread", "/repo"), isolation: "in-process" });
  return { pi, internals, events };
}

function status(connection: HostMcpConnection): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(connection.url, { method: "POST", headers: { ...connection.headers, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
}

describe("the MCP seam of the host", () => {
  it("serves a kit's tools to the thread a credential names, asks in that thread, and revokes it with the runtime", async () => {
    let runtimeKit: HostExtensionContext | undefined;
    const { pi, internals, events } = await host([toolKit, { id: "test.runtime", name: "Runtime", permissions: ["runtime:extend"], activate: (context) => { runtimeKit = context; } }]);
    try {
      const connection = (await runtimeKit!.services.mcp.connect({ sessionId: "codex-thread", cwd: "/repo" }))!;
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["where"]);

      // The gate's question is an ordinary extension dialog of that thread.
      const call = client.callTool({ name: "where", arguments: {} });
      const prompt = await new Promise<{ id: string; sessionId: string; title: string }>((resolve) => {
        const poll = () => {
          const asked = events.find((event) => event.type === "extension-ui-prompt") as { prompt: { id: string; sessionId: string; title: string } } | undefined;
          if (asked) resolve(asked.prompt); else setImmediate(poll);
        };
        poll();
      });
      expect(prompt).toMatchObject({ sessionId: "codex-thread", title: "Run where?" });
      pi.answerExtensionUi(prompt.id, { confirmed: true });
      expect(await call).toMatchObject({ content: [{ type: "text", text: "codex-thread" }] });
      await client.close();

      await internals.threads.release("codex-thread");
      await expect(status(connection)).resolves.toBe(401);
    } finally {
      await internals.seam.mcp.close();
    }
  });

  it("drops a kit's tools when it deactivates, and refuses the seam to a kit without runtime:extend", async () => {
    const { internals } = await host([toolKit]);
    try {
      const services = internals.seam.services;
      const connection = (await services.mcp.connect({ sessionId: "codex-thread", cwd: "/repo" }))!;
      expect((await internals.seam.mcp.tools({ sessionId: "codex-thread", cwd: "/repo" })).map((tool: { name: string }) => tool.name)).toEqual(["where"]);
      await internals.hostExtensions.deactivate("test.tools");
      expect(await internals.seam.mcp.tools({ sessionId: "codex-thread", cwd: "/repo" })).toEqual([]);
      await expect(status(connection)).resolves.toBe(200);

      let denied: unknown;
      await internals.hostExtensions.activate({ id: "test.plain", name: "Plain", permissions: [], activate: (context: HostExtensionContext) => {
        try { context.services.mcp.registerTools(() => []); } catch (error) { denied = error; }
      } });
      expect(String(denied)).toContain("lacks permission runtime:extend");
    } finally {
      await internals.seam.mcp.close();
    }
  });
});
