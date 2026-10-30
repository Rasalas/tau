import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpToolProvider, HostThreadLifecycle, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import privateSecretsHost from "./host.js";
import { PRIVATE_SECRETS_ID, type SecretFileBinding, type SecretFilesState } from "./protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-secret-host-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  let provider!: HostMcpToolProvider;
  let observer!: HostTurnObserver;
  let lifecycle!: HostThreadLifecycle;
  const events: unknown[] = [];
  const registry = await activateHostKit(privateSecretsHost(), {
    stateDir,
    mcp: { registerTools: (value) => { provider = value; return () => undefined; }, gate: () => () => undefined, connect: async () => undefined },
    registerTurnObserver: (value) => { observer = value; return () => undefined; },
    registerThreadLifecycle: (value) => { lifecycle = value; return () => undefined; },
  }, (event) => events.push(event));
  cleanups.push(() => registry.deactivate(PRIVATE_SECRETS_ID));
  const call = (command: string, input?: unknown) => registry.invoke(PRIVATE_SECRETS_ID, command, input);
  const tools = async (sessionId = "thread") => provider({ sessionId, cwd: "/project" });
  const state = () => call("state") as Promise<SecretFilesState>;
  return { registry, call, tools, state, events, observer, lifecycle };
}

it("exposes private file tools and accepts values only from this machine's owner", async () => {
  const h = await harness();
  const tools = await h.tools();
  expect(tools.map((tool) => tool.name)).toEqual(["request_secret_file", "release_secret_file"]);
  const answer = tools[0]!.execute("request", { label: "API credential", reason: "Authenticate a CLI", filename: "key.txt" }, undefined, undefined, {} as never);
  const request = (await h.state()).requests[0]!;
  const phone = { kind: "workbench-client", connection: "phone", pairedClient: "phone" } as const;
  await expect(h.registry.invoke(PRIVATE_SECRETS_ID, "submit", { id: request.id, value: "private-test-value" }, phone)).rejects.toMatchObject({ code: "forbidden" });
  expect((await h.state()).requests[0]!.status).toBe("pending");
  await h.call("submit", { id: request.id, value: "private-test-value" });
  const result = await answer;
  const binding = { ...(result.details as SecretFileBinding), path: (result.details as { file: string }).file };
  expect(await readFile(binding.path, "utf8")).toBe("private-test-value");
  expect(JSON.stringify([result, await h.state(), h.events])).not.toContain("private-test-value");
  const otherTools = await h.tools("other-thread");
  await expect(otherTools[1]!.execute("release", { secretRef: binding.secretRef }, undefined, undefined, {} as never)).rejects.toThrow("does not belong");
  await tools[1]!.execute("release", { secretRef: binding.secretRef }, undefined, undefined, {} as never);
  await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["trash"])("removes delivered files on %s", async (event) => {
  const h = await harness();
  const tool = (await h.tools())[0]!;
  const answer = tool.execute("request", { label: "Key", reason: "CLI authentication" }, undefined, undefined, {} as never);
  const request = (await h.state()).requests[0]!;
  await h.call("submit", { id: request.id, value: "private-test-value" });
  const binding = { path: ((await answer).details as { file: string }).file };
  if (event === "trash") await h.lifecycle.beforeRemove!("thread", "/project");
  await vi.waitFor(async () => { await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" }); });
});

it("does not expose an internal lifecycle cleanup as a device command", async () => {
  const h = await harness();
  const phone = { kind: "workbench-client", connection: "phone", pairedClient: "phone" } as const;
  await expect(h.registry.invoke(PRIVATE_SECRETS_ID, "thread-archived", { threadId: "thread" }, phone)).rejects.toThrow("belongs to the thread lifecycle");
});

it("refuses unsafe filenames before asking the user", async () => {
  const h = await harness();
  const tool = (await h.tools())[0]!;
  await expect(tool.execute("request", { label: "Key", reason: "CLI authentication", filename: "../../outside" }, undefined, undefined, {} as never)).rejects.toThrow("without folders");
  expect((await h.state()).requests).toEqual([]);
});

it.each(["stop", "close", "run-end", "reset"])("keeps a delivered lease until expiry across %s", async (event) => {
  const h = await harness();
  const answer = (await h.tools())[0]!.execute("request", { label: "Key", reason: "CLI" }, undefined, undefined, {} as never);
  const request = (await h.state()).requests[0]!;
  await h.call("submit", { id: request.id, value: "synthetic-value" });
  const path = ((await answer).details as { file: string }).file;
  if (event === "stop") await h.observer.stopped!("thread");
  if (event === "close") await h.observer.closed!("thread");
  if (event === "reset") await h.observer.reset!("thread");
  if (event === "run-end") h.observer.runEnded!("thread", "completed");
  expect(await readFile(path, "utf8")).toBe("synthetic-value");
  expect((await h.state()).requests[0]!.status).toBe("ready");
});
