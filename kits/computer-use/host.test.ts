import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit, kitMcpEndpoint } from "../../src/main/test-support/host-kit-harness.js";
import { createComputerUseHostExtension, settingsIncludeComputerUse } from "./host.js";
import { COMPUTER_USE_EXTENSION_ID, COMPUTER_USE_PACKAGE } from "./protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(allow: boolean | (() => Promise<boolean>) = true, loadingDelay?: Promise<void>) {
  const calls: { client: number; name: string; args: unknown }[] = [];
  const closed: number[] = [];
  let clients = 0;
  const confirm = vi.fn(() => typeof allow === "function" ? allow() : allow);
  const endpoint = kitMcpEndpoint(confirm);
  cleanups.push(() => endpoint.close());
  const contributions: RuntimeExtensionContribution[] = [];
  const callClient = vi.fn(async () => undefined);
  let closeThread: ((id: string) => Promise<void>) | undefined;
  const load = vi.fn(async () => { await loadingDelay; return ({
    resolveDriverLayout: () => ({ appPath: join(dirname(createRequire(import.meta.url).resolve("@amaster.ai/pi-computer-use/package.json")), "bin/darwin-universal/CuaDriver.app") }),
    resolveConfig: () => ({ confirmAppLaunch: true, confirmDangerousActions: true }),
    loadConfigFromFile: () => ({}),
    CuaDriverClient: class {
      private readonly id = ++clients;
      async listAllTools() { return [{ name: "get_window_state", inputSchema: { type: "object" } }, { name: "launch_app", inputSchema: { type: "object" } }, { name: "click", inputSchema: { type: "object" } }]; }
      async callTool(name: string, args: unknown) {
        calls.push({ client: this.id, name, args });
        const shot = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(shot); shot.writeUInt32BE(64, 16); shot.writeUInt32BE(48, 20);
        return { content: name === "get_window_state" ? [{ type: "image", data: shot.toString("base64"), mimeType: "image/png" }] : [{ type: "text", text: "ok" }], structuredContent: {} };
      }
      async close() { closed.push(this.id); }
    },
  }); });
  const registry = await activateHostKit(createComputerUseHostExtension(), { callClient: callClient as never, registerTurnObserver: (observer) => { closeThread = observer.closed; return () => undefined; }, mcp: endpoint.mcp, loadDependency: load, registerRuntimeExtension: (name, factory, options) => { contributions.push({ name, factory, ...options }); return () => undefined; } });
  cleanups.push(async () => { await registry.deactivate(COMPUTER_USE_EXTENSION_ID); });
  const connect = async (sessionId: string, nativeCapabilities?: string[]) => {
    const connection = await endpoint.mcp.connect({ sessionId, cwd: "/project", nativeCapabilities });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(connection!.url), { requestInit: { headers: connection!.headers } }));
    cleanups.push(() => client.close()); return client;
  };
  return { activeClients: () => clients - closed.length, registry, callClient, closeThread: async (id: string) => { await closeThread?.(id); }, connect, calls, confirm, load, contributions, closed, invoke: (command: string, input?: unknown) => registry.invoke(COMPUTER_USE_EXTENSION_ID, command, input) };
}
describe("Computer Use host", () => {
  it("keeps activation lazy and honors an explicitly installed Pi package", async () => {
    const { load, contributions } = await setup();
    expect(load).not.toHaveBeenCalled();
    expect(contributions[0]!.enabledFor!({ global: { packages: [`npm:${COMPUTER_USE_PACKAGE}`] }, project: {} })).toBe(false);
    expect(settingsIncludeComputerUse({ packages: [{ source: `npm:${COMPUTER_USE_PACKAGE}@0.1.12` }] })).toBe(true);
  });
  it("suppresses fallback for native computer use without loading the package", async () => {
    const { connect, load } = await setup();
    const native = await connect("native", ["computer-use"]);
    expect((await native.listTools()).tools).toEqual([]); expect(load).not.toHaveBeenCalled();
  });
  it("serves real MCP screenshots, thread feeds and isolated driver sessions", async () => {
    const { connect, calls, invoke, load } = await setup();
    const a = await connect("a"), b = await connect("b");
    expect((await a.listTools()).tools.some((tool) => tool.name === "computer_use_get_window_state")).toBe(true);
    const result = await a.callTool({ name: "computer_use_get_window_state", arguments: { pid: 7, window_id: 3 } });
    expect(load).toHaveBeenCalledWith(COMPUTER_USE_PACKAGE, { namespace: true });
    expect(result.content).toContainEqual(expect.objectContaining({ type: "image" }));
    expect(await invoke("screen-state", { threadId: "a" })).toMatchObject({ window: { pid: 7, windowId: 3 }, frame: { width: 64, height: 48 } });
    expect(await invoke("screen-state", { threadId: "b" })).toBeNull();
    await invoke("screen-input", { threadId: "a", input: { kind: "click", x: 0.5, y: 0.5 } });
    expect(calls).toContainEqual(expect.objectContaining({ name: "click", args: { pid: 7, window_id: 3, x: 32, y: 24 } }));
    await b.callTool({ name: "computer_use_click", arguments: { pid: 8, x: 1, y: 2 } });
    expect(new Set(calls.filter((call) => call.name !== "check_permissions").map((call) => call.client)).size).toBe(2);
  });
  it("denies required confirmation before invoking the driver", async () => {
    const { connect, calls, confirm } = await setup(false);
    const client = await connect("denied");
    const result = await client.callTool({ name: "computer_use_launch_app", arguments: { bundle_id: "com.apple.Safari" } });
    expect(result.isError).toBe(true); expect(confirm).toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it("shares the Pi and MCP driver for a thread and rejects stale Pi tools after close", async () => {
    const { contributions, connect, calls, closeThread } = await setup();
    const registered: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const handlers = new Map<string, () => Promise<void>>();
    await contributions[0]!.factory({ registerTool: (tool: typeof registered[number]) => registered.push(tool), on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) } as never, { sessionId: "shared", cwd: "/project" });
    const client = await connect("shared");
    await client.callTool({ name: "computer_use_get_window_state", arguments: { pid: 7 } });
    const tool = registered.find((item) => item.name === "computer_use_click")!;
    await tool.execute("pi-call", { pid: 7, x: 1, y: 2 }, undefined, undefined, { hasUI: false });
    expect(new Set(calls.map((call) => call.client)).size).toBe(1);
    await closeThread("shared");
    expect(() => tool.execute("stale", { pid: 7 }, undefined, undefined, undefined)).toThrow(/closed/u);
  });
  it("cancels a pending approval when its thread closes", async () => {
    const { connect, calls, closeThread, confirm } = await setup(() => new Promise(() => undefined));
    const client = await connect("closing");
    const pending = client.callTool({ name: "computer_use_launch_app", arguments: { bundle_id: "com.apple.Safari" } });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    await closeThread("closing");
    expect((await pending).isError).toBe(true); expect(calls).toEqual([]);
  });

  it("lets read-only devices see state and refuses their input", async () => {
    const { connect, registry, calls } = await setup();
    const client = await connect("device");
    await client.callTool({ name: "computer_use_get_window_state", arguments: { pid: 7, window_id: 3 } });
    const readOnly = { kind: "workbench-client", connection: "phone", pairedClient: "c1", readOnly: true } as const;
    await expect(registry.invoke(COMPUTER_USE_EXTENSION_ID, "screen-state", { threadId: "device" }, readOnly)).resolves.toMatchObject({ threadId: "device" });
    const before = calls.length;
    await expect(registry.invoke(COMPUTER_USE_EXTENSION_ID, "screen-input", { threadId: "device", input: { kind: "key", key: "Enter" } }, readOnly)).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });
  it("pins live capture to the feed target on the host window", async () => {
    const { connect, invoke, callClient } = await setup();
    const client = await connect("live");
    await expect(invoke("screen-live-start", { threadId: "live" })).rejects.toThrow(/drives no window/u);
    await client.callTool({ name: "computer_use_get_window_state", arguments: { pid: 7, window_id: 3 } });
    await invoke("screen-live-start", { threadId: "live", window_id: 999, windowId: 999 });
    expect(callClient).toHaveBeenLastCalledWith(COMPUTER_USE_EXTENSION_ID, "live-start", { windowId: 3 }, { window: "host" });
  });
  it("raises the feed window through the same thread driver", async () => {
    const { connect, invoke, calls } = await setup();
    const client = await connect("front");
    await expect(invoke("screen-front", { threadId: "front" })).rejects.toThrow(/drives no window/u);
    await client.callTool({ name: "computer_use_get_window_state", arguments: { pid: 7, window_id: 3 } });
    await invoke("screen-front", { threadId: "front" });
    const screenshot = calls.find((call) => call.name === "get_window_state")!;
    expect(calls.at(-1)).toEqual({ client: screenshot.client, name: "bring_to_front", args: { pid: 7, window_id: 3 } });
  });

  it("closes a thread that closes during lazy dependency loading", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const { connect, closeThread, load, activeClients } = await setup(true, loading);
    const client = await connect("loading");
    const listing = client.listTools();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    const closing = closeThread("loading");
    release();
    await closing;
    await listing;
    expect(activeClients()).toBe(0);
    } finally { Object.defineProperty(process, "platform", platform); }
  });

});
