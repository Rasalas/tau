import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HostMcpConnection, HostMcpInstructionsProvider, HostMcpTool, HostMcpToolGate, HostMcpToolProvider, RuntimeSessionInfo } from "./host-extensions.js";
import { McpEndpoint } from "./mcp-endpoint.js";

const echo = (name: string, onRun: (thread: string, input: unknown) => void = () => undefined, thread = ""): HostMcpTool => ({
  name,
  label: name,
  description: `${name} echoes its text`,
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params: { text: string }) => {
    onRun(thread, params);
    return { content: [{ type: "text", text: `${thread}:${params.text}` }], details: undefined };
  },
});

function endpoint(options: { providers?: HostMcpToolProvider[]; gates?: HostMcpToolGate[]; instructions?: HostMcpInstructionsProvider[]; confirm?: (threadId: string, title: string) => boolean } = {}) {
  const providers = new Set(options.providers ?? []);
  const instructions = [...(options.instructions ?? [])];
  const gates = [...(options.gates ?? [])];
  const logs: string[] = [];
  const questions: Array<{ threadId: string; title: string; message: string }> = [];
  const mcp = new McpEndpoint({
    providers: () => providers,
    instructions: () => instructions,
    gates: () => gates,
    confirm: async (threadId, title, message) => {
      questions.push({ threadId, title, message });
      return options.confirm?.(threadId, title) ?? false;
    },
    log: (label, detail) => logs.push(`${label} ${detail ?? ""}`),
  });
  opened.push(mcp);
  return { mcp, providers, gates, logs, questions };
}

const opened: McpEndpoint[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const mcp of opened.splice(0)) await mcp.close();
});

async function connectClient(connection: HostMcpConnection): Promise<Client> {
  const next = new Client({ name: "test", version: "1.0.0" });
  await next.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }));
  clients.push(next);
  return next;
}

/** A raw POST, for what a well-behaved client never sends. */
function post(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
}

const text = (result: unknown): string =>
  ((result as { content: Array<{ type: string; text?: string }> }).content).map((part) => part.text ?? `[${part.type}]`).join("\n");

