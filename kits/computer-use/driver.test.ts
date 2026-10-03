import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseDriverSession, ComputerUseDriverSessions, loadComputerUseManifest, type ComputerUseClient, type ComputerUseTool } from "./driver.js";

const packageRoot = dirname(createRequire(import.meta.url).resolve("@amaster.ai/pi-computer-use/package.json"));
const tool: ComputerUseTool = { name: "click", inputSchema: { type: "object" } };
function client(): ComputerUseClient {
  return { listAllTools: vi.fn(async () => [tool]), callTool: vi.fn(async () => ({ content: [{ type: "text", text: "done" }] })), close: vi.fn(async () => {}) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Computer Use native sessions", () => {
  it("loads the complete pinned macOS manifest without starting a client", async () => {
    const createClient = vi.fn(() => client());
    const session = new ComputerUseDriverSession({}, { platform: "darwin", createClient, loadManifest: () => loadComputerUseManifest(packageRoot) });
    const tools = await session.listTools();
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.some((entry) => entry.name === "get_window_state")).toBe(true);
    expect(tools.some((entry) => entry.name === "browser_prepare")).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
    expect(await loadComputerUseManifest(packageRoot)).toEqual(tools);
  });

  it.each(["win32", "linux"] as const)("discovers %s live schemas and retries failed discovery", async (platform) => {
    const native = client();
    vi.mocked(native.listAllTools).mockRejectedValueOnce(new Error("unavailable"));
    const session = new ComputerUseDriverSession({}, { platform, createClient: () => native });
    await expect(session.listTools()).rejects.toThrow("unavailable");
    expect(await session.listTools()).toEqual([tool]);
    expect(await session.listTools()).toEqual([tool]);
    expect(native.listAllTools).toHaveBeenCalledTimes(2);
  });

  it("serializes calls and cancels a queued call without dispatching it", async () => {
    const native = client();
    const active = deferred<{ content: { type: string; text: string }[] }>();
    vi.mocked(native.callTool).mockImplementationOnce(() => active.promise);
    const session = new ComputerUseDriverSession({}, { createClient: () => native });
    const first = session.call("click", {});
    await Promise.resolve();
    const abort = new AbortController();
    const second = session.call("type_text", {}, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    expect(native.callTool).toHaveBeenCalledTimes(1);
    active.resolve({ content: [{ type: "text", text: "first" }] });
    await first;
    await session.call("click", {});
    expect(native.callTool).toHaveBeenCalledTimes(2);
  });

  it("keeps thread configuration separate and never replays a failed action", async () => {
    const first = client();
    const second = client();
    const createClient = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const sessions = new ComputerUseDriverSessions({ createClient });
    const settings = { mode: "path" as const, binaryPath: "/first/driver", extraArgs: ["--one"] };
    const one = sessions.forThread("one", settings);
    settings.extraArgs.push("--mutated");
    const two = sessions.forThread("two", { mode: "path", binaryPath: "/second/driver" });
    vi.mocked(first.callTool).mockRejectedValueOnce(new Error("connection lost"));
    await expect(one.call("click", { x: 1 })).rejects.toThrow("connection lost");
    expect(first.callTool).toHaveBeenCalledTimes(1);
    await two.call("click", {});
    expect(createClient.mock.calls).toEqual([
      [{ mode: "path", binaryPath: "/first/driver", extraArgs: ["--one"] }],
      [{ mode: "path", binaryPath: "/second/driver" }],
    ]);
    await sessions.close();
  });

  it("preserves images and capture metadata while bounding large trees", async () => {
    const native = client();
    vi.mocked(native.callTool).mockResolvedValue({
      content: [{ type: "text", text: "x".repeat(100_000) }, { type: "image", data: "image-data", mimeType: "image/png" }],
      structuredContent: { screenshot_file_path: "/tmp/capture.png", screenshot: { width: 800 }, tree_markdown: "y".repeat(100_000), elements: Array.from({ length: 1000 }, (_, element_index) => ({ element_index, label: "z".repeat(100) })) },
      isError: true,
    });
    const session = new ComputerUseDriverSession({}, { createClient: () => native });
    const result = await session.call("get_window_state", {});
    expect(result.content[1]).toEqual({ type: "image", data: "image-data", mimeType: "image/png" });
    expect(result.details).toMatchObject({ screenshot_file_path: "/tmp/capture.png", screenshot: { width: 800 }, total_elements: 1000, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(24 * 1024);
    expect(result.isError).toBe(true);
    expect(result.content.reduce((bytes, item) => bytes + (item.type === "text" ? Buffer.byteLength(item.text) : 0), 0)).toBeLessThanOrEqual(32 * 1024);
  });

  it("renders structured window data into bounded model-visible content", async () => {
    const native = client();
    vi.mocked(native.callTool).mockResolvedValue({
      content: [{ type: "text", text: "Found 2 window(s)." }],
      structuredContent: { windows: [{ window_id: 42, pid: 123, title: "Editor", bounds: { x: 1, y: 2, width: 800, height: 600 } }] },
    });
    const session = new ComputerUseDriverSession({}, { createClient: () => native });
    const result = await session.call("list_windows", {});
    const texts = result.content.filter((item) => item.type === "text");
    expect(texts.map((item) => item.text).join("\n")).toContain('"window_id":42');
    expect(texts.map((item) => item.text).join("\n")).toContain('"title":"Editor"');
    expect(texts.map((item) => item.text).join("\n")).toContain('"bounds":{"x":1,"y":2,"width":800,"height":600}');
    expect(texts.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(32 * 1024);
  });

  it("hard bounds oversized nested platform output and preserves capture fields", async () => {
    const native = client();
    vi.mocked(native.callTool).mockResolvedValue({
      structuredContent: { pid: 123, screenshot_width: 800, screenshot_height: 600, screenshot_file_path: "/tmp/screen.png", platform: { apps: Array.from({ length: 5000 }, () => ({ name: "app", payload: "\\\"".repeat(100) })) } },
    });
    const session = new ComputerUseDriverSession({}, { createClient: () => native });
    const result = await session.call("list_apps", {});
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(24 * 1024);
    expect(result.details).toMatchObject({ pid: 123, screenshot_width: 800, screenshot_height: 600, screenshot_file_path: "/tmp/screen.png", truncated: true });
  });

  it("aborts active calls on close and creates a fresh session after thread teardown", async () => {
    const native = client();
    vi.mocked(native.callTool).mockImplementation(async (_name, _args, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const createClient = vi.fn(() => native);
    const sessions = new ComputerUseDriverSessions({ createClient });
    const session = sessions.forThread("thread");
    const running = session.call("click", {});
    await Promise.resolve();
    const rejected = expect(running).rejects.toThrow("closed");
    await sessions.closeThread("thread");
    await rejected;
    expect(native.close).toHaveBeenCalledTimes(1);
    await expect(session.call("click", {})).rejects.toThrow("closed");
    expect(sessions.forThread("thread")).not.toBe(session);
    await sessions.close();
  });
});
