import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpTool, HostMcpToolProvider, HostSessionServices, HostTurnObserver, SecretStore } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createSchedulingHostExtension } from "./host.js";
import type { Job, ManagementState } from "./protocol.js";
import { verifyDelivery, type WebhookDelivery } from "./webhooks.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const SECRET = "test-webhook-private-key";
const config = { name: "CI triage", workspace: "/project", backend: "pi", prompt: "Inspect CI", schedule: { kind: "webhook" } };
function delivery(id = "delivery-1", timestamp = Date.now(), body = Buffer.from('{"event":"check"}')): WebhookDelivery {
  return { id, timestamp, body, signature: createHmac("sha256", SECRET).update(`${timestamp}\n${id}\n`).update(body).digest("hex") };
}
async function harness(existing?: { stateDir: string; store: SecretStore }) {
  const stateDir = existing?.stateDir ?? await mkdtemp(join(tmpdir(), "tau-webhooks-"));
  if (!existing) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const values = new Map<string, string>();
  const store: SecretStore = existing?.store ?? { name: "Test OS store", get: async (item) => values.get(item.account), has: async (item) => values.has(item.account), set: async (item, value) => { values.set(item.account, value); }, delete: async (item) => { values.delete(item.account); } };
  const starts: unknown[] = [];
  const events: unknown[] = [];
  let observer: HostTurnObserver | undefined;
  let provider: HostMcpToolProvider | undefined;
  const registry = await activateHostKit(createSchedulingHostExtension({ secretStore: store }), {
    stateDir, findCommand: () => undefined,
    knownWorkspacePath: async (path) => { if (!["/project", "host:/project", "/second"].includes(path)) throw new Error("Unknown project"); return path === "/second" ? path : "/project"; },
    workspaceRef: (path) => ({ workspaceId: `host:${path}`, displayPath: path }),
    thread: () => undefined,
    sessions: { start: async (options) => { starts.push(options); return { sessionId: `thread-${starts.length}`, cwd: "/project" }; } } as HostSessionServices,
    registerTurnObserver: (value) => { observer = value; return () => { observer = undefined; }; },
    mcp: { registerTools: (value) => { provider = value; return () => undefined; }, gate: () => () => undefined, connect: async () => undefined },
  }, (event) => events.push(event));
  cleanups.push(() => registry.deactivate("tau.scheduling"));
  const call = (command: string, input?: unknown) => registry.invoke("tau.scheduling", command, input);
  const manage = () => call("manage") as Promise<ManagementState>;
  const post = async (job: Job, value: WebhookDelivery) => {
    let url: string | undefined;
    await vi.waitFor(async () => { url = (await manage()).webhookUrl; expect(url).toBeDefined(); });
    return fetch(`${url}/${job.id}`, { method: "POST", body: new Uint8Array(value.body), headers: { "X-Tau-Delivery": value.id, "X-Tau-Timestamp": String(value.timestamp), "X-Tau-Signature": value.signature } });
  };
  return { stateDir, store, starts, events, call, manage, post, registry, end: (id: string) => observer?.ended?.(id, "turn", "completed"), stop: (id: string) => observer?.stopped?.(id), tool: async (cwd = "/project") => (await provider!({ sessionId: "requesting-thread", cwd } as never))[0] as HostMcpTool };
}

it("signs the timestamp and ID as well as the payload, rejects expiry and malformed signatures", () => {
  const original = delivery();
  expect(verifyDelivery(original, SECRET)).toBe(true);
  for (const changed of [{ ...original, id: "other" }, { ...original, timestamp: original.timestamp + 1 }, { ...original, body: Buffer.from("other") }, { ...original, signature: "short" }, delivery("old", Date.now() - 301000)]) expect(verifyDelivery(changed, SECRET)).toBe(false);
});

it("starts only after owner opt-in and signature validation, deduplicates across restart, and keeps the payload private", async () => {
  const h = await harness();
  const job = await h.call("create", config) as Job;
  await expect(h.call("enable", { id: job.id })).rejects.toThrow("signature key");
  await h.call("set-webhook-secret", { id: job.id, value: SECRET });
  await h.call("enable", { id: job.id });
  expect((await h.manage()).webhookUrl).toBeUndefined();
  await h.call("set-enabled", { enabled: true });
  const event = delivery();
  expect((await h.post(job, { ...event, signature: "0".repeat(64) })).status).toBe(401);
  expect(h.starts).toEqual([]);
  expect((await h.post(job, event)).status).toBe(202);
  expect((await h.post(job, delivery(event.id, event.timestamp + 1))).status).toBe(200);
  expect(h.starts).toEqual([{ cwd: "/project", backend: "pi", title: "Scheduled: CI triage", prompt: "Inspect CI" }]);
  await h.end("thread-1");
  expect(JSON.stringify(h.events)).not.toContain(SECRET);
  expect(await readFile(join(h.stateDir, "tau.scheduling", "jobs.json"), "utf8")).not.toContain(SECRET);
  const firstUrl = (await h.manage()).webhookUrl;
  await h.registry.deactivate("tau.scheduling");
  const restored = await harness(h);
  expect((await restored.post(job, event)).status).toBe(200);
  expect((await restored.manage()).webhookUrl).toBe(firstUrl);
  expect(restored.starts).toEqual([]);
  const ref = (await restored.manage()).jobs[0]!.secretRef!;
  await restored.call("delete", { id: job.id });
  expect(await restored.store.get({ service: "tau-webhook-signatures", account: ref })).toBeUndefined();
});

