import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { HostBackendOpenContext, HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createAcpHostExtension } from "./host.js";
import { ACP_ID } from "./protocol.js";

const scratch: string[] = []; const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); for (const path of scratch.splice(0)) await rm(path, { force: true, recursive: true }); });
const FAKE = fileURLToPath(new URL("../cursor/fixtures/fake-cursor-agent.mjs", import.meta.url));
async function harness(directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), "tau-generic-acp-")); if (!directory) scratch.push(root);
  const backends = new Map<string, HostRuntimeBackendProvider>();
  const registry = await activateHostKit(createAcpHostExtension({ env: { ...process.env, CURSOR_DATA_DIR: join(root, "fake-cursor") } }), {
    stateDir: join(root, "state"), sessionsDir: join(root, "sessions"),
    findCommand: command => command === process.execPath ? process.execPath : undefined,
    registerRuntimeBackend: provider => { backends.set(provider.kind, provider); return () => { backends.delete(provider.kind); }; },
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async () => undefined },
  });
  cleanups.push(() => registry.dispose());
  return { root, registry, backends };
}
const context: HostBackendOpenContext = { projectName: "Test", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) };
it("registers Muse and persists a manually configured runtime across restarts", async () => {
  const first = await harness();
  expect(first.backends.get("acp@muse")?.label).toBe("Muse Code");
  await first.registry.invoke(ACP_ID, "save", { id: "test-agent", name: "Test agent", command: process.execPath, args: [FAKE, "acp"] });
  const backend = await first.backends.get("acp@test-agent")!.open("test-thread", first.root, { resume: false }, context);
  try {
    const reply = await backend.prompt({ text: "ping", delivery: "prompt" });
    expect(reply.assistantText).toContain("pong");
    expect((await backend.transcript()).map(message => message.role)).toEqual(["user", "assistant"]);
  } finally { await backend.dispose(); }
  await expect(first.registry.invoke(ACP_ID, "save", { id: "test-agent", name: "Changed", command: process.execPath, args: [] })).rejects.toThrow(/saved threads/u);
  await first.registry.dispose(); cleanups.pop();
  const second = await harness(first.root);
  const restored = await second.backends.get("acp@test-agent")!.lookup("test-thread");
  expect(restored?.messages).toHaveLength(2);
  expect(restored?.cwd).toBe(first.root);
});
