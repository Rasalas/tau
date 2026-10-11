import { describe, expect, it, vi } from "vitest";
import { BridgeRefusal, makeMcpAppBridge, normalizeToolResult, safeFileName, type HostContext, type McpAppBridgeOptions } from "./mcp-app-bridge.js";
import { MCP_APP_LIMITS, MCP_APP_PROTOCOL_VERSION } from "./mcp-app-protocol.js";

interface Sent { id?: number | string; method?: string; result?: any; error?: { code: number; message: string }; params?: any }

function setup(overrides: Partial<McpAppBridgeOptions> = {}, initialContext: HostContext = { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] }) {
  const sent: Sent[] = [];
  const context = { value: initialContext };
  const mocks = {
    post: (message: unknown) => { sent.push(message as Sent); },
    hostContext: () => context.value,
    version: "1.2.3",
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null })),
    readResource: vi.fn(async () => ({ contents: [{ uri: "ui://x", text: "hi" }] })),
    openLink: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    updateModelContext: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => undefined),
    requestDisplayMode: vi.fn(async (mode) => mode),
    onSizeChanged: vi.fn(),
    onRequestTeardown: vi.fn(),
  };
  // The overrides that matter to a test are mocks too.
  const options = { ...mocks, ...overrides } as typeof mocks;
  const bridge = makeMcpAppBridge(options);
  const request = (id: number | string, method: string, params?: unknown) => bridge.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  const notification = (method: string, params?: unknown) => bridge.receive({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  const answerOf = async (id: number | string) => {
    await vi.waitFor(() => expect(sent.some((entry) => entry.id === id)).toBe(true), { interval: 1 });
    return sent.find((entry) => entry.id === id)!;
  };
  const start = async (appCapabilities: unknown = { availableDisplayModes: ["inline", "fullscreen"] }) => {
    request("init", "ui/initialize", { protocolVersion: MCP_APP_PROTOCOL_VERSION, appInfo: { name: "app", version: "1" }, appCapabilities });
    await answerOf("init");
    notification("ui/notifications/initialized");
  };
  return { bridge, options, sent, context, request, notification, answerOf, start };
}

describe("MCP App bridge handshake", () => {
  it("answers ui/initialize with the host's identity, capabilities and context", async () => {
    const { request, answerOf, options } = setup({ sandbox: { csp: { connectDomains: ["https://a.test"] }, permissions: { camera: {} } } });
    request(1, "ui/initialize", { protocolVersion: "2025-01-01", appInfo: { name: "app", version: "1" }, appCapabilities: {} });
    const answer = await answerOf(1);
    expect(answer.result).toEqual({
      protocolVersion: MCP_APP_PROTOCOL_VERSION,
      hostInfo: { name: "tau", version: "1.2.3" },
      hostCapabilities: {
        openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: {} },
        updateModelContext: { text: {}, structuredContent: {} }, downloadFile: {},
        sandbox: { csp: { connectDomains: ["https://a.test"] }, permissions: { camera: {} } },
      },
      hostContext: options.hostContext(),
    });
  });

  it.each([
    ["call first", ["call", "init", "initialized"]],
    ["initialized first", ["init", "initialized", "call"]],
  ])("sends tool-input and tool-result once, %s", async (_name, order) => {
    const { bridge, request, notification, answerOf, sent } = setup();
    for (const step of order) {
      if (step === "call") bridge.setToolCall({ arguments: { q: 1 }, result: { content: [{ type: "text", text: "r" }], structuredContent: null } });
      if (step === "init") { request("i", "ui/initialize", { protocolVersion: "x" }); await answerOf("i"); }
      if (step === "initialized") notification("ui/notifications/initialized");
    }
    notification("ui/notifications/initialized");
    bridge.setToolCall({ arguments: { q: 1 }, result: { content: [] } });
    const methods = sent.filter((entry) => entry.method).map((entry) => entry.method);
    expect(methods).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    expect(sent.find((entry) => entry.method === "ui/notifications/tool-input")?.params).toEqual({ arguments: { q: 1 } });
    expect(sent.find((entry) => entry.method === "ui/notifications/tool-result")?.params).toEqual({ content: [{ type: "text", text: "r" }] });
  });

  it("sends nothing of the call before the app said it is initialized", async () => {
    const { bridge, request, answerOf, sent } = setup();
    bridge.setToolCall({ arguments: {}, result: { content: [] } });
    request(1, "ui/initialize", { protocolVersion: "x" });
    await answerOf(1);
    expect(sent.filter((entry) => entry.method)).toEqual([]);
  });

  it("refuses everything but ping and ui/initialize before ui/initialize", async () => {
    const { request, answerOf, options } = setup();
    request(1, "ping");
    request(2, "tools/call", { name: "t" });
    expect((await answerOf(1)).result).toEqual({});
    expect((await answerOf(2)).error?.code).toBe(-32600);
    expect(options.callTool).not.toHaveBeenCalled();
  });

  it("sends only changed host-context fields, and only after initialized", async () => {
    const { bridge, context, notification, request, answerOf, sent } = setup();
    request("i", "ui/initialize", { protocolVersion: "x" });
    await answerOf("i");
    context.value = { ...context.value, theme: "dark" };
    bridge.updateHostContext();
    expect(sent.filter((entry) => entry.method)).toEqual([]);
    notification("ui/notifications/initialized");
    // The change made before initialized goes out when it is.
    expect(sent.filter((entry) => entry.method === "ui/notifications/host-context-changed").map((entry) => entry.params)).toEqual([{ theme: "dark" }]);
    bridge.updateHostContext();
    context.value = { ...context.value, containerDimensions: { maxHeight: 400 } };
    bridge.updateHostContext();
    bridge.updateHostContext();
    expect(sent.filter((entry) => entry.method === "ui/notifications/host-context-changed").map((entry) => entry.params)).toEqual([{ theme: "dark" }, { containerDimensions: { maxHeight: 400 } }]);
  });
});

