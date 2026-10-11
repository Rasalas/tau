import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendPrompt, HostCommandError, HostExtensionContext, HostThreadLifecycle } from "tau/host-extension";
import { MCP_APP_COMMANDS } from "./mcp-app-protocol.js";
import { startMcpApps } from "./mcp-app-commands.js";
import type { McpAppThread } from "./mcp-apps.js";
import type { CodexSessionLike } from "./thread-backend.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const resource = { contents: [{ uri: "ui://fixture/a.html", mimeType: "text/html;profile=mcp-app", text: "<p>raw</p>", _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } } }] };

async function setup(options: { live?: boolean; frames?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-mcp-commands-"));
  directories.push(stateDir);
  const handlers = new Map<string, { run(input: unknown): unknown; options?: { access?: string } }>();
  const published: unknown[] = [];
  const released: string[] = [];
  const sent: unknown[][] = [];
  const asked: BackendPrompt[] = [];
  let lifecycle: HostThreadLifecycle | undefined;
  const session = {
    closed: false,
    listMcpTools: async () => ({ counter: { name: "counter", annotations: { readOnlyHint: true } } }),
    callMcpTool: async () => ({ content: [] }),
  } as unknown as CodexSessionLike;
  const thread: McpAppThread = { live: () => options.live === false ? undefined : { session, codexThreadId: "codex-1" }, ask: async (prompt) => { asked.push(prompt); return { value: "Allow" }; } };
  const context = {
    registerCommand: (name: string, run: (input: unknown) => unknown, commandOptions?: { access?: string }) => { handlers.set(name, { run, ...(commandOptions ? { options: commandOptions } : {}) }); return () => undefined; },
    services: {
      stateDir,
      log: () => undefined,
      sessions: { send: async (...args: unknown[]) => { sent.push(args); } },
      registerThreadLifecycle: (value: HostThreadLifecycle) => { lifecycle = value; return () => undefined; },
      ...(options.frames === false ? {} : { browserResources: { publishFrame: (document: unknown) => { published.push(document); return "/resources/abc"; }, release: (path: string) => { released.push(path); } } }),
    },
  } as unknown as Pick<HostExtensionContext, "registerCommand" | "services">;
  const hooks = startMcpApps(context, (id) => id === "t1" ? thread : undefined).forThread("t1");
  const call = (name: string, input: unknown) => Promise.resolve().then(() => handlers.get(name)!.run(input));
  const captured = async () => {
    hooks.onMcpApp({ itemId: "i1", server: "fixture", tool: "counter", resourceUri: "ui://fixture/a.html", arguments: { start: 1 } }, { codexThreadId: "codex-1", read: async () => resource });
    return call(MCP_APP_COMMANDS.open, { threadId: "t1", itemId: "i1", colorScheme: "dark" });
  };
  return { call, handlers, published, released, sent, asked, captured, stateDir, hooks, lifecycle: () => lifecycle! };
}

const rejects = async (promise: Promise<unknown>): Promise<string> => { try { await promise; } catch (error) { return (error as HostCommandError).message; } return "resolved"; };

describe("the app commands", () => {
  it("registers all seven, with only open and release open to a device that may only read", async () => {
    const { handlers } = await setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(MCP_APP_COMMANDS).sort());
    const readable = [...handlers].filter(([, entry]) => entry.options?.access === "read").map(([name]) => name).sort();
    expect(readable).toEqual([MCP_APP_COMMANDS.open, MCP_APP_COMMANDS.release].sort());
  });

  it("opens a captured app: publishes the raw document under its declared policy and returns the call", async () => {
    const { captured, published } = await setup();
    const opened = await captured();
    expect(published).toEqual([{ html: "<p>raw</p>", csp: { connectDomains: ["https://api.example.com"] }, colorScheme: "dark" }]);
    expect(opened).toMatchObject({ state: "ready", path: "/resources/abc", server: "fixture", tool: "counter", resourceUri: "ui://fixture/a.html", toolInput: { start: 1 }, live: true, toolDefinition: { name: "counter" } });
  });

  it("opens a stored app without a session", async () => {
    const { captured } = await setup({ live: false });
    expect(await captured()).toMatchObject({ state: "ready", live: false });
  });

  it("answers unavailable for an app never saved and publishes nothing", async () => {
    const { call, published } = await setup();
    expect(await call(MCP_APP_COMMANDS.open, { threadId: "t1", itemId: "none", colorScheme: "light" })).toEqual({ state: "unavailable", reason: "This app was not saved." });
    expect(published).toEqual([]);
  });

  it("releases a path it was given", async () => {
    const { call, released } = await setup();
    await call(MCP_APP_COMMANDS.release, { path: "/resources/abc" });
    await call(MCP_APP_COMMANDS.release, { path: 5 });
    expect(released).toEqual(["/resources/abc"]);
  });

  it("validates every input", async () => {
    const { call, captured } = await setup();
    await captured();
    const bad: Array<[string, unknown]> = [
      [MCP_APP_COMMANDS.open, null],
      [MCP_APP_COMMANDS.open, { threadId: "", itemId: "i1" }],
      [MCP_APP_COMMANDS.open, { threadId: "t1", itemId: "x".repeat(201) }],
      [MCP_APP_COMMANDS.open, { threadId: 1, itemId: "i1" }],
      [MCP_APP_COMMANDS.callTool, { threadId: "t1", itemId: "i1", name: "", arguments: {} }],
      [MCP_APP_COMMANDS.callTool, { threadId: "t1", itemId: "i1", name: "counter", arguments: [] }],
      [MCP_APP_COMMANDS.callTool, { threadId: "t1", itemId: "i1", name: "counter", arguments: { big: "x".repeat(256 * 1024) } }],
      [MCP_APP_COMMANDS.readResource, { threadId: "t1", itemId: "i1", uri: 5 }],
      [MCP_APP_COMMANDS.readResource, { threadId: "t1", itemId: "i1", uri: "" }],
      [MCP_APP_COMMANDS.sendMessage, { threadId: "t1", itemId: "i1", text: "" }],
      [MCP_APP_COMMANDS.sendMessage, { threadId: "t1", itemId: "i1", text: "x".repeat(256 * 1024 + 1) }],
      [MCP_APP_COMMANDS.approve, { threadId: "t1", itemId: "i1", kind: "upload", names: ["a"] }],
      [MCP_APP_COMMANDS.approve, { threadId: "t1", itemId: "i1", kind: "download", names: [] }],
      [MCP_APP_COMMANDS.approve, { threadId: "t1", itemId: "i1", kind: "download", names: [1] }],
      [MCP_APP_COMMANDS.modelContext, { threadId: "t1", itemId: "i1", content: "text" }],
      [MCP_APP_COMMANDS.modelContext, { threadId: "t1", itemId: "i1", structuredContent: [1] }],
    ];
    for (const [name, input] of bad) expect(await rejects(call(name, input)), `${name} ${JSON.stringify(input).slice(0, 60)}`).not.toBe("resolved");
  });

  it("sends an app's message through the session service as a prompt, after the question", async () => {
    const { call, captured, sent, asked } = await setup();
    await captured();
    await call(MCP_APP_COMMANDS.sendMessage, { threadId: "t1", itemId: "i1", text: "hello" });
    expect(asked).toHaveLength(1);
    expect(sent).toEqual([["t1", "hello", { delivery: "prompt" }]]);
  });

  it("refuses a call for a thread the host does not hold", async () => {
    const { call, captured } = await setup();
    await captured();
    expect(await rejects(call(MCP_APP_COMMANDS.callTool, { threadId: "t2", itemId: "i1", name: "counter", arguments: {} }))).toContain("no longer available");
  });

  it("forgets a thread's apps and contexts when the thread is deleted", async () => {
    const { captured, lifecycle, stateDir, call } = await setup();
    await captured();
    await call(MCP_APP_COMMANDS.modelContext, { threadId: "t1", itemId: "i1", content: [{ type: "text", text: "x" }] });
    expect(await readdir(join(stateDir, "mcp-apps"))).toHaveLength(1);
    await lifecycle().threadDeleted!("t1", "/repo");
    expect(await readdir(join(stateDir, "mcp-apps"))).toEqual([]);
    expect(await call(MCP_APP_COMMANDS.open, { threadId: "t1", itemId: "i1", colorScheme: "light" })).toMatchObject({ state: "unavailable" });
  });

  it("hands the backend the changed context once", async () => {
    const { hooks, captured, call } = await setup();
    await captured();
    await call(MCP_APP_COMMANDS.modelContext, { threadId: "t1", itemId: "i1", content: [{ type: "text", text: "count is 3" }] });
    const taken = await hooks.appContext();
    expect(taken?.text).toContain("count is 3");
    await taken!.commit();
    expect(await hooks.appContext()).toBeUndefined();
  });
});
