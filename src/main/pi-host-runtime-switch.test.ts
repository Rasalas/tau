import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { ProjectHistory } from "./project-history.js";
import type { HostBackendOpenContext, HostExtension, HostExtensionServices } from "./host-extensions.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ThreadBackendPromptInput, ThreadRuntimeBackend } from "./runtime-types.js";
import { externalThreadPath } from "./pi-host-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function bench() {
  const root = await mkdtemp(join(tmpdir(), "tau-switch-runtime-")); cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const cwd = join(root, "repo"); await mkdir(cwd);
  for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), TAU_CONFIG_FILE: join(root, "config.json"), TAU_PACKAGES_HOME: join(root, "packages"), TAU_THEMES_DIR: join(root, "themes") })) vi.stubEnv(key, value);
  const records = new Map([ ["first", new Map<string, UiMessage[]>([["saved", [{ id: "original", role: "user", text: "Original context", timestamp: 1 }]]])], ["second", new Map<string, UiMessage[]>()] ]);
  const received: Array<{ kind: string; input: ThreadBackendPromptInput }> = [];
  let rejectActivation = false;
  let services!: HostExtensionServices;
  const kit: HostExtension = { id: "test.switch", name: "Runtime fixtures", permissions: ["runtime:extend", "sessions"], activate(context) {
    services = context.services;
    context.services.registerThreadLifecycle({ beforeActivate: async thread => { if (rejectActivation && thread.backendKind === "second") throw new Error("fixture activation refused"); } });
    const stops = [...records].map(([kind, sessions]) => {
      const adapter: AgentRuntimeAdapter = { id: kind, capabilities: { skillInvocationDialect: "acp" }, transport: { sendPrompt: async () => ({}) } };
      const record = (id: string) => ({ threadId: id, cwd, title: "Conversation", updatedAt: 1, messages: sessions.get(id) ?? [] });
      return context.services.registerRuntimeBackend({ kind, label: kind, adapter, composerCommands: () => [], listThreads: async () => [...sessions.keys()].map(record), lookup: async id => sessions.has(id) ? record(id) : undefined,
        removeThread: async id => { const value = sessions.get(id); sessions.delete(id); return value; },
        newThreadCatalog: async () => ({ models: [], thinkingLevels: {} }),
        open: async (id, _cwd, _options, callbacks: HostBackendOpenContext): Promise<ThreadRuntimeBackend> => {
          if (!sessions.has(id)) sessions.set(id, []);
          return { kind, threadId: id, cwd, providerSessionId: `${kind}-session`, runtimeAdapter: adapter, turnReporting: "streamed", capabilities: {}, start: async () => undefined, dispose: async () => undefined, waitForIdle: async () => undefined, abort: async () => undefined,
            state: () => ({ streaming: false, idle: true, hasMessages: Boolean(sessions.get(id)?.length), title: "Conversation", activeTools: [], supportsImageInput: false, extensionCount: 0 }),
            transcript: async () => [...sessions.get(id)!], persist: async () => undefined, setTitle: async () => undefined, models: async () => [], composerCommands: () => [], catalogView: () => ({ thinkingLevel: "default", thinkingLevels: [], allTools: [] }),
            preparePrompt: async text => ({ backendKind: kind, tauThreadId: id, providerSessionId: `${kind}-session`, runtimeCapabilities: adapter.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []) }),
            prompt: async input => {
              received.push({ kind, input }); callbacks.onEvent({ type: "turn-started" }); input.onAdmitted?.(true);
              for (const message of [{ id: `${kind}-${Date.now()}-user`, role: "user" as const, text: input.text, timestamp: Date.now() }, { id: `${kind}-${Date.now()}-assistant`, role: "assistant" as const, text: `Reply from ${kind}`, timestamp: Date.now() }]) { sessions.get(id)!.push(message); callbacks.onMessage(message); }
              callbacks.onEvent({ type: "turn-settled", status: "completed" }); return {};
            },
          };
        },
      });
    });
    return () => { for (const stop of stops) stop(); };
  } };
  const history = new ProjectHistory(join(root, "projects.json")); await history.load();
  const makeHost = async () => {
    const host = new PiHost(cwd, () => undefined, history, false, false, { dataFolder: root, defaultBackendKind: "first", hostExtensions: [kit], kitStateDir: join(root, "kits"), createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never });
    await host.start(); cleanups.push(() => host.dispose()); return host;
  };
  return { host: await makeHost(), makeHost, received, services: () => services, rejectActivation: () => { rejectActivation = true; } };
}
it("switches a conversation in place, retains history after restart, and can switch back", async () => {
  const b = await bench(); await b.host.switchSession(externalThreadPath("first", "saved"));
  await b.host.switchThreadRuntime("saved", "second");
  expect(await b.host.snapshot()).toMatchObject({ sessionId: "saved", backendKind: "second", messages: [expect.objectContaining({ text: "Original context" })] });
  await b.host.prompt("Continue", [], "saved");
  await expect.poll(async () => (await b.host.snapshot()).messages.length).toBe(3);
  expect(b.received[0]).toMatchObject({ kind: "second", input: { text: "Continue", continuationContext: "user: Original context" } });
  await b.host.dispose(); cleanups.pop();
  const restarted = await b.makeHost(); await restarted.switchSession(externalThreadPath("second", "saved"));
  expect((await restarted.snapshot()).messages).toHaveLength(3);
  expect(restarted.threadIndexSnapshot().sessions.filter(session => session.id === "saved")).toHaveLength(1);
  await restarted.switchThreadRuntime("saved", "first");
  expect(await restarted.snapshot()).toMatchObject({ sessionId: "saved", backendKind: "first" });
  expect((await restarted.snapshot()).messages).toHaveLength(3);
  await restarted.prompt("Back", [], "saved");
  await expect.poll(async () => (await restarted.snapshot()).messages.length).toBe(5);
  expect(b.received.at(-1)?.input.continuationContext).toContain("Reply from second");
});

