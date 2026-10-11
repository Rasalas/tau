// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCardProps, UiToolRun, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { codexExtension } from "./desktop.js";
import { createMcpAppCard } from "./mcp-app-card.js";
import { MCP_APP_COMMANDS, MCP_APP_EXTRA, MCP_APP_PROTOCOL_VERSION, type McpAppOpen } from "./mcp-app-protocol.js";

const REF = { server: "maps", tool: "show_map", resourceUri: "ui://maps/view" };

const tool = (overrides: Partial<UiToolRun> = {}): UiToolRun => ({
  id: "call1", name: "mcp__maps__show_map", args: { city: "Oslo" }, status: "done", startedAt: 1, output: "Map of Oslo",
  extras: { [MCP_APP_EXTRA]: REF }, ...overrides,
});

const ready = (path = "/resources/frame-1", extra: Partial<Extract<McpAppOpen, { state: "ready" }>> = {}): McpAppOpen => ({
  state: "ready", path, ...REF, toolInput: { city: "Oslo" }, toolResult: { content: [{ type: "text", text: "Map of Oslo" }] }, live: true, ...extra,
});

type Invoke = (command: string, input?: any) => Promise<unknown>;

function setup(invoke: Invoke, options: Parameters<typeof createMcpAppCard>[1] = {}, tools: UiToolRun[] = [tool()]) {
  const host = { invoke: vi.fn(invoke), onEvent: () => () => undefined, resourceUrl: (path: string) => `https://host.test${path}` };
  const actions = { activeThread: () => ({ sessionId: "thread-1", draftPending: false }), openExternal: vi.fn() } as unknown as WorkbenchActions;
  const Card = createMcpAppCard(host, options);
  const props = (next: UiToolRun[]): ToolCardProps => ({ tools: next, actions });
  const view = render(<Card {...props(tools)} />);
  return { host, actions, view, rerender: (next: UiToolRun[]) => view.rerender(<Card {...props(next)} />) };
}

const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const waitForFrame = async () => { await waitFor(() => expect(frame()).not.toBeNull()); return frame()!; };

/** Drives the app's side of the bridge through the frame's window, as a real document would. */
function appOf(iframe: HTMLIFrameElement) {
  const target = iframe.contentWindow!;
  const post = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
  const posted = () => post.mock.calls.map((call) => call[0] as any);
  const send = (data: unknown, source: MessageEventSource | null = target) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source })); });
  const request = (id: string, method: string, params: unknown) => send({ jsonrpc: "2.0", id, method, params });
  const answer = async (id: string) => {
    await waitFor(() => expect(posted().some((message) => message.id === id && message.method === undefined)).toBe(true));
    return posted().find((message) => message.id === id && message.method === undefined);
  };
  const start = async (appCapabilities: unknown = { availableDisplayModes: ["inline", "fullscreen"] }) => {
    request("init", "ui/initialize", { protocolVersion: MCP_APP_PROTOCOL_VERSION, appInfo: { name: "app", version: "1" }, appCapabilities });
    await answer("init");
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  };
  return { post, posted, send, request, answer, start };
}

const okHost = (extra: Record<string, (input: any) => unknown> = {}): Invoke => async (command, input) => {
  if (extra[command]) return extra[command]!(input);
  if (command === MCP_APP_COMMANDS.open) return ready();
  return undefined;
};

beforeEach(() => { document.documentElement.dataset.theme = "light"; });
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  delete (HTMLElement.prototype as any).popover;
  delete (HTMLElement.prototype as any).showPopover;
  delete (HTMLElement.prototype as any).hidePopover;
  delete (navigator as any).userActivation;
});

describe("MCP App card registration", () => {
  it("claims a tool run that carries an app, and no other", () => {
    const { registry } = createKitHarness();
    registry.activate(codexExtension);
    expect(registry.toolCardFor(tool())?.id).toBe("codex.mcp-app");
    expect(registry.toolCardFor(tool({ extras: undefined }))).toBeUndefined();
    expect(registry.toolCardFor(tool({ extras: { other: 1 } }))).toBeUndefined();
    registry.deactivate(codexExtension.id);
    expect(registry.toolCardFor(tool())).toBeUndefined();
  });
});

