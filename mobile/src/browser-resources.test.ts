import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserResourceBridge, type BrowserResourceNative, type BrowserResourceRequest, type BrowserResourceResponse } from "./browser-resources";

const PATH = `/resources/${"a".repeat(64)}`;
const PAGE: BrowserResourceResponse = { status: 200, headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'" }, body: btoa("<script>1</script>") };
async function fixture(platform: "ios" | "android" = "android") {
  let listener!: (request: BrowserResourceRequest) => void;
  const native: BrowserResourceNative = {
    listen: vi.fn(async (next) => { listener = next; return vi.fn(); }),
    respond: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const bridge = await createBrowserResourceBridge(native, platform);
  const read = vi.fn(async () => PAGE);
  const route = bridge.open(read);
  const url = new URL(route.resourceUrl(PATH));
  const connectionId = url.pathname.split("/")[1]!;
  const emit = (id: string, overrides: Partial<BrowserResourceRequest> = {}) => listener({ id, connectionId, path: PATH, ...overrides });
  return { native, bridge, route, read, url, connectionId, emit };
}
afterEach(() => vi.useRealTimers());

describe("native browser resources", () => {
  it.each(["ios", "android"] as const)("routes %s frames through the connection and preserves response CSP", async (platform) => {
    const f = await fixture(platform);
    expect(f.url.origin === "https://tau-resources.localhost" || f.url.protocol === "tau-resource:").toBe(true);
    expect(f.url.hostname).toBe(platform === "ios" ? "localhost" : "tau-resources.localhost");
    f.emit("first");
    await vi.waitFor(() => expect(f.native.respond).toHaveBeenCalledWith({ id: "first", ...PAGE }));
    expect(f.read).toHaveBeenCalledWith(PATH);
    f.bridge.close();
  });

  it("rejects foreign connections and malformed capability paths before reading", async () => {
    const f = await fixture();
    f.emit("foreign", { connectionId: crypto.randomUUID() });
    f.emit("query", { path: `${PATH}?token=secret` });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.native.respond).toHaveBeenCalledWith({ id: "foreign", status: 404, headers: {}, body: "" });
    expect(f.native.respond).toHaveBeenCalledWith({ id: "query", status: 404, headers: {}, body: "" });
    expect(() => f.route.resourceUrl("https://machine/resources/x")).toThrow("Invalid host resource path");
    f.bridge.close();
  });

  it("drops a late socket reply after the connection closes", async () => {
    const f = await fixture();
    let finish!: (response: BrowserResourceResponse) => void;
    f.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    f.emit("late");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.route.close();
    expect(f.native.close).toHaveBeenCalledWith(f.connectionId);
    expect(() => f.route.resourceUrl(PATH)).toThrow("closed");
    finish(PAGE);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.native.respond).not.toHaveBeenCalled();
    f.emit("closed");
    expect(f.native.respond).toHaveBeenCalledWith({ id: "closed", status: 404, headers: {}, body: "" });
    f.bridge.close();
  });

  it("bounds simultaneous reads and times out a stalled request", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.read.mockImplementation(() => new Promise(() => undefined));
    for (let i = 0; i < 17; i++) f.emit(String(i));
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(16);
    expect(f.native.respond).toHaveBeenCalledWith({ id: "16", status: 404, headers: {}, body: "" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.native.respond).toHaveBeenCalledWith({ id: "0", status: 504, headers: {}, body: "" });
    f.bridge.close();
  });

  it("refuses redirect responses", async () => {
    const f = await fixture();
    f.read.mockResolvedValue({ ...PAGE, status: 302, headers: { location: "https://outside.example" } });
    f.emit("redirect");
    await vi.waitFor(() => expect(f.native.respond).toHaveBeenCalledWith({ id: "redirect", status: 502, headers: {}, body: "" }));
    f.bridge.close();
  });
});