it("keeps the conversation when switching through a fresh Pi segment", async () => {
  const b = await bench(); await b.host.switchSession(externalThreadPath("first", "saved"));
  await b.host.switchThreadRuntime("saved", "pi");
  expect(await b.host.snapshot()).toMatchObject({ sessionId: "saved", backendKind: "pi", messages: [expect.objectContaining({ text: "Original context" })] });
  await b.host.switchThreadRuntime("saved", "second");
  expect(await b.host.snapshot()).toMatchObject({ sessionId: "saved", backendKind: "second", messages: [expect.objectContaining({ text: "Original context" })] });
});

it("exports inherited context and the latest persisted Pi segment without reopening the thread", async () => {
  const b = await bench(); await b.host.switchSession(externalThreadPath("first", "saved"));
  await b.host.switchThreadRuntime("saved", "second");
  await b.host.prompt("External inherited history", [], "saved");
  await expect.poll(async () => (await b.host.snapshot()).messages.length).toBe(3);
  await b.host.switchThreadRuntime("saved", "pi");
  const conversations = b.services().conversations!;
  const [before] = await conversations.list();
  expect(before).toMatchObject({ sessionId: "saved", path: expect.stringContaining("runtime-segments") });
  await appendFile(before!.path, JSON.stringify({ type: "message", id: "new-pi-turn", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Unique Pi segment phrase" }], timestamp: Date.now() } }) + "\n");
  const [summary] = await conversations.list();
  expect(summary!.version).not.toBe(before!.version);
  const contents: string[] = [];
  let cursor: import("../shared/transcript-cursor.js").HostTranscriptCursor | undefined;
  for (;;) {
    const answer = await conversations.page("saved", summary!.version, cursor);
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") throw new Error(answer.status);
    contents.push(...answer.page.messages.map(message => message.text));
    if (!answer.page.hasMore) break;
    cursor = answer.page.olderCursor;
  }
  expect(contents).toEqual(expect.arrayContaining(["Original context", "External inherited history", "Unique Pi segment phrase"]));
  // The live runtime did not reload the independently persisted fixture entry.
  expect((await b.host.snapshot()).messages.some(message => message.text === "Unique Pi segment phrase")).toBe(false);
});

it("restores the source when target activation fails", async () => {
  const b = await bench(); await b.host.switchSession(externalThreadPath("first", "saved"));
  b.rejectActivation();
  await expect(b.host.switchThreadRuntime("saved", "second")).rejects.toThrow("fixture activation refused");
  expect(await b.host.snapshot()).toMatchObject({ sessionId: "saved", backendKind: "first", messages: [expect.objectContaining({ text: "Original context" })] });
  await b.host.prompt("Still usable", [], "saved");
  await expect.poll(async () => (await b.host.snapshot()).messages.length).toBe(3);
});