describe("MCP App card", () => {
  it("asks the host to open the app for the thread on screen and draws it in a frame without allow-same-origin", async () => {
    const { host } = setup(okHost());
    const iframe = await waitForFrame();
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.open, { threadId: "thread-1", itemId: "call1", colorScheme: "light" });
    expect(iframe.getAttribute("src")).toBe("https://host.test/resources/frame-1");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(screen.getByText("maps")).toBeTruthy();
    expect(screen.getByText("show_map")).toBeTruthy();
  });

  it("answers the handshake and sends the call once the app is initialized", async () => {
    setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    const init = await app.answer("init");
    expect(init.result.hostInfo.name).toBe("tau");
    expect(init.result.hostContext).toMatchObject({ theme: "light", displayMode: "inline", platform: "desktop", availableDisplayModes: ["inline"] });
    expect(init.result.hostContext.toolInfo).toBeUndefined();
    await waitFor(() => expect(app.posted().filter((message) => message.method?.startsWith("ui/notifications/tool-")).map((message) => message.method)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]));
    expect(app.posted().find((message) => message.method === "ui/notifications/tool-input").params).toEqual({ arguments: { city: "Oslo" } });
  });

  it("ignores a message that a window other than the frame posted", async () => {
    const { host } = setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    const before = app.posted().length;
    app.send({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "t" } }, window);
    app.send({ jsonrpc: "2.0", id: "y", method: "tools/call", params: { name: "t" } }, null);
    app.send({ jsonrpc: "2.0", id: "z", method: "tools/call", params: { name: "t" } }, document.createElement("iframe").contentWindow);
    // Messages are handled synchronously inside act(), so nothing is pending here.
    expect(app.posted()).toHaveLength(before);
    expect(host.invoke).not.toHaveBeenCalledWith(MCP_APP_COMMANDS.callTool, expect.anything());
  });

  it("forwards the app's requests to the host commands and returns failures as protocol errors", async () => {
    const { host } = setup(okHost({
      [MCP_APP_COMMANDS.callTool]: (input) => input.name === "down" ? Promise.reject(new Error("session not running")) : { content: [{ type: "text", text: "tiles" }], structuredContent: null },
      [MCP_APP_COMMANDS.readResource]: () => ({ contents: [{ uri: "ui://maps/x", text: "x" }] }),
      [MCP_APP_COMMANDS.modelContext]: () => undefined,
    }));
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("a", "tools/call", { name: "tiles", arguments: { z: 3 } });
    expect((await app.answer("a")).result).toEqual({ content: [{ type: "text", text: "tiles" }] });
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.callTool, { threadId: "thread-1", itemId: "call1", name: "tiles", arguments: { z: 3 } });
    app.request("b", "tools/call", { name: "down" });
    expect((await app.answer("b")).error).toEqual({ code: -32000, message: "session not running" });
    app.request("c", "resources/read", { uri: "ui://maps/x" });
    expect((await app.answer("c")).result.contents).toHaveLength(1);
    app.request("d", "ui/update-model-context", { structuredContent: { zoom: 3 } });
    await app.answer("d");
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.modelContext, { threadId: "thread-1", itemId: "call1", structuredContent: { zoom: 3 } });
  });

  it("passes the user's decline on a message to the app as an error", async () => {
    setup(okHost({ [MCP_APP_COMMANDS.sendMessage]: () => Promise.reject(new Error("Declined by the user.")) }));
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("m", "ui/message", { role: "user", content: [{ type: "text", text: "hello" }] });
    expect((await app.answer("m")).error).toEqual({ code: -32000, message: "Declined by the user." });
  });

  it("sets the frame's height from the app's report", async () => {
    setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    app.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420, width: 300 } });
    await waitFor(() => expect((document.querySelector(".sandbox-frame") as HTMLElement).style.height).toBe("420px"));
  });

  it("follows the workbench's colour scheme", async () => {
    setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    act(() => { document.documentElement.dataset.theme = "dark"; });
    await waitFor(() => expect(app.posted().some((message) => message.method === "ui/notifications/host-context-changed" && message.params.theme === "dark")).toBe(true));
  });

  it("refuses a link without a live click in the app, and opens one with it", async () => {
    const { actions } = setup(okHost());
    const iframe = await waitForFrame();
    const app = appOf(iframe);
    await app.start();
    app.request("l1", "ui/open-link", { url: "https://example.test/page" });
    expect((await app.answer("l1")).error).toEqual({ code: -32000, message: "Links open only from a click in the app." });
    expect(actions.openExternal).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    act(() => { iframe.tabIndex = 0; iframe.focus(); });
    app.request("l2", "ui/open-link", { url: "https://example.test/page" });
    expect((await app.answer("l2")).error).toBeUndefined();
    expect(actions.openExternal).toHaveBeenCalledWith("https://example.test/page");
  });

  it("releases the frame resource and stops the bridge when it unmounts", async () => {
    const { host, view } = setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    view.unmount();
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.release, { threadId: "thread-1", itemId: "call1", path: "/resources/frame-1" }));
    const before = app.posted().length;
    app.request("late", "ping", {});
    expect(app.posted()).toHaveLength(before);
  });
});

