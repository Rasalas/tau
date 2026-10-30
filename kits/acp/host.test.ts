import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { THREAD_TEXTS_COMMAND, type HostBackendOpenContext, type HostRuntimeBackendProvider, type ThreadTextsAnswer, type ThreadTextsRequest } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { AcpSessionStore } from "../_acp/session-store.js";
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

async function searchFixture() {
  const fixture = await harness();
  const stores: AcpSessionStore[] = [];
  const longText = `${"older conversation ".repeat(5_000)}needle after the old prefix`;
  for (const [index, id] of ["first", "second"].entries()) {
    await fixture.registry.invoke(ACP_ID, "save", { id, name: id, command: process.execPath, args: [FAKE, "acp"] });
    const store = new AcpSessionStore({ filePath: join(fixture.root, "state", `${id}-sessions.json`), backendKind: `acp@${id}`, agent: id, now: () => (index + 1) * 100 });
    cleanups.push(() => store.dispose());
    await store.appendMessages(`${id}-thread`, fixture.root, [{ id: `${id}-message`, role: "user", text: index === 0 ? "first agent's conversation" : longText, timestamp: index + 1 }]);
    // Native ids need only be unique within one agent; exported Tau ids stay global.
    await store.setAcpSession(`${id}-thread`, fixture.root, "same-native-session");
    stores.push(store);
  }
  return { ...fixture, first: stores[0]!, second: stores[1]!, longText };
}

async function searchClient(registry: Awaited<ReturnType<typeof activateHostKit>>, id = "tau.search") {
  let read!: (input: ThreadTextsRequest) => Promise<ThreadTextsAnswer>;
  await registry.activate({ id, name: id, activate(context) {
    read = async input => await context.invokeHostExtension(ACP_ID, THREAD_TEXTS_COMMAND, input) as ThreadTextsAnswer;
  } });
  return read;
}

it("exports full histories across agents with stable revisions, bounded pages and global tombstones", async () => {
  const { registry, root, second, longText } = await searchFixture();
  const read = await searchClient(registry);
  const newest = await read({ protocol: 2, limit: 1, knownVersions: { gone: "old" } });
  expect(newest).toMatchObject({ protocol: 2, threads: [], catalog: [{ threadId: "second-thread", updatedAt: 200 }], removed: ["gone"], more: true });
  const entry = newest.catalog![0]!;
  const older = await read({ protocol: 2, limit: 1, knownVersions: { [entry.threadId]: entry.version, gone: "old" } });
  expect(older).toMatchObject({ catalog: [{ threadId: "first-thread", updatedAt: 100 }], removed: ["gone"], more: false });
  const knownVersions = { [entry.threadId]: entry.version, [older.catalog![0]!.threadId]: older.catalog![0]!.version };
  await expect(read({ protocol: 2, knownVersions })).resolves.toMatchObject({ catalog: [], removed: [], more: false });

  const chunks: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = (await read({ protocol: 2, maxChars: 32_000, page: { threadId: entry.threadId, version: entry.version, cursor } })).page!;
    expect(page).toMatchObject({ threadId: entry.threadId, version: entry.version, status: "ok" });
    expect(page.chunks.reduce((total, chunk) => total + chunk.text.length, 0)).toBeLessThanOrEqual(32_000);
    chunks.push(...page.chunks.map(chunk => chunk.text));
    cursor = page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(pages).toBeGreaterThan(2);
  expect(chunks.join("")).toBe(longText);

  // Another writer can change a transcript without changing updatedAt. The
  // exporter must read the database revision, even with a stale lazy catalog.
  await second.appendMessages(entry.threadId, root, [{ id: "follow-up", role: "assistant", text: "new reply", timestamp: 300 }]);
  const changed = (await read({ protocol: 2, knownVersions })).catalog![0]!;
  expect(changed).toMatchObject({ threadId: entry.threadId, updatedAt: entry.updatedAt });
  expect(changed.version).not.toBe(entry.version);
  await expect(read({ protocol: 2, page: { threadId: entry.threadId, version: entry.version } })).resolves.toMatchObject({ page: { status: "changed" } });

  await registry.dispose();
  const restarted = await harness(root);
  const readAgain = await searchClient(restarted.registry);
  await expect(readAgain({ protocol: 2, knownVersions })).resolves.toMatchObject({ catalog: [changed], removed: [], more: false });
  await second.take(entry.threadId);
  const removed = await readAgain({ protocol: 2, knownVersions: { ...knownVersions, [entry.threadId]: changed.version, gone: "old" } });
  expect(removed.catalog).toEqual([]);
  expect(removed.removed.sort()).toEqual(["gone", "second-thread"]);
  await expect(readAgain({ protocol: 2, page: { threadId: entry.threadId, version: changed.version } })).resolves.toMatchObject({ page: { status: "missing", chunks: [], nextCursor: null } });
});

it("bounds legacy prefixes across agents and grants exports only to Search", async () => {
  const { registry } = await searchFixture();
  const read = await searchClient(registry);
  const newest = await read({ limit: 1, known: { gone: 1 } });
  expect(newest).toMatchObject({ threads: [{ threadId: "second-thread", updatedAt: 200 }], removed: ["gone"], more: true });
  expect(newest.threads).toHaveLength(1);
  expect(newest.threads[0]!.messages.reduce((total, message) => total + message.text.length, 0)).toBe(64_000);
  await expect(read({ limit: 1, known: { "second-thread": 200, gone: 1 } })).resolves.toMatchObject({ threads: [{ threadId: "first-thread" }], removed: ["gone"], more: false });
  await expect(read({ known: { "first-thread": 100, "second-thread": 200, gone: 1 } })).resolves.toEqual({ threads: [], removed: ["gone"], more: false });
  const stranger = await searchClient(registry, "acme.stranger");
  await expect(stranger({})).rejects.toThrow(/not allowed/u);
});
