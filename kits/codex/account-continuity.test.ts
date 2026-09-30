import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CodexAppServer } from "./app-server.js";
import { prepareCodexHome } from "./home-layout.js";
import { spawnRpcProcess } from "./rpc.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CodexSessionStore } from "./session-store.js";
import { CodexThreadRuntimeBackend, storedModel } from "./thread-backend.js";
import frames from "./fixtures/app-server-frames.json" with { type: "json" };

const stub = fileURLToPath(new URL("./fixtures/stub-app-server.mjs", import.meta.url));
const directories: string[] = [];
const backends: CodexThreadRuntimeBackend[] = [];
afterEach(async () => { await Promise.all(backends.splice(0).map((backend) => backend.dispose())); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "tau-account-continuity-")); directories.push(root);
  const shared = join(root, "shared");
  const envA = await prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: join(root, "auth-a") });
  const envB = await prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: join(root, "auth-b") });
  await writeFile(join(envA.CODEX_HOME!, "auth.json"), "synthetic A");
  await writeFile(join(envB.CODEX_HOME!, "auth.json"), "synthetic B");
  const models = frames.models.map((model) => ({ ...model, serviceTiers: [{ id: "fast", name: "Fast" }, { id: "ultrafast", name: "Ultrafast", description: "Catalog description" }, { id: "future-tier", name: "Future" }], defaultServiceTier: "ultrafast" }));
  const modelFile = join(root, "models.json"); await writeFile(modelFile, JSON.stringify(models));
  const log = join(root, "log.jsonl");
  const store = new CodexSessionStore({ filePath: join(root, "store.json") });
  let account = "a";
  let missing = false;
  const backend = new CodexThreadRuntimeBackend("tau-thread", root, {
    adapter: createCodexRuntimeAdapter("codex@owner"), instance: "owner", store,
    storedModels: async () => models.map(storedModel),
    permissionLevel: () => "full",
    openSession: (input) => CodexAppServer.open({ command: process.execPath, cwd: root,
      env: { ...process.env, ...(account === "a" ? envA : envB), STUB_MODELS: modelFile, STUB_LOG: log, STUB_THREADS: missing && account === "b" ? join(root, "missing") : join((account === "a" ? envA : envB).CODEX_HOME!, "sessions", "threads.json") },
      clientVersion: "test", spawn: (launch) => spawnRpcProcess({ ...launch, args: [stub, ...launch.args] }), onNotification: input.onNotification, onRequest: input.onRequest, onExit: input.onExit }),
  });
  backends.push(backend); await backend.start("create");
  return { backend, store, root, log, envA, envB, change: (next: string) => { account = next; }, account: () => account, missing: () => { missing = true; }, requests: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }) };
}

it("resumes one canonical session across private accounts and preserves the Tau transcript and owner", async () => {
  const h = await harness();
  await h.backend.prompt({ text: "Hello", delivery: "prompt" });
  const session = h.backend.providerSessionId;
  const transcript = await h.backend.transcript();
  await h.backend.switchAccount("b", h.change, "a");
  expect(h.backend.kind).toBe("codex@owner");
  expect(h.backend.providerSessionId).toBe(session);
  expect(await h.backend.transcript()).toEqual(transcript);
  expect(await h.store.get("tau-thread")).toMatchObject({ instance: "owner", accountInstance: "b", codexThreadId: session });
  await h.backend.prompt({ text: "Continue", delivery: "prompt" });
  const requests = await h.requests();
  expect(requests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
  expect(requests.find((entry) => entry.method === "thread/resume")?.params).toMatchObject({ threadId: session, serviceTier: null });
  expect(await readFile(join(h.envA.CODEX_HOME!, "auth.json"), "utf8")).toBe("synthetic A");
  expect(await readFile(join(h.envB.CODEX_HOME!, "auth.json"), "utf8")).toBe("synthetic B");
});

it("rolls back a missing target session without creating a replacement conversation", async () => {
  const h = await harness(); await h.backend.prompt({ text: "Hello", delivery: "prompt" });
  const session = h.backend.providerSessionId;
  h.missing();
  await expect(h.backend.switchAccount("b", h.change, "a")).rejects.toThrow("no rollout");
  expect(h.account()).toBe("a");
  expect(h.backend.providerSessionId).toBe(session);
  expect((await h.store.get("tau-thread"))?.accountInstance).toBeUndefined();
  await h.backend.prompt({ text: "Still here", delivery: "prompt" });
  expect((await h.requests()).filter((entry) => entry.method === "thread/start")).toHaveLength(1);
});

it("uses the provider default unless selected and round trips every catalog tier", async () => {
  const h = await harness();
  expect(h.backend.serviceTierState()).toMatchObject({ selected: null, defaultTier: "ultrafast", choices: expect.arrayContaining([expect.objectContaining({ id: "default", name: "Standard" }), expect.objectContaining({ id: "ultrafast", name: "Ultrafast" }), expect.objectContaining({ id: "future-tier" })]) });
  await h.backend.setServiceTier("ultrafast");
  await h.backend.prompt({ text: "Hello", delivery: "prompt" });
  expect((await h.requests()).find((entry) => entry.method === "thread/start")?.params?.serviceTier).toBe("ultrafast");
  expect((await h.requests()).find((entry) => entry.method === "turn/start")?.params?.serviceTier).toBe("ultrafast");
  await h.backend.setServiceTier("default");
  expect((await h.requests()).filter((entry) => entry.method === "thread/settings/update").at(-1)?.params?.serviceTier).toBe("default");
  await h.backend.setServiceTier("future-tier");
  expect((await h.store.get("tau-thread"))?.serviceTier).toBe("future-tier");
  await h.backend.setServiceTier(null);
  expect((await h.requests()).filter((entry) => entry.method === "thread/settings/update").at(-1)?.params).toMatchObject({ serviceTier: null });
  expect((await h.store.get("tau-thread"))?.serviceTier).toBeUndefined();
  await expect(h.backend.setServiceTier("invented")).rejects.toThrow("do not offer");
});

it("rejects credential and tier changes while a turn is active", async () => {
  const h = await harness();
  const run = h.backend.prompt({ text: "[scenario:interrupt]", delivery: "prompt" });
  while (!h.backend.state().streaming) await new Promise((resolve) => setTimeout(resolve, 5));
  await expect(h.backend.switchAccount("b", h.change, "a")).rejects.toThrow("Wait for Codex");
  await expect(h.backend.setServiceTier("ultrafast")).rejects.toThrow("Wait for Codex");
  expect(h.account()).toBe("a");
  await h.backend.abort(); await run;
});
