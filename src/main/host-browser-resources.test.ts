import { describe, expect, it } from "vitest";
import { BIND_BROWSER_RESOURCES, HostBrowserResourceStore } from "./host-browser-resources.js";
import { runAsCaller } from "./host-invocation.js";

const as = <T>(connection: string, run: () => Promise<T>) => runAsCaller({ kind: "workbench-client", connection }, run);
const request = (path: string, init?: RequestInit) => new Request(`http://host.test${path}`, init);

describe("host browser resource capabilities", () => {
  it("requires a client call, and scopes release to the publishing extension and connection", async () => {
    const store = new HostBrowserResourceStore();
    const own = store.services[BIND_BROWSER_RESOURCES]("a");
    const other = store.services[BIND_BROWSER_RESOURCES]("b");
    expect(() => own.publish(async () => new Response("secret"))).toThrow(/client command/);
    const path = await as("client-a", async () => own.publish(async () => new Response("secret")));
    expect(path).toMatch(/^\/resources\/[0-9a-f]{64}$/);
    await as("client-b", async () => own.release(path));
    await as("client-a", async () => other.release(path));
    expect(await (await store.respond(request(path))).text()).toBe("secret");
    await as("client-a", async () => own.release(path));
    expect((await store.respond(request(path))).status).toBe(404);
  });
  it("passes HEAD, Range and cancellation through without buffering or leaking handler errors", async () => {
    const store = new HostBrowserResourceStore();
    let seen: Request | undefined;
    const path = await as("a", async () => store.services[BIND_BROWSER_RESOURCES]("kit").publish(async (req) => {
      seen = req;
      return new Response(new ReadableStream({ start(target) { target.enqueue(new Uint8Array([1, 2])); } }), { status: 206, headers: { "content-range": "bytes 1-2/5", "set-cookie": "private=secret", "content-type": "video/mp4" } });
    }));
    const result = await store.respond(request(path, { headers: { range: "bytes=1-2" } }));
    expect(seen?.headers.get("range")).toBe("bytes=1-2");
    expect(result.status).toBe(206);
    expect(result.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    await result.body!.cancel();
    expect(seen?.signal.aborted).toBe(true);
    const head = await store.respond(request(path, { method: "HEAD" }));
    expect(seen?.method).toBe("HEAD");
    expect(head.body).toBeNull();
    store.close();
  });
  it("revokes on disconnect, extension removal and expiry, including unfinished streams", async () => {
    let now = 0;
    const store = new HostBrowserResourceStore(() => now);
    const make = async (connection: string, extension: string) => as(connection, async () => store.services[BIND_BROWSER_RESOURCES](extension).publish(async () => new Response("bytes")));
    const a = await make("a", "kit"); const b = await make("b", "kit"); const c = await make("b", "other");
    store.detach("a");
    expect((await store.respond(request(a))).status).toBe(404);
    store.removeExtension("kit");
    expect((await store.respond(request(b))).status).toBe(404);
    expect((await store.respond(request(c))).status).toBe(200);
    now = 10 * 60_000;
    expect((await store.respond(request(c))).status).toBe(404);
  });
  it("does not serve a late response after its capability was revoked", async () => {
    const store = new HostBrowserResourceStore();
    let finish!: (response: Response) => void;
    let cancelled = false;
    const path = await as("a", async () => store.services[BIND_BROWSER_RESOURCES]("kit").publish(() => new Promise((resolve) => { finish = resolve; })));
    const pending = store.respond(request(path));
    store.detach("a");
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    expect((await pending).status).toBe(404);
    expect(cancelled).toBe(true);
  });
  it("disconnect aborts an unfinished transfer, even when the handler's stream ignores its signal", async () => {
    const store = new HostBrowserResourceStore();
    let cancelled = false;
    const path = await as("a", async () => store.services[BIND_BROWSER_RESOURCES]("kit").publish(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))));
    const response = await store.respond(request(path));
    const pending = response.body!.getReader().read();
    store.detach("a");
    await expect(pending).rejects.toThrow("Resource revoked");
    expect(cancelled).toBe(true);
  });
  it("rejects methods, malformed paths and queries, and hides sensitive errors", async () => {
    const store = new HostBrowserResourceStore();
    const path = await as("a", async () => store.services[BIND_BROWSER_RESOURCES]("kit").publish(async () => { throw new Error("credential=secret"); }));
    expect((await store.respond(request(path, { method: "POST" }))).status).toBe(405);
    expect((await store.respond(request(`${path}?token=x`))).status).toBe(404);
    const failure = await store.respond(request(path));
    expect(failure.status).toBe(502); expect(await failure.text()).toBe("");
    store.close();
  });
});