describe("MCP App bridge methods", () => {
  it("answers ping", async () => {
    const { start, request, answerOf } = setup();
    await start();
    request(1, "ping");
    expect((await answerOf(1)).result).toEqual({});
  });

  it.each([
    ["tools/call", { name: "t", arguments: { a: 1 } }, undefined],
    ["tools/call", { name: "t" }, undefined],
    ["tools/call", { name: "" }, -32602],
    ["tools/call", { name: "t", arguments: [] }, -32602],
    ["tools/call", { name: "t", arguments: null }, -32602],
    ["tools/call", { name: 3 }, -32602],
    ["resources/read", { uri: "ui://a" }, undefined],
    ["resources/read", { uri: "" }, -32602],
    ["resources/read", {}, -32602],
    ["ui/open-link", { url: "https://example.test/x" }, undefined],
    ["ui/open-link", { url: "http://example.test" }, undefined],
    ["ui/open-link", { url: "javascript:alert(1)" }, -32602],
    ["ui/open-link", { url: "file:///etc/passwd" }, -32602],
    ["ui/open-link", { url: "not a url" }, -32602],
    ["ui/open-link", {}, -32602],
    ["ui/message", { role: "user", content: [{ type: "text", text: "hi" }] }, undefined],
    ["ui/message", { role: "user", content: { type: "text", text: "hi" } }, undefined],
    ["ui/message", { role: "assistant", content: [{ type: "text", text: "hi" }] }, -32602],
    ["ui/message", { role: "user", content: [] }, -32602],
    ["ui/message", { role: "user", content: [{ type: "text", text: "  " }] }, -32602],
    ["ui/message", { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }, -32602],
    ["ui/update-model-context", { content: [{ type: "text", text: "c" }] }, undefined],
    ["ui/update-model-context", { structuredContent: { a: 1 } }, undefined],
    ["ui/update-model-context", {}, undefined],
    ["ui/update-model-context", { content: "no" }, -32602],
    ["ui/update-model-context", { structuredContent: [] }, -32602],
    ["ui/update-model-context", { structuredContent: null }, -32602],
    ["ui/request-display-mode", { mode: "fullscreen" }, undefined],
    ["ui/request-display-mode", { mode: "sideways" }, -32602],
    ["ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///a.txt", text: "x" } }] }, undefined],
    ["ui/download-file", { contents: [] }, -32602],
    ["ui/download-file", { contents: [{ type: "text", text: "x" }] }, -32602],
    ["ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///a" } }] }, -32602],
    ["nothing/here", {}, -32601],
  ])("%s %j", async (method, params, code) => {
    const { start, request, answerOf } = setup();
    await start();
    request("r", method, params);
    const answer = await answerOf("r");
    if (code === undefined) expect(answer.error).toBeUndefined();
    else expect(answer.error?.code).toBe(code);
  });

  it("returns a normalised tool result", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    request(1, "tools/call", { name: "t", arguments: { a: 1 } });
    expect((await answerOf(1)).result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(options.callTool).toHaveBeenCalledWith({ name: "t", arguments: { a: 1 } });
    request(2, "tools/call", { name: "t" });
    await answerOf(2);
    expect(options.callTool).toHaveBeenLastCalledWith({ name: "t", arguments: {} });
  });

  it("reads resources and always answers contents as an array", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    request(1, "resources/read", { uri: "ui://x" });
    expect((await answerOf(1)).result).toEqual({ contents: [{ uri: "ui://x", text: "hi" }] });
    options.readResource.mockResolvedValueOnce(null as never);
    request(2, "resources/read", { uri: "ui://y" });
    expect((await answerOf(2)).result).toEqual({ contents: [] });
  });

  it("opens a link normalised, and sends a message's text joined", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    request(1, "ui/open-link", { url: "https://example.test" });
    await answerOf(1);
    expect(options.openLink).toHaveBeenCalledWith("https://example.test/");
    request(2, "ui/message", { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    await answerOf(2);
    expect(options.sendMessage).toHaveBeenCalledWith("a\nb");
    request(3, "ui/message", { role: "user", content: { type: "text", text: "single" } });
    await answerOf(3);
    expect(options.sendMessage).toHaveBeenLastCalledWith("single");
  });

  it("passes model context through as given", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    request(1, "ui/update-model-context", { content: [{ type: "text", text: "c" }], structuredContent: { a: 1 } });
    await answerOf(1);
    expect(options.updateModelContext).toHaveBeenCalledWith({ content: [{ type: "text", text: "c" }], structuredContent: { a: 1 } });
  });

  it("turns a callback's error into -32000 with its message, and a refusal likewise", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    options.callTool.mockRejectedValueOnce(new Error("session not running"));
    request(1, "tools/call", { name: "t" });
    expect((await answerOf(1)).error).toEqual({ code: -32000, message: "session not running" });
    options.openLink.mockRejectedValueOnce(new BridgeRefusal("Links open only from a click in the app."));
    request(2, "ui/open-link", { url: "https://example.test" });
    expect((await answerOf(2)).error).toEqual({ code: -32000, message: "Links open only from a click in the app." });
    options.sendMessage.mockImplementationOnce(() => { throw "odd"; });
    request(3, "ui/message", { role: "user", content: [{ type: "text", text: "x" }] });
    expect((await answerOf(3)).error?.code).toBe(-32000);
  });

  it("forwards size changes and teardown requests, and ignores unknown notifications", async () => {
    const { start, notification, options, sent } = setup();
    await start();
    notification("ui/notifications/size-changed", { width: 300, height: 420 });
    notification("ui/notifications/size-changed", { height: -1, width: "x" });
    notification("ui/notifications/size-changed", { height: Number.NaN });
    notification("ui/notifications/request-teardown");
    notification("notifications/message", { level: "info", data: "log" });
    notification("something/else", { a: 1 });
    expect(options.onSizeChanged).toHaveBeenCalledTimes(1);
    expect(options.onSizeChanged).toHaveBeenCalledWith({ width: 300, height: 420 });
    expect(options.onRequestTeardown).toHaveBeenCalledTimes(1);
    expect(sent.filter((entry) => entry.error)).toEqual([]);
  });
});