it("answers a thread's private request with a bound reference, never the value, and rejects foreign projects", async () => {
  const h = await harness();
  const job = await h.call("create", config) as Job;
  const foreign = await h.tool("/foreign");
  const input = { consumer: "webhook-signature", target: job.id, label: "Webhook key", reason: "Verify signed deliveries" };
  await expect(foreign.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow("Unknown project");
  const tool = await h.tool();
  const result = tool.execute("call", input, undefined, undefined, {} as never);
  let id: string | undefined;
  await vi.waitFor(async () => { id = (await h.manage()).secretRequests[0]?.id; expect(id).toBeDefined(); });
  await h.call("save-secret", { id, value: SECRET });
  const answer = await result;
  expect(JSON.stringify(answer)).not.toContain(SECRET);
  const ref = (await h.manage()).jobs[0]!.secretRef;
  expect(answer).toMatchObject({ details: { reference: ref, consumer: "webhook-signature", target: job.id, bound: true } });
  await expect(h.call("save-secret", { id, value: SECRET })).rejects.toThrow("ended");
  expect((await h.manage()).jobs[0]!.enabled).toBe(false);
  expect(JSON.stringify(h.events)).not.toContain(SECRET);
});

it("ends private requests on cancellation and cannot answer them from paired devices", async () => {
  const h = await harness();
  const job = await h.call("create", config) as Job;
  const controller = new AbortController();
  const tool = await h.tool();
  const result = tool.execute("call", { consumer: "webhook-signature", target: job.id, label: "Key", reason: "Verify webhook" }, controller.signal, undefined, {} as never);
  await vi.waitFor(async () => expect((await h.manage()).secretRequests[0]?.status).toBe("pending"));
  const id = (await h.manage()).secretRequests[0]!.id;
  const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device" } as const;
  await expect(h.registry.invoke("tau.scheduling", "save-secret", { id, value: SECRET }, phone)).rejects.toThrow();
  expect(await h.registry.invoke("tau.scheduling", "manage", undefined, phone)).toMatchObject({ canManage: false });
  controller.abort();
  expect(await result).toMatchObject({ details: { status: "ended" } });
  expect((await h.manage()).jobs[0]!.secretRef).toBeUndefined();
});


it("unbinds keys when a webhook moves projects and rejects an old private request's changed target", async () => {
  const h = await harness();
  const job = await h.call("create", config) as Job;
  await h.call("set-webhook-secret", { id: job.id, value: SECRET });
  const reference = (await h.manage()).jobs[0]!.secretRef!;
  const tool = await h.tool();
  const answer = tool.execute("call", { consumer: "webhook-signature", target: job.id, label: "Signature", reason: "Verify deliveries" }, undefined, undefined, {} as never);
  let request: string | undefined;
  await vi.waitFor(async () => { request = (await h.manage()).secretRequests[0]?.id; expect(request).toBeDefined(); });
  await h.call("update", { id: job.id, config: { ...config, workspace: "/second" } });
  expect((await h.manage()).jobs[0]!.secretRef).toBeUndefined();
  expect(await h.store.get({ service: "tau-webhook-signatures", account: reference })).toBeUndefined();
  await expect(h.call("save-secret", { id: request, value: SECRET })).rejects.toThrow("Couldn't save");
  await h.call("decline-secret", { id: request });
  expect(await answer).toMatchObject({ details: { status: "declined" } });
});


it("the unified Stop ends a pending private request without binding a key", async () => {
  const h = await harness();
  const job = await h.call("create", config) as Job;
  const tool = await h.tool();
  const answer = tool.execute("call", { consumer: "webhook-signature", target: job.id, label: "Signature", reason: "Verify deliveries" }, undefined, undefined, {} as never);
  let request: string | undefined;
  await vi.waitFor(async () => { request = (await h.manage()).secretRequests[0]?.id; expect(request).toBeDefined(); });
  expect(await h.stop("requesting-thread")).toEqual(["ended the private secret request"]);
  expect(await answer).toMatchObject({ details: { status: "ended" } });
  expect((await h.manage()).jobs[0]?.secretRef).toBeUndefined();
  await expect(h.call("save-secret", { id: request, value: SECRET })).rejects.toThrow("ended");
});
