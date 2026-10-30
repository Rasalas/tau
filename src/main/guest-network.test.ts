import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport.js";
import { NetworkContributions } from "./host-network-contributions.js";
import { HostThreadLifecycleSet } from "./host-extensions.js";
import { HostAccess } from "./host-access.js";
import { HostTokenFile } from "./host-token.js";
import { HostPushLog } from "./host-push-log.js";
import { hostHttpListener } from "./host-http-route.js";
import { startSocketHostTransport } from "./host-transport-socket.js";

const releases: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  releases.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No isolated listener");
  return `http://127.0.0.1:${address.port}`;
}
describe("guest networking uses existing listeners with separate credentials", () => {
  it("registers only the extension's namespace without acquiring a network hold, and removes it on release", async () => {
    const contributions = new NetworkContributions();
    const network = contributions.forExtension("tau.thread-sharing");
    const release = network.registerHttpRoute!("guest", async (_request, response) => { response.writeHead(200); response.end("guest"); return true; });
    const base = await listen(createServer(hostHttpListener(contributions.serve, "loopback")));
    expect(contributions.proxyHeld).toBe(false);
    expect((await fetch(base + "/extensions/tau.thread-sharing/guest")).status).toBe(200);
    for (const path of ["/", "/pair", "/files", "/extensions/other/guest", "/extensions/tau.thread-sharing/guest-other"]) expect((await fetch(base + path)).status).toBe(426);
    expect(() => network.registerHttpRoute!("../pair", async () => false)).toThrow();
    release();
    expect((await fetch(base + "/extensions/tau.thread-sharing/guest")).status).toBe(426);
  });
  it("awaits revocation before removal and propagates failures to stop the deletion", async () => {
    const hooks = new HostThreadLifecycleSet();
    const calls: string[] = [];
    hooks.add({ beforeRemove: async (id) => { calls.push(`revoke:${id}`); } });
    await hooks.beforeRemove("chosen", "/project");
    expect(calls).toEqual(["revoke:chosen"]);
    hooks.add({ beforeRemove: async () => { throw new Error("Could not persist revocation"); } });
    await expect(hooks.beforeRemove("chosen", "/project")).rejects.toThrow("persist revocation");
  });
  it("refuses both guest credential forms on the real host WebSocket before any methods or pushes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-guest-audience-"));
    releases.push(() => rm(directory, { recursive: true, force: true }));
    const access = await HostAccess.open({ tokenFile: new HostTokenFile(join(directory, "host-token")), storePath: join(directory, "clients.json") });
    releases.push(() => access.flush());
    const transport = await startSocketHostTransport({ listen: "127.0.0.1:0", access, methods: {}, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [] });
    releases.push(() => transport.close());
    for (const audience of ["g", "b"]) {
      const token = `tau${audience}.${"a".repeat(24)}.${"b".repeat(43)}`;
      expect(access.authenticate(token)).toBeUndefined();
      const result = await new Promise<{ code: number; messages: string[] }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${transport.port}/extensions/tau.thread-sharing/guest`);
        const messages: string[] = [];
        socket.once("error", reject);
        socket.on("message", (data) => { messages.push(String(data)); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "hello", id: "guest", hello: { protocol: HOST_TRANSPORT_VERSION, token } })));
        socket.once("close", (code) => resolve({ code, messages }));
      });
      expect(result).toEqual({ code: 4401, messages: [] });
    }
  });
});
