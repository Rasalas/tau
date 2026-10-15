import { describe, expect, it, vi } from "vitest";
import { BIND_BROWSER_RESOURCES, HostBrowserResourceStore } from "./host-browser-resources.js";
import { runAsCaller } from "./host-invocation.js";

const as = <T>(connection: string, run: () => Promise<T>) => runAsCaller({ kind: "workbench-client", connection }, run);

describe("browser resources through the pinned socket", () => {
  it("returns the frame bytes and its policy only to the connection that published it", async () => {
    const store = new HostBrowserResourceStore();
    try {
      const path = await as("phone", async () => store.services[BIND_BROWSER_RESOURCES]("pages").publishFrame({ html: "<h1>Grüße</h1><script>parent.postMessage('ready','*')</script>" }));
      const response = await as("phone", () => store.readForClient(path));
      expect(response.status).toBe(200);
      expect(Buffer.from(response.body, "base64").toString("utf8")).toContain("<h1>Grüße</h1>");
      expect(response.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-forms;");
      expect(response.headers["content-security-policy"]).not.toContain("allow-same-origin");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect((await as("other-phone", () => store.readForClient(path))).status).toBe(404);
      expect((await store.readForClient(path)).status).toBe(404);
      expect((await as("phone", () => store.readForClient(path + "?other"))).status).toBe(404);
      expect((await as("phone", () => store.readForClient("https://example.com/"))).status).toBe(404);
      store.detach("phone");
      expect((await as("phone", () => store.readForClient(path))).status).toBe(404);
    } finally { store.close(); }
  });

  it("bounds streamed bytes and cancels oversized responses", async () => {
    const store = new HostBrowserResourceStore();
    let cancelled = false;
    try {
      const path = await as("phone", async () => store.services[BIND_BROWSER_RESOURCES]("pages").publish(async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      }))));
      const response = await as("phone", () => store.readForClient(path));
      expect(response.status).toBe(413);
      expect(response.body).toBe("");
      expect(cancelled).toBe(true);
    } finally { store.close(); }
  });

  it.each(["headers", "body"])("times out stalled %s without leaving the native request waiting", async (phase) => {
    vi.useFakeTimers();
    const store = new HostBrowserResourceStore();
    let signal: AbortSignal | undefined;
    let cancelled = false;
    try {
      const path = await as("phone", async () => store.services[BIND_BROWSER_RESOURCES]("pages").publish(async (request) => {
        signal = request.signal;
        if (phase === "headers") return new Promise<Response>(() => undefined);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      }));
      const pending = as("phone", () => store.readForClient(path));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ status: 502, body: "" });
      expect(signal?.aborted).toBe(true);
      if (phase === "body") expect(cancelled).toBe(true);
    } finally { store.close(); vi.useRealTimers(); }
  });

  it("discards partial bytes when the connection closes during a read", async () => {
    const store = new HostBrowserResourceStore();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    try {
      const path = await as("phone", async () => store.services[BIND_BROWSER_RESOURCES]("pages").publish(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        pull() { started(); },
      }))));
      const pending = as("phone", () => store.readForClient(path));
      await reading;
      store.detach("phone");
      expect(await pending).toMatchObject({ body: "" });
    } finally { store.close(); }
  });
});
