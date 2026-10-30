import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostHttpRoute, HostPublicToolOptions, HostSessionServices, HostThread, HostThreadLifecycle, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createSharing from "./host.js";
import { GUEST_PATH, SHARING_ID, type SharingState } from "./protocol.js";

const releases: Array<() => unknown> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-sharing-host-"));
  releases.push(() => rm(directory, { recursive: true, force: true }));
  let route: HostHttpRoute | undefined;
  let observer!: HostTurnObserver;
  let lifecycle!: HostThreadLifecycle;
  let live = true;
  let endpoints = true;
  const send = vi.fn<NonNullable<HostSessionServices["send"]>>(async () => undefined);
  const thread = { sessionId: "one", parentThreadId: undefined, sessionName: () => "One", transcript: async () => [{ id: "a", role: "assistant", text: "Public text", thinking: "Hidden", timestamp: 0 }] } as unknown as HostThread;
  const services = {
    stateDir: directory,
    thread: (id?: string) => id === "one" && live ? thread : undefined,
    sessions: { list: async () => ["one", "two"].map((sessionId) => ({ sessionId, path: "/unused", cwd: "/test" })), send } as unknown as HostSessionServices,
    registerThreadLifecycle: (next: HostThreadLifecycle) => { lifecycle = next; return () => undefined; },
    registerTurnObserver: (next: HostTurnObserver) => { observer = next; return () => undefined; },
    network: {
      state: () => undefined, holdProxy: vi.fn(async () => () => undefined), keepProxy: vi.fn(async () => undefined), publishEndpoints: () => () => undefined,
      publishedEndpoints: () => endpoints ? [{ url: "https://test.ts.net/", trustedCertificate: true, reachability: "network" as const, label: "Tailscale HTTPS" }] : [],
      registerHttpRoute: (_name: string, handler: HostHttpRoute) => { route = handler; return () => { route = undefined; }; },
    },
  };
  const registry = await activateHostKit(createSharing(), services);
  releases.push(() => registry.deactivate(SHARING_ID));
  const server = createServer((request, response) => {
    if (!route) { response.writeHead(404); response.end(); return; }
    void route(request, response, "loopback").then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  releases.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  const base = `http://127.0.0.1:${address.port}`;
  const invoke = (command: string, input?: unknown) => registry.invoke(SHARING_ID, command, input);
  const request = (suffix: string, token: string, input?: unknown) => fetch(base + GUEST_PATH + suffix, { method: input ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(input ? { "Content-Type": "application/json", Origin: "https://test.ts.net" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const share = async (showToolOutput = false) => {
    await invoke("enable", { enabled: true });
    const created = await invoke("create", { threadId: "one", hours: 1, mode: "suggest", showToolOutput }) as { id: string; url: string };
    const link = new URL(created.url).hash.slice("#guest=".length);
    const token = `taub.${created.id}.${"a".repeat(43)}`;
    expect((await request("/claim", link, { browserToken: token })).status).toBe(200);
    return { ...created, link, token };
  };
  return { registry, invoke, request, share, send, services, thread, directory, get observer() { return observer; }, get lifecycle() { return lifecycle; }, closeThread: () => { live = false; }, noEndpoints: () => { endpoints = false; } };
}
describe("thread sharing owner commands", () => {
  it("requires local owner management, separate from Full and Read only", async () => {
    const f = await fixture();
    for (const principal of [{ kind: "workbench-client" as const, connection: "phone", pairedClient: "phone" }, { kind: "workbench-client" as const, connection: "remote-owner" }, { kind: "workbench-client" as const, connection: "readonly", pairedClient: "readonly", readOnly: true as const }]) {
      for (const command of ["enable", "create", "revoke"]) await expect(f.registry.invoke(SHARING_ID, command, {}, principal)).rejects.toThrow();
    }
    f.noEndpoints();
    await f.invoke("enable", { enabled: true });
    await expect(f.invoke("create", { threadId: "one" })).rejects.toThrow("Tau Connect's WebSocket relay does not serve guest pages");
    expect(f.services.network.holdProxy).not.toHaveBeenCalled();
    expect(f.services.network.keepProxy).not.toHaveBeenCalled();
  });
  it("moderates into the existing queue exactly once, with no auto-delivery", async () => {
    const f = await fixture(); const link = await f.share();
    expect((await f.request("/suggest", link.token, { text: "Guest proposal" })).status).toBe(200);
    expect(f.send).not.toHaveBeenCalled();
    const state = await f.invoke("state") as SharingState;
    const suggestionId = state.links[0]!.suggestions[0]!.id;
    const readonly = { kind: "workbench-client" as const, pairedClient: "phone", readOnly: true as const };
    await expect(f.registry.invoke(SHARING_ID, "send", { id: link.id, suggestionId }, readonly)).rejects.toThrow();
    const full = { kind: "workbench-client" as const, pairedClient: "phone" };
    await f.registry.invoke(SHARING_ID, "send", { id: link.id, suggestionId }, full);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith("one", "Guest proposal", { delivery: "queue", beforeAdmit: expect.any(Function), attachments: [] });
  });
  it("keeps the safe cached projection when a runtime is evicted and ends it on Stop", async () => {
    const f = await fixture(); const link = await f.share();
    f.closeThread();
    const view = await f.request("/view", link.token);
    expect(view.status).toBe(200); expect(await view.text()).toContain("Public text");
    await f.observer.stopped!("one");
    expect((await f.request("/view", link.token)).status).toBe(403);
  });
  it("requires owner opt-in, calls the canonical public projection and caches its allowlisted fields", async () => {
    const f = await fixture();
    f.thread.publicTools = vi.fn(async ({ includeOutput }: HostPublicToolOptions) => ({ tools: [{ name: "bash", status: "done" as const, ...(includeOutput ? { output: "Visible tool output" } : {}), args: { password: "PRIVATE" } }], truncated: false }));
    expect((await f.invoke("state") as SharingState).toolOutputThreads).toEqual(["one"]);
    const off = await f.share();
    expect(f.thread.publicTools).toHaveBeenCalledWith({ includeOutput: false });
    expect((await (await f.request("/view", off.token)).json()).tools).toEqual([{ name: "bash", status: "done" }]);
    const on = await f.share(true);
    expect(f.thread.publicTools).toHaveBeenCalledWith({ includeOutput: true });
    const body = await (await f.request("/view", on.token)).text();
    expect(JSON.parse(body).tools).toEqual([{ name: "bash", status: "done", output: "Visible tool output" }]);
    expect(body).not.toContain("PRIVATE");
    f.closeThread();
    expect((await (await f.request("/view", on.token)).json()).tools[0]?.output).toBe("Visible tool output");
    await f.observer.stopped!("one");
    expect((await f.request("/view", on.token)).status).toBe(403);
  });
  it("drops cached tools on the same archive, trash and deletion paths as messages", async () => {
    const f = await fixture();
    f.thread.publicTools = async () => ({ tools: [{ name: "bash", status: "done", output: "Visible tool output" }], truncated: false });
    await f.registry.activate({ id: "tau.thread-rail", name: "Rail fixture", activate(context) {
      context.registerCommand("archive", () => { context.emit("meta", { threads: { one: { archivedAt: 1 } } }); });
      context.registerCommand("trash", () => { context.emit("trash", [{ sessionId: "one" }]); });
    } });
    releases.push(() => f.registry.deactivate("tau.thread-rail"));
    for (const action of ["archive", "trash", "beforeRemove", "threadDeleted"] as const) {
      const link = await f.share(true);
      if (action === "archive" || action === "trash") await f.registry.invoke("tau.thread-rail", action);
      else await f.lifecycle[action]!("one", "/test");
      expect((await f.request("/view", link.token)).status).toBe(403);
    }
  });
  it("revokes immediately on bound archive/trash events, even if restored before a poll", async () => {
    const f = await fixture();
    await f.registry.activate({ id: "tau.thread-rail", name: "Rail fixture", activate(context) {
      context.registerCommand("archive", () => { context.emit("meta", { threads: { one: { archivedAt: 1 } } }); context.emit("meta", { threads: {} }); });
      context.registerCommand("trash", () => { context.emit("trash", [{ sessionId: "one" }]); context.emit("trash", []); });
    } });
    releases.push(() => f.registry.deactivate("tau.thread-rail"));
    for (const command of ["archive", "trash"]) {
      const link = await f.share();
      await f.registry.invoke("tau.thread-rail", command);
      expect((await f.request("/view", link.token)).status).toBe(403);
    }
  });
  it("revokes before a direct Core removal, so immediate restore cannot revive a link", async () => {
    const f = await fixture(); const link = await f.share();
    await f.lifecycle.beforeRemove!("one", "/test");
    // The fixture's session remains in the index, just as after immediate restore.
    expect((await f.request("/view", link.token)).status).toBe(403);
    expect((await f.invoke("state") as SharingState).links).toEqual([]);
  });
  it("fails closed for archived threads, mismatched runtime ids and unsafe tool output", async () => {
    const f = await fixture(); await f.invoke("enable", { enabled: true });
    await expect(f.invoke("create", { threadId: "two" })).rejects.toThrow("unarchived");
    await expect(f.invoke("create", { threadId: "one", showToolOutput: true })).rejects.toThrow("safely");
    await mkdir(join(f.directory, "tau.thread-rail"), { recursive: true });
    await writeFile(join(f.directory, "tau.thread-rail", "thread-meta.json"), JSON.stringify({ version: 1, threads: { one: { archivedAt: 1 } } }));
    await expect(f.invoke("create", { threadId: "one" })).rejects.toThrow("unarchived");
  });
});

it("withdraws suggestion admission while its runtime is reopening", async () => {
  const f = await fixture(); const link = await f.share();
  await f.request("/suggest", link.token, { text: "Waiting proposal" });
  const state = await f.invoke("state") as SharingState;
  const suggestionId = state.links[0]!.suggestions[0]!.id;
  let enter!: () => void; let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const queued = vi.fn();
  f.send.mockImplementation(async (_id, _text, options) => { enter(); await gate; options?.beforeAdmit?.(); queued(); });
  const pending = f.invoke("send", { id: link.id, suggestionId });
  const refused = expect(pending).rejects.toThrow("ended");
  await entered; await f.invoke("revoke", { id: link.id }); finish(); await refused;
  expect(queued).not.toHaveBeenCalled();
});