describe("MCP App bridge display modes", () => {
  it("switches only to a mode the host offers and the app declared", async () => {
    const { start, request, answerOf, options, context } = setup();
    await start();
    request(1, "ui/request-display-mode", { mode: "fullscreen" });
    expect((await answerOf(1)).result).toEqual({ mode: "fullscreen" });
    expect(options.requestDisplayMode).toHaveBeenCalledWith("fullscreen");
    request(2, "ui/request-display-mode", { mode: "pip" });
    expect((await answerOf(2)).result).toEqual({ mode: "inline" });
    context.value = { ...context.value, displayMode: "fullscreen" };
    request(3, "ui/request-display-mode", { mode: "fullscreen" });
    expect((await answerOf(3)).result).toEqual({ mode: "fullscreen" });
    expect(options.requestDisplayMode).toHaveBeenCalledTimes(1);
  });

  it("answers the current mode when the app declared none or the host offers only inline", async () => {
    const quiet = setup();
    await quiet.start({});
    quiet.request(1, "ui/request-display-mode", { mode: "fullscreen" });
    expect((await quiet.answerOf(1)).result).toEqual({ mode: "inline" });
    const inlineOnly = setup({}, { displayMode: "inline", availableDisplayModes: ["inline"] });
    await inlineOnly.start();
    inlineOnly.request(1, "ui/request-display-mode", { mode: "fullscreen" });
    expect((await inlineOnly.answerOf(1)).result).toEqual({ mode: "inline" });
    expect(inlineOnly.options.requestDisplayMode).not.toHaveBeenCalled();
  });

  it("answers the mode the host ended up in", async () => {
    const { start, request, answerOf } = setup({ requestDisplayMode: async (): Promise<"inline"> => "inline" });
    await start();
    request(1, "ui/request-display-mode", { mode: "fullscreen" });
    expect((await answerOf(1)).result).toEqual({ mode: "inline" });
  });
});

