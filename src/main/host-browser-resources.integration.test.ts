import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BIND_BROWSER_RESOURCES, HostBrowserResourceStore } from "./host-browser-resources.js";
import { runAsCaller } from "./host-invocation.js";
import { HostPushLog } from "./host-push-log.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";

let transport: SocketHostTransport | undefined;
afterEach(async () => { await transport?.close(); transport = undefined; });

describe("browser resources over the host's HTTP listener", () => {
  it("dispatches before static assets, streams ranges, and leaves other routes alone", async () => {
    let staticCalls = 0;
    const server = createServer((_request, response) => { staticCalls++; response.end("static"); });
    const resources = new HostBrowserResourceStore();
    transport = await startSocketHostTransport({ listen: "127.0.0.1:0", attachTo: server, browserResources: resources, methods: {}, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: "test-secret" });
    const path = await runAsCaller({ kind: "workbench-client", connection: "test" }, async () => resources.services[BIND_BROWSER_RESOURCES]("kit").publish(async (request) => {
      expect(request.headers.get("range")).toBe("bytes=2-5");
      return new Response("2345", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 2-5/8", "content-length": "4" } });
    }));
    const base = `http://127.0.0.1:${transport.port}`;
    const response = await fetch(base + path, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206); expect(await response.text()).toBe("2345");
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(staticCalls).toBe(0);
    expect(await (await fetch(base + "/")).text()).toBe("static"); expect(staticCalls).toBe(1);
    resources.close();
    expect((await fetch(base + path)).status).toBe(404);
  });
});