describe("the host's MCP endpoint", () => {
  it("tells each thread's runtime the instructions kits registered for it, and none when there are none", async () => {
    const { mcp, logs } = endpoint({
      instructions: [
        (thread) => `<links>Link every request of ${thread.sessionId}.</links>`,
        () => undefined,
        () => { throw new Error("broken"); },
        (thread) => thread.sessionId === "thread-a" ? "  <more>Only for a.</more>  " : undefined,
      ],
    });
    const a = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);
    expect(a.getInstructions()).toBe("<links>Link every request of thread-a.</links>\n\n<more>Only for a.</more>");
    const b = await connectClient((await mcp.connect({ sessionId: "thread-b", cwd: "/project" }))!);
    expect(b.getInstructions()).toBe("<links>Link every request of thread-b.</links>");
    expect(logs.some((line) => line.startsWith("mcp.instructions-failed broken"))).toBe(true);
    const none = endpoint();
    const plain = await connectClient((await none.mcp.connect({ sessionId: "thread-c", cwd: "/project" }))!);
    expect(plain.getInstructions()).toBeUndefined();
  });

  it("binds to loopback and lists and calls the tools registered for the credential's thread", async () => {
    const runs: Array<{ thread: string; input: unknown }> = [];
    const { mcp } = endpoint({ providers: [(thread: RuntimeSessionInfo) => [echo("tau_echo", (id, input) => runs.push({ thread: id, input }), thread.sessionId)]] });
    const connection = (await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!;
    expect(new URL(connection.url).hostname).toBe("127.0.0.1");
    expect(connection.name).toBe("tau");
    expect(connection.headers.Authorization).toBe(`Bearer ${connection.token}`);

    const session = await connectClient(connection);
    const { tools } = await session.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["tau_echo"]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", required: ["text"] });

    const result = await session.callTool({ name: "tau_echo", arguments: { text: "hi" } });
    expect(text(result)).toBe("thread-a:hi");
    expect(runs).toEqual([{ thread: "thread-a", input: { text: "hi" } }]);
  });

  it("refuses a request without a credential, with an unknown one, and after the thread closed", async () => {
    const { mcp } = endpoint({ providers: [() => [echo("tau_echo")]] });
    const connection = (await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!;
    await expect(post(connection.url, {})).resolves.toBe(401);
    await expect(post(connection.url, { authorization: "Bearer not-a-token" })).resolves.toBe(401);
    await expect(post(connection.url, { authorization: `Bearer ${connection.token}` })).resolves.toBe(200);

    mcp.revoke("thread-a");
    await expect(post(connection.url, { authorization: `Bearer ${connection.token}` })).resolves.toBe(401);
    // A new runtime for the thread gets a new credential; the old one stays dead.
    const again = (await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!;
    expect(again.token).not.toBe(connection.token);
    await expect(post(again.url, { authorization: `Bearer ${again.token}` })).resolves.toBe(200);
  });

  it("refuses a rebound host name and a browser origin even with a valid credential", async () => {
    const { mcp } = endpoint({ providers: [() => [echo("tau_echo")]] });
    const connection = (await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!;
    const authorization = `Bearer ${connection.token}`;
    await expect(post(connection.url, { authorization, host: "evil.example:80" })).resolves.toBe(403);
    await expect(post(connection.url, { authorization, origin: "https://evil.example" })).resolves.toBe(403);
  });

  it("keeps threads apart: a credential reaches only its own thread's tools", async () => {
    const seen: string[] = [];
    const { mcp } = endpoint({
      providers: [(thread) => {
        seen.push(thread.sessionId);
        return thread.sessionId === "thread-a" ? [echo("only_a", undefined, "a")] : [echo("only_b", undefined, "b")];
      }],
    });
    const a = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/a" }))!);
    const b = await connectClient((await mcp.connect({ sessionId: "thread-b", cwd: "/b" }))!);
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(["only_a"]);
    expect((await b.listTools()).tools.map((tool) => tool.name)).toEqual(["only_b"]);
    const crossed = await a.callTool({ name: "only_b", arguments: { text: "x" } });
    expect(crossed.isError).toBe(true);
    expect(text(crossed)).toContain('no tool "only_b"');
    expect(new Set(seen)).toEqual(new Set(["thread-a", "thread-b"]));
  });

  it("offers a thread started with a tool list only those tools", async () => {
    const runs: unknown[] = [];
    const { mcp } = endpoint({ providers: [() => [echo("tau_echo", (_thread, input) => runs.push(input)), echo("tau_other")]] });
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }, { tools: ["tau_echo", "read"] }))!);
    expect((await session.listTools()).tools.map((tool) => tool.name)).toEqual(["tau_echo"]);
    const refused = await session.callTool({ name: "tau_other", arguments: { text: "x" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('no tool "tau_other"');
    expect(text(await session.callTool({ name: "tau_echo", arguments: { text: "y" } }))).toContain("y");
    expect(runs).toEqual([{ text: "y" }]);
  });

  it("follows registration: a provider that leaves takes its tools along", async () => {
    const { mcp, providers } = endpoint();
    const provider: HostMcpToolProvider = () => [echo("tau_echo")];
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);
    expect((await session.listTools()).tools).toEqual([]);
    providers.add(provider);
    expect((await session.listTools()).tools.map((tool) => tool.name)).toEqual(["tau_echo"]);
    providers.delete(provider);
    expect((await session.listTools()).tools).toEqual([]);
  });

  it("validates arguments against the tool's schema the way Pi does", async () => {
    const runs: unknown[] = [];
    const { mcp } = endpoint({ providers: [() => [echo("tau_echo", (_thread, input) => runs.push(input))]] });
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);
    const result = await session.callTool({ name: "tau_echo", arguments: { other: 1 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Validation failed for tool "tau_echo"');
    expect(runs).toEqual([]);
  });

  it.each([undefined, NaN, Infinity, 1n, () => undefined, new Date(0), new Map()])("rejects non-JSON prepared arguments before gating or executing: %s", async (value) => {
    const run = vi.fn();
    const gate = vi.fn();
    const tool = { ...echo("tau_echo", run), prepareArguments: () => ({ text: "x", nested: [value] }) };
    const { mcp } = endpoint({ providers: [() => [tool]], gates: [gate] });
    const result = await mcp.call({ sessionId: "thread-a", cwd: "/project" }, "tau_echo", { text: "x" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("must be a JSON-compatible object");
    expect(gate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs every gate first: a block refuses the call, a confirm asks in the thread", async () => {
    const runs: unknown[] = [];
    const gate: HostMcpToolGate = async (call) => {
      if (call.toolName === "blocked") return { block: true, reason: "Blocked by Tau: read-only." };
      if (call.toolName === "asked" && !(await call.confirm(`Approve ${call.toolName}?`, JSON.stringify(call.input)))) {
        return { block: true, reason: "Blocked by Tau: not approved." };
      }
      return undefined;
    };
    let approve = false;
    const { mcp, questions } = endpoint({
      providers: [() => ["blocked", "asked", "free"].map((name) => echo(name, (_thread, input) => runs.push({ name, input })))],
      gates: [gate],
      confirm: () => approve,
    });
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);

    const blocked = await session.callTool({ name: "blocked", arguments: { text: "x" } });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toBe("Blocked by Tau: read-only.");

    const declined = await session.callTool({ name: "asked", arguments: { text: "y" } });
    expect(text(declined)).toBe("Blocked by Tau: not approved.");
    expect(questions).toEqual([{ threadId: "thread-a", title: "Approve asked?", message: '{"text":"y"}' }]);

    approve = true;
    expect(text(await session.callTool({ name: "asked", arguments: { text: "z" } }))).toBe(":z");
    expect(text(await session.callTool({ name: "free", arguments: { text: "w" } }))).toBe(":w");
    expect(runs).toEqual([{ name: "asked", input: { text: "z" } }, { name: "free", input: { text: "w" } }]);
  });

  it("fails closed when a gate throws", async () => {
    const runs: unknown[] = [];
    const { mcp } = endpoint({
      providers: [() => [echo("tau_echo", (_thread, input) => runs.push(input))]],
      gates: [() => { throw new Error("gate broke"); }],
    });
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);
    const result = await session.callTool({ name: "tau_echo", arguments: { text: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("gate broke");
    expect(runs).toEqual([]);
  });

  it("answers a thrown tool as an error result and passes images through", async () => {
    const failing: HostMcpTool = { ...echo("fails"), execute: async () => { throw new Error("page gone"); } };
    const picture: HostMcpTool = {
      ...echo("picture"),
      execute: async () => ({ content: [{ type: "text", text: "shot" }, { type: "image", data: "UE5H", mimeType: "image/png" }], details: undefined }),
    };
    const { mcp } = endpoint({ providers: [() => [failing, picture]] });
    const session = await connectClient((await mcp.connect({ sessionId: "thread-a", cwd: "/project" }))!);
    const failed = await session.callTool({ name: "fails", arguments: { text: "x" } });
    expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "page gone" }] });
    const shot = await session.callTool({ name: "picture", arguments: { text: "x" } });
    expect(shot.content).toEqual([{ type: "text", text: "shot" }, { type: "image", data: "UE5H", mimeType: "image/png" }]);
  });

  it("runs sequential tools of one thread one at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow: HostMcpTool = {
      ...echo("slow"),
      executionMode: "sequential",
      execute: async (_id, params: { text: string }) => {
        order.push(`start ${params.text}`);
        if (params.text === "first") await held;
        order.push(`end ${params.text}`);
        return { content: [{ type: "text", text: params.text }], details: undefined };
      },
    };
    const { mcp } = endpoint({ providers: [() => [slow]] });
    const thread = { sessionId: "thread-a", cwd: "/project" };
    const first = mcp.call(thread, "slow", { text: "first" });
    const second = mcp.call(thread, "slow", { text: "second" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["start first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("cancels a thread's calls in flight when its runtime closes", async () => {
    let seen: AbortSignal | undefined;
    const waiting: HostMcpTool = {
      ...echo("waits"),
      execute: (_id, _params, signal) => new Promise((_resolve, reject) => {
        seen = signal;
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    };
    const { mcp } = endpoint({ providers: [() => [waiting]] });
    await mcp.connect({ sessionId: "thread-a", cwd: "/project" });
    const call = mcp.call({ sessionId: "thread-a", cwd: "/project" }, "waits", { text: "x" });
    await new Promise((resolve) => setImmediate(resolve));
    mcp.revoke("thread-a");
    await expect(call).resolves.toMatchObject({ isError: true });
    expect(seen?.aborted).toBe(true);
  });

  it("serves nothing once closed", async () => {
    const { mcp } = endpoint();
    await mcp.close();
    await expect(mcp.connect({ sessionId: "thread-a", cwd: "/project" })).resolves.toBeUndefined();
  });
});
