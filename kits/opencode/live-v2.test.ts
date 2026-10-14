import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel, ThreadRuntimeEvent } from "tau/host-extension";
import { DENY } from "./approvals.js";
import { OpenCode2Api } from "./client-v2.js";
import { openCodeMcpConfig } from "./mcp.js";
import { createOpenCodeRuntimeAdapter } from "./runtime-adapter.js";
import { startOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { OpenCodeSessionStore } from "./session-store.js";
import { OpenCodeThreadRuntimeBackend } from "./thread-backend.js";

/**
 * Against a real OpenCode 2 install, skipped unless `TAU_OPENCODE2_BIN` names
 * its executable (npm i --prefix <dir> @opencode/cli). The server gets a home of
 * its own, never the user's. `TAU_OPENCODE2_TURN=1` also runs turns on a free
 * model that needs no login; they reach the network.
 */
const BIN = process.env.TAU_OPENCODE2_BIN;
const TURNS = process.env.TAU_OPENCODE2_TURN === "1";
const MODEL = { provider: "opencode", id: process.env.TAU_OPENCODE2_MODEL ?? "space-bunny-free" };

const roots: string[] = [];
const stores: OpenCodeSessionStore[] = [];
function trackedStore(store: OpenCodeSessionStore): OpenCodeSessionStore { stores.push(store); return store; }
const servers: OpenCodeServerHandle[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "tau-opencode2-live-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "a.txt"), "alpha beta\n");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  };
  return { root, project, env };
}

async function start(space: Awaited<ReturnType<typeof scratch>>, onExit?: (error: Error | undefined) => void, config?: Record<string, unknown>) {
  const server = await startOpenCodeServer({ command: BIN!, cwd: space.project, env: space.env, ...(config ? { config } : {}), ...(onExit ? { onExit } : {}) });
  servers.push(server);
  return server;
}

/** A one-tool MCP server over streamable HTTP that wants a bearer token, as Tau's own does. */
async function mcpServer(token: string) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      const message = body ? JSON.parse(body) as { id?: number; method: string; params?: { name?: string } } : { method: "" };
      const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
      if (message.method === "initialize") reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "live", version: "1" } });
      else if (message.method === "tools/list") reply({ tools: [{ name: "ping", description: "Answers pong. Call it when asked to ping.", inputSchema: { type: "object", properties: {} } }] });
      else if (message.method === "tools/call") { calls.push(message.params?.name ?? ""); reply({ content: [{ type: "text", text: "tau-pong" }] }); }
      else response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