describe("MCP App bridge downloads", () => {
  it("hands over embedded text, embedded blobs and links with safe names", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    request(1, "ui/download-file", {
      contents: [
        { type: "resource", resource: { uri: "file:///tmp/../..//report%20final.csv", mimeType: "text/csv", text: "a,b" } },
        { type: "resource", resource: { uri: "file:///x/.hidden", blob: "AAEC" } },
        { type: "resource_link", uri: "ui://server/export", name: "..\\evil/..\\name?.txt", mimeType: "text/plain" },
        { type: "resource_link", uri: "https://example.test/dir/file.pdf" },
      ],
    });
    expect((await answerOf(1)).result).toEqual({});
    expect(options.downloadFile).toHaveBeenCalledWith([
      { name: "report final.csv", mimeType: "text/csv", uri: "file:///tmp/../..//report%20final.csv", link: false, text: "a,b" },
      { name: "hidden", uri: "file:///x/.hidden", link: false, blob: "AAEC" },
      { name: "name_.txt", mimeType: "text/plain", uri: "ui://server/export", link: true },
      { name: "file.pdf", uri: "https://example.test/dir/file.pdf", link: true },
    ]);
  });

  it("answers {isError:true} when the host refuses, and an error when it fails", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    const contents = [{ type: "resource", resource: { uri: "file:///a.txt", text: "x" } }];
    options.downloadFile.mockRejectedValueOnce(new BridgeRefusal("Declined by the user."));
    request(1, "ui/download-file", { contents });
    expect((await answerOf(1)).result).toEqual({ isError: true });
    options.downloadFile.mockRejectedValueOnce(new Error("disk full"));
    request(2, "ui/download-file", { contents });
    expect((await answerOf(2)).error?.message).toBe("disk full");
  });

  it("refuses an embedded file over 25 MiB without asking the host", async () => {
    const { start, request, answerOf, options } = setup();
    await start();
    const blob = "A".repeat(Math.ceil((MCP_APP_LIMITS.downloadBytes * 4) / 3) + 8);
    request(1, "ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///big", blob } }] });
    // The message limit comes first for such a blob.
    expect((await answerOf(1)).error?.code).toBe(-32600);
    expect(options.downloadFile).not.toHaveBeenCalled();
  });

  it("makes names safe", () => {
    expect(safeFileName("a/b/c.txt")).toBe("c.txt");
    expect(safeFileName("..")).toBe("download");
    expect(safeFileName("")).toBe("download");
    expect(safeFileName("na\u0000me\u0007.txt")).toBe("na_me_.txt");
    expect(safeFileName("x".repeat(500))).toHaveLength(120);
    expect(safeFileName("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("MCP App bridge limits", () => {
  it("refuses a request over 256 KiB with -32600 and drops such a notification", async () => {
    const { start, request, notification, answerOf, options, sent } = setup();
    await start();
    request(1, "ui/message", { role: "user", content: [{ type: "text", text: "x".repeat(MCP_APP_LIMITS.messageBytes) }] });
    expect((await answerOf(1)).error?.code).toBe(-32600);
    expect(options.sendMessage).not.toHaveBeenCalled();
    const before = sent.length;
    notification("ui/notifications/size-changed", { width: 1, height: 1, pad: "x".repeat(MCP_APP_LIMITS.messageBytes) });
    expect(options.onSizeChanged).not.toHaveBeenCalled();
    expect(sent).toHaveLength(before);
  });

  it("allows 16 requests in flight and fails the 17th with -32000", async () => {
    const release: Array<() => void> = [];
    const { start, request, answerOf, options } = setup({ callTool: vi.fn(() => new Promise((resolve) => { release.push(() => resolve({ content: [] })); })) });
    await start();
    for (let index = 0; index < MCP_APP_LIMITS.pendingRequests; index += 1) request(`p${index}`, "tools/call", { name: "t" });
    request("extra", "tools/call", { name: "t" });
    expect((await answerOf("extra")).error?.code).toBe(-32000);
    expect(options.callTool).toHaveBeenCalledTimes(MCP_APP_LIMITS.pendingRequests);
    release[0]!();
    await answerOf("p0");
    request("again", "tools/call", { name: "t" });
    expect(options.callTool).toHaveBeenCalledTimes(MCP_APP_LIMITS.pendingRequests + 1);
  });

  it.each([
    ["a string", "hello"],
    ["null", null],
    ["an array", [{ jsonrpc: "2.0", id: 1, method: "ping" }]],
    ["no jsonrpc", { id: 1, method: "ping" }],
    ["jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["an object id", { jsonrpc: "2.0", id: {}, method: "ping" }],
    ["no method", { jsonrpc: "2.0", id: 1 }],
    ["a response", { jsonrpc: "2.0", id: 1, result: {} }],
  ])("ignores %s", (_name, data) => {
    const { bridge, sent } = setup();
    bridge.receive(data);
    expect(sent).toEqual([]);
  });

  it("answers a request whose params are not an object with -32602", async () => {
    const { request, answerOf } = setup();
    request(1, "ping", "nope");
    expect((await answerOf(1)).error?.code).toBe(-32602);
  });

  it("ignores messages and posts nothing after dispose, also for requests in flight", async () => {
    let finish: () => void = () => undefined;
    const { bridge, start, request, sent } = setup({ callTool: () => new Promise((resolve) => { finish = () => resolve({ content: [] }); }) });
    await start();
    request("late", "tools/call", { name: "t" });
    bridge.dispose();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    request("after", "ping");
    bridge.setToolCall({ arguments: {} });
    bridge.updateHostContext();
    expect(sent.some((entry) => entry.id === "late" || entry.id === "after")).toBe(false);
  });
});

describe("MCP App bridge teardown", () => {
  const timers = () => {
    const callbacks = new Map<number, () => void>();
    let next = 1;
    return {
      callbacks,
      set: (callback: () => void) => { callbacks.set(next, callback); return next++; },
      clear: (handle: unknown) => { callbacks.delete(handle as number); },
    };
  };

  it("sends ui/resource-teardown and resolves on the app's answer", async () => {
    const fake = timers();
    const { bridge, start, sent } = setup({ timers: fake });
    await start();
    let done = false;
    const closing = bridge.teardown().then(() => { done = true; });
    const asked = sent.find((entry) => entry.method === "ui/resource-teardown");
    expect(asked).toMatchObject({ jsonrpc: "2.0", params: {} });
    expect(done).toBe(false);
    bridge.receive({ jsonrpc: "2.0", id: asked!.id, result: {} });
    await closing;
    expect(fake.callbacks.size).toBe(0);
  });

  it("gives up after the timeout when the app does not answer", async () => {
    const fake = timers();
    const { bridge, start } = setup({ timers: fake });
    await start();
    const closing = bridge.teardown();
    expect(fake.callbacks.size).toBe(1);
    [...fake.callbacks.values()][0]!();
    await closing;
  });

  it("uses a 2 second timeout by default", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, start } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await start();
      let done = false;
      void bridge.teardown().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves at once before the app initialized and after dispose, and on dispose while waiting", async () => {
    const early = setup();
    await early.bridge.teardown();
    expect(early.sent).toEqual([]);
    const { bridge, start } = setup({ timers: timers() });
    await start();
    const closing = bridge.teardown();
    bridge.dispose();
    await closing;
    await bridge.teardown();
  });
});

describe("normalizeToolResult", () => {
  it("keeps content an array and drops null fields", () => {
    expect(normalizeToolResult({ content: "no", structuredContent: null, _meta: null, isError: "x" })).toEqual({ content: [] });
    expect(normalizeToolResult(undefined)).toEqual({ content: [] });
    expect(normalizeToolResult({ content: [1], structuredContent: { a: 1 }, _meta: { b: 2 }, isError: true, extra: 1 })).toEqual({ content: [1], structuredContent: { a: 1 }, _meta: { b: 2 }, isError: true });
  });
});