describe("MCP App card states", () => {
  it("gives the frame back when the card goes before the host answered", async () => {
    let answer: (open: McpAppOpen) => void = () => undefined;
    const { host, view } = setup(okHost({ [MCP_APP_COMMANDS.open]: () => new Promise((resolve) => { answer = resolve; }) }));
    view.unmount();
    answer(ready("/resources/late"));
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.release, { threadId: "thread-1", itemId: "call1", path: "/resources/late" }));
  });

  it("shows the stopped notice when the document navigates away", async () => {
    setup(okHost());
    const iframe = await waitForFrame();
    fireEvent.load(iframe);
    fireEvent.load(iframe);
    expect(await screen.findByText("This page left its document and was stopped")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("shows the reason and the tool's output when the app is unavailable", async () => {
    setup(okHost({ [MCP_APP_COMMANDS.open]: () => ({ state: "unavailable", reason: "The server did not send the app." }) satisfies McpAppOpen }));
    expect(await screen.findByText("The server did not send the app.")).toBeTruthy();
    expect(screen.getByText("Map of Oslo")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("shows the host's error as the reason", async () => {
    setup(okHost({ [MCP_APP_COMMANDS.open]: () => Promise.reject(new Error("Thread not found.")) }));
    expect(await screen.findByText("Thread not found.")).toBeTruthy();
  });

  it("keeps the tool's summary and output while it runs or after it failed, and asks for no app", () => {
    const running = setup(okHost(), {}, [tool({ status: "running", output: "working…" })]);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("working…")).toBeTruthy();
    expect(running.host.invoke).not.toHaveBeenCalled();
    cleanup();
    const failed = setup(okHost(), {}, [tool({ status: "error", output: "boom" })]);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(failed.host.invoke).not.toHaveBeenCalled();
  });

  it("opens the app once the running call finishes", async () => {
    const { host, rerender } = setup(okHost(), {}, [tool({ status: "running" })]);
    expect(host.invoke).not.toHaveBeenCalled();
    rerender([tool({ status: "done" })]);
    await waitForFrame();
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.open, expect.anything());
  });

  it("asks again while the host reads the document, then gives up", async () => {
    let asked = 0;
    const { host } = setup(okHost({ [MCP_APP_COMMANDS.open]: () => (++asked < 3 ? { state: "pending" } : ready()) }), { retryDelays: [1, 1, 1] });
    await waitForFrame();
    expect(host.invoke.mock.calls.filter(([command]) => command === MCP_APP_COMMANDS.open)).toHaveLength(3);
    cleanup();
    setup(okHost({ [MCP_APP_COMMANDS.open]: () => ({ state: "pending" }) satisfies McpAppOpen }), { retryDelays: [1, 1] });
    expect(await screen.findByText("The app is not ready yet.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("needs a thread on screen", async () => {
    const host = { invoke: vi.fn(okHost()), onEvent: () => () => undefined, resourceUrl: (path: string) => path };
    const Card = createMcpAppCard(host);
    render(<Card tools={[tool()]} actions={{ activeThread: () => undefined } as unknown as WorkbenchActions} />);
    expect(await screen.findByText("Open the thread to see the app.")).toBeTruthy();
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("says so when the client cannot resolve resources, and gives the resource back", async () => {
    const host = { invoke: vi.fn(okHost()), onEvent: () => () => undefined };
    const Card = createMcpAppCard(host);
    render(<Card tools={[tool()]} actions={{ activeThread: () => ({ sessionId: "thread-1" }) } as unknown as WorkbenchActions} />);
    expect(await screen.findByText("This client cannot show apps.")).toBeTruthy();
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.release, { threadId: "thread-1", itemId: "call1", path: "/resources/frame-1" });
  });
});

describe("MCP App card close and reopen", () => {
  it("tears the app down on its request and shows it again with a new open", async () => {
    const paths = ["/resources/frame-1", "/resources/frame-2"];
    const { host } = setup(okHost({ [MCP_APP_COMMANDS.open]: () => ready(paths.shift()) }));
    const first = await waitForFrame();
    const app = appOf(first);
    await app.start();
    app.send({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    await waitFor(() => expect(app.posted().some((message) => message.method === "ui/resource-teardown")).toBe(true));
    app.send({ jsonrpc: "2.0", id: app.posted().find((message) => message.method === "ui/resource-teardown").id, result: {} });
    expect(await screen.findByText("The maps app was closed")).toBeTruthy();
    expect(frame()).toBeNull();
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.release, { threadId: "thread-1", itemId: "call1", path: "/resources/frame-1" });
    fireEvent.click(screen.getByRole("button", { name: "Show app" }));
    const second = await waitFor(() => { const next = frame(); expect(next).not.toBeNull(); return next!; });
    expect(second.getAttribute("src")).toBe("https://host.test/resources/frame-2");
    expect(host.invoke.mock.calls.filter(([command]) => command === MCP_APP_COMMANDS.open)).toHaveLength(2);
  });

  it("closes after the teardown timeout when the app does not answer", async () => {
    const { host } = setup(okHost(), { teardownTimeoutMs: 10 });
    const app = appOf(await waitForFrame());
    await app.start();
    app.send({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    expect(await screen.findByText("The maps app was closed")).toBeTruthy();
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.release, expect.anything());
  });
});

describe("MCP App card full screen", () => {
  const withPopover = () => {
    Object.assign(HTMLElement.prototype, { popover: "", showPopover: vi.fn(), hidePopover: vi.fn() });
  };
  const fullscreenOn = () => document.querySelector("[data-sandbox-frame-fullscreen]") !== null;

  it("offers full screen only where the browser has popovers", async () => {
    setup(okHost());
    const app = appOf(await waitForFrame());
    await app.start();
    expect((await app.answer("init")).result.hostContext.availableDisplayModes).toEqual(["inline"]);
    app.request("fs", "ui/request-display-mode", { mode: "fullscreen" });
    expect((await app.answer("fs")).result).toEqual({ mode: "inline" });
  });

  it("goes full screen on request, and steps back inline before it raises a prompt card", async () => {
    withPopover();
    const seen: boolean[] = [];
    setup(okHost({ [MCP_APP_COMMANDS.sendMessage]: () => { seen.push(fullscreenOn()); } }));
    const app = appOf(await waitForFrame());
    await app.start();
    expect((await app.answer("init")).result.hostContext.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    app.request("fs", "ui/request-display-mode", { mode: "fullscreen" });
    expect((await app.answer("fs")).result).toEqual({ mode: "fullscreen" });
    await waitFor(() => expect(fullscreenOn()).toBe(true));
    await waitFor(() => expect(app.posted().some((message) => message.method === "ui/notifications/host-context-changed" && message.params.displayMode === "fullscreen")).toBe(true));
    app.request("m", "ui/message", { role: "user", content: [{ type: "text", text: "hi" }] });
    await app.answer("m");
    expect(seen).toEqual([false]);
    await waitFor(() => expect(app.posted().some((message) => message.method === "ui/notifications/host-context-changed" && message.params.displayMode === "inline")).toBe(true));
  });

  it("steps back inline before the approval of a download and refuses full screen while it waits", async () => {
    withPopover();
    const seen: boolean[] = [];
    let decide: (answer: boolean) => void = () => undefined;
    setup(okHost({ [MCP_APP_COMMANDS.approve]: () => { seen.push(fullscreenOn()); return new Promise((resolve) => { decide = resolve; }); } }));
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("fs", "ui/request-display-mode", { mode: "fullscreen" });
    await app.answer("fs");
    await waitFor(() => expect(fullscreenOn()).toBe(true));
    app.request("dl", "ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///r.csv", text: "a" } }] });
    await waitFor(() => expect(seen).toEqual([false]));
    app.request("fs2", "ui/request-display-mode", { mode: "fullscreen" });
    expect((await app.answer("fs2")).result).toEqual({ mode: "inline" });
    decide(false);
    expect((await app.answer("dl")).result).toEqual({ isError: true });
    expect(fullscreenOn()).toBe(false);
  });

  it("steps back inline when a tool call stays unanswered, as a prompt card would hold it", async () => {
    withPopover();
    let finish: () => void = () => undefined;
    setup(okHost({ [MCP_APP_COMMANDS.callTool]: () => new Promise((resolve) => { finish = () => resolve({ content: [] }); }) }), { promptGraceMs: 5 });
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("fs", "ui/request-display-mode", { mode: "fullscreen" });
    await app.answer("fs");
    await waitFor(() => expect(fullscreenOn()).toBe(true));
    app.request("c", "tools/call", { name: "write_file", arguments: {} });
    await waitFor(() => expect(fullscreenOn()).toBe(false));
    finish();
    await app.answer("c");
  });

  it("stays in full screen for a call that comes back at once", async () => {
    withPopover();
    setup(okHost({ [MCP_APP_COMMANDS.callTool]: () => ({ content: [] }) }), { promptGraceMs: 10_000 });
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("fs", "ui/request-display-mode", { mode: "fullscreen" });
    await app.answer("fs");
    await waitFor(() => expect(fullscreenOn()).toBe(true));
    app.request("c", "tools/call", { name: "tiles" });
    await app.answer("c");
    expect(fullscreenOn()).toBe(true);
  });
});

describe("MCP App card downloads", () => {
  it("saves an embedded file and a linked one after the user agreed", async () => {
    const saved: Array<{ name: string; href: string }> = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:tau-test"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push({ name: this.download, href: this.href }); });
    const { host } = setup(okHost({
      [MCP_APP_COMMANDS.approve]: () => ({ allowed: true }),
      [MCP_APP_COMMANDS.readResource]: () => ({ contents: [{ uri: "ui://maps/export", mimeType: "text/csv", text: "a,b" }] }),
    }));
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("dl", "ui/download-file", { contents: [
      { type: "resource", resource: { uri: "file:///tmp/report.txt", text: "hello" } },
      { type: "resource_link", uri: "ui://maps/export", name: "export.csv" },
    ] });
    expect((await app.answer("dl")).result).toEqual({});
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.approve, { threadId: "thread-1", itemId: "call1", kind: "download", names: ["report.txt", "export.csv"] });
    expect(host.invoke).toHaveBeenCalledWith(MCP_APP_COMMANDS.readResource, { threadId: "thread-1", itemId: "call1", uri: "ui://maps/export" });
    expect(saved).toEqual([{ name: "report.txt", href: "blob:tau-test" }, { name: "export.csv", href: "blob:tau-test" }]);
    click.mockRestore();
  });

  it("saves nothing when the user declined", async () => {
    const create = vi.fn(() => "blob:tau-test");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    setup(okHost({ [MCP_APP_COMMANDS.approve]: () => false }));
    const app = appOf(await waitForFrame());
    await app.start();
    app.request("dl", "ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///r.txt", text: "x" } }] });
    expect((await app.answer("dl")).result).toEqual({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });
});