describe.skipIf(!BIN)("a real OpenCode 2 server", () => {
  it("is recognized, lists its models and keeps a session's rules, title and history", async () => {
    const space = await scratch();
    const server = await start(space);
    expect(server.api.generation).toBe(2);
    await expect(server.api.health()).resolves.toMatchObject({ healthy: true, version: expect.stringMatching(/^2\./u) });
    const providers = await server.api.providers(space.project);
    expect(providers.connected).toContain("opencode");
    expect(Object.keys(providers.all.find((provider) => provider.id === "opencode")!.models).length).toBeGreaterThan(0);
    const session = await server.api.createSession(space.project, { policy: { level: "read-only" } });
    await server.api.renameSession(space.project, session.id, "Tau live check");
    await server.api.applyPolicy(space.project, session.id, { level: "full" });
    await expect(server.api.getSession(space.project, session.id)).resolves.toMatchObject({ id: session.id, title: "Tau live check" });
    await expect(server.api.getSession(space.project, "ses_missing")).rejects.toMatchObject({ status: 404 });
    const listed = await server.api.listHistory({ roots: true, limit: 10 });
    expect(listed).toEqual([expect.objectContaining({ id: session.id, directory: expect.stringContaining("project") })]);
    await expect(server.api.historyMessages(space.project, session.id)).resolves.toEqual({ messages: [] });
    await expect(server.api.settle(space.project, session.id)).resolves.toBeUndefined();

    // A cursor holds no page size: the client names it again, and paging walks every session.
    await server.api.createSession(space.project, { policy: { level: "full" } });
    await server.api.createSession(space.project, { policy: { level: "full" } });
    const client = (server.api as OpenCode2Api).client;
    const first = await client.request<{ data: Array<{ id: string }>; cursor: { next?: string } }>("GET", "/api/session", { query: { limit: "1", order: "desc" } });
    const second = await client.request<{ data: Array<{ id: string }> }>("GET", "/api/session", { query: { limit: "1", cursor: first.cursor.next } });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  it.skipIf(!TURNS)("runs turns: a reply, a refused command, an answered question, a stop and a plan", async () => {
    const space = await scratch();
    const store = trackedStore(new OpenCodeSessionStore({ filePath: join(space.root, "sessions.json") }));
    const events: ThreadRuntimeEvent[] = [];
    const asked: BackendPrompt[] = [];
    let answer: (prompt: BackendPrompt) => ExtensionUiAnswer = () => ({ cancelled: true });
    let level: RuntimePermissionLevel = "full";
    const backend = new OpenCodeThreadRuntimeBackend("live-1", space.project, {
      adapter: createOpenCodeRuntimeAdapter(),
      store,
      connect: async (input) => start(space, input.onExit),
      storedModels: async () => [{ provider: MODEL.provider, id: MODEL.id, name: MODEL.id, variants: [] }],
      onEvent: (event) => events.push(event),
      ask: async (prompt) => { asked.push(prompt); return answer(prompt); },
      permissionLevel: () => level,
    });
    try {
      await backend.start("create");
      await backend.capabilities.catalogWrite!.setModel(MODEL.provider, MODEL.id);

      const reply = await backend.prompt({ text: "Reply with the single word: pong", delivery: "prompt" });
      expect(reply.assistantText?.toLowerCase()).toContain("pong");
      expect(events.find((event) => event.type === "turn-settled")).toMatchObject({ status: "completed" });
      expect(backend.state().title).toBeTruthy();
      expect(backend.catalogView().usage?.turns).toBe(1);

      level = "ask";
      answer = () => ({ value: DENY });
      events.length = 0;
      await backend.prompt({ text: "Run the shell command `echo tau-live` with your shell tool, then reply with the word: done", delivery: "prompt" });
      expect(asked.at(-1)).toMatchObject({ kind: "select", title: "OpenCode wants to run a command" });
      expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { name: "bash", status: "error" } });
      expect(events.find((event) => event.type === "turn-settled")).toMatchObject({ status: "completed" });

      level = "full";
      answer = (prompt) => ({ value: "options" in prompt && prompt.options?.includes("Blue") ? "Blue" : "yes" });
      events.length = 0;
      const questioned = await backend.prompt({ text: "Use your question tool to ask me which colour I prefer, with the options Red and Blue. Then say the colour I chose.", delivery: "prompt" });
      expect(asked.at(-1)).toMatchObject({ kind: "select", options: ["Red", "Blue"] });
      expect(questioned.assistantText).toMatch(/blue/iu);

      events.length = 0;
      const running = backend.prompt({ text: "Run the shell command `sleep 60` with your shell tool, then reply with the word: done", delivery: "prompt" });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => { if (events.some((event) => event.type === "tool-start")) { clearInterval(timer); resolve(); } }, 100);
      });
      await backend.abort();
      await running.catch(() => undefined);
      expect(events.find((event) => event.type === "turn-settled")).toMatchObject({ status: "interrupted" });

      events.length = 0;
      await backend.capabilities.mode!.set("plan");
      await backend.prompt({ text: "Plan how to add a README to this project. Keep it to three bullets.", delivery: "prompt" });
      expect((await backend.transcript()).at(-1)?.text).toContain("proposed_plan");
    } finally {
      await backend.dispose();
    }
  }, 240_000);

  it.skipIf(!TURNS)("gives a thread Tau's MCP tools under the names its cards know", async () => {
    const space = await scratch();
    const mcp = await mcpServer("live-token");
    const store = trackedStore(new OpenCodeSessionStore({ filePath: join(space.root, "sessions.json") }));
    const events: ThreadRuntimeEvent[] = [];
    const backend = new OpenCodeThreadRuntimeBackend("live-2", space.project, {
      adapter: createOpenCodeRuntimeAdapter(),
      store,
      connect: async (input) => start(space, input.onExit, openCodeMcpConfig({ name: "tau", url: mcp.url, token: "live-token", headers: { Authorization: "Bearer live-token" } }, 2)),
      storedModels: async () => [{ provider: MODEL.provider, id: MODEL.id, name: MODEL.id, variants: [] }],
      onEvent: (event) => events.push(event),
      ask: async () => ({ cancelled: true }),
      permissionLevel: () => "ask",
    });
    try {
      await backend.start("create");
      await backend.capabilities.catalogWrite!.setModel(MODEL.provider, MODEL.id);
      await backend.prompt({ text: "Call your tau_ping function directly, as a plain function call and not through execute or search, once. Then reply with its answer.", delivery: "prompt" });
      expect(mcp.calls).toEqual(["ping"]);
      expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { name: "mcp__tau__ping", status: "done", output: "tau-pong" } });
    } finally {
      await backend.dispose();
      await mcp.close();
    }
  }, 120_000);
});
