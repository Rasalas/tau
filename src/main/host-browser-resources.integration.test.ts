import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BIND_BROWSER_RESOURCES, HostBrowserResourceStore } from "./host-browser-resources.js";
import { runAsCaller } from "./host-invocation.js";
import { HostPushLog } from "./host-push-log.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createHostMethods } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import { createSocketHostTransport } from "../shared/socket-host-transport.js";
import { WebSocket } from "ws";
import type { BrowserResourceResponse } from "../shared/browser-resource.js";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport.js";

let transport: SocketHostTransport | undefined;
afterEach(async () => { await transport?.close(); transport = undefined; });

describe("browser resources over the host's HTTP listener", () => {
  it("also carries frames on the authenticated socket, bound to the publishing connection", async () => {
    const resources = new HostBrowserResourceStore();
    const unsupported = (): never => { throw new Error("not used"); };
    const methods = createHostMethods({
      browserResources: resources,
      bootstrap: unsupported, requireHost: unsupported, host: () => undefined,
      jobs: new HostJobRunner(() => undefined),
      platform: {
        copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
        inspectExtensions: unsupported, loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
        workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
        notify: unsupported, setBadge: unsupported,
      },
    });
    methods["test-publish"] = async (_params, context) => runAsCaller(context.principal, async () => resources.services[BIND_BROWSER_RESOURCES]("pages").publishFrame({ html: "<h1>Phone preview</h1>" }));
    transport = await startSocketHostTransport({ listen: "127.0.0.1:0", browserResources: resources, methods, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: "test-secret" });
    const url = `ws://127.0.0.1:${transport.port}`;
    const phone = createSocketHostTransport(url, "test-secret", { createSocket: (address) => new WebSocket(address) as never });
    const other = createSocketHostTransport(url, "test-secret", { createSocket: (address) => new WebSocket(address) as never });
    try {
      const hellos = await Promise.all([phone, other].map((client) => client.request("hello", [{ protocol: HOST_TRANSPORT_VERSION, profile: "compact" }])));
      for (const hello of hellos) expect(hello.error).toBeUndefined();
      const published = await phone.request("test-publish", []);
      expect(published.error).toBeUndefined();
      const path = published.result;
      const response = await phone.request("read-browser-resource", [path]);
      expect(response.error).toBeUndefined();
      const resource = response.result as BrowserResourceResponse;
      expect(resource.status).toBe(200);
      expect(Buffer.from(resource.body, "base64").toString()).toContain("<h1>Phone preview</h1>");
      expect(resource.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-forms;");
      expect(await other.request("read-browser-resource", [path])).toMatchObject({ result: { status: 404, body: "" } });
      expect((await phone.request("start-job", ["read-browser-resource", [path]])).error?.message).toContain("cannot run as a job");
    } finally { phone.close?.(); other.close?.(); resources.close(); }
  });

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

  it("serves a sandbox frame over HTTP with its sandbox header", async () => {
    const resources = new HostBrowserResourceStore();
    transport = await startSocketHostTransport({ listen: "127.0.0.1:0", attachTo: createServer((_request, response) => response.end("static")), browserResources: resources, methods: {}, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: "test-secret" });
    const path = await runAsCaller({ kind: "workbench-client", connection: "test" }, async () => resources.services[BIND_BROWSER_RESOURCES]("kit").publishFrame({ html: "<p>app</p>" }));
    const response = await fetch(`http://127.0.0.1:${transport.port}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts allow-forms; default-src 'none'/);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toMatch(/^<!doctype html><meta .*<p>app<\/p>$/s);
    resources.close();
  });
});
