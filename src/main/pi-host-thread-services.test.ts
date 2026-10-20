import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { ClientTurnIdentity, UiPromptAttachment } from "../shared/contracts.js";
import type { HostExtension, HostExtensionServices } from "./host-extensions.js";
import { externalThreadPath } from "./pi-host-support.js";
import { PiHost } from "./pi-host.js";
import { ProjectHistory } from "./project-history.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ThreadRuntimeBackend } from "./runtime-types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const adapter: AgentRuntimeAdapter = { id: "fixture", capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } };
const image: UiPromptAttachment = { kind: "image", name: "x.png", mimeType: "image/png", data: "AA==", size: 1 };

/** A released thread of a fixture runtime; `opens` counts how often the host reopened it. */
async function bench(options: { catalogWrite?: boolean; images?: boolean; runtimeEnabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-thread-services-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const [local, agent, sessions] = ["local", "agent", "sessions"].map((name) => join(root, name));
  await Promise.all([local!, agent!, sessions!].map((path) => mkdir(path)));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent!);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessions!);
  vi.stubEnv("TAU_CONFIG_FILE", join(root, "config.json"));
  vi.stubEnv("TAU_THEMES_DIR", join(root, "themes"));
  vi.stubEnv("TAU_PACKAGES_HOME", join(root, "packages"));
  if (options.runtimeEnabled !== undefined) {
    await mkdir(join(local!, ".tau"));
    await writeFile(join(local!, ".tau", "config.json"), JSON.stringify({ runtimeEnabled: { fixture: options.runtimeEnabled } }));
  }
  const calls = { opens: 0, model: [] as string[], titles: [] as string[], prompts: [] as Array<{ text: string; attachments: number; identity?: ClientTurnIdentity }> };
  const open = (threadId: string, cwd: string): ThreadRuntimeBackend => {
    calls.opens += 1;
    let title = "Saved";
    return {
      kind: "fixture", threadId, providerSessionId: threadId, cwd, runtimeAdapter: adapter, turnReporting: "streamed",
      capabilities: options.catalogWrite === false ? {} : { catalogWrite: { setModel: async (provider, id) => { calls.model.push(`${provider}/${id}`); }, setThinkingLevel: async () => undefined } },
      start: async () => undefined, dispose: async () => undefined, waitForIdle: async () => undefined,
      state: () => ({ streaming: false, idle: true, hasMessages: true, title, activeTools: [], supportsImageInput: options.images !== false, extensionCount: 0 }),
      preparePrompt: async (text) => ({ tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: "fixture", runtimeCapabilities: adapter.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []) }),
      prompt: async (input) => { calls.prompts.push({ text: input.text, attachments: input.attachments?.length ?? 0, ...(input.identity ? { identity: input.identity } : {}) }); input.onAdmitted?.(true); return {}; },
      abort: async () => undefined, transcript: async () => [], persist: async () => undefined,
      setTitle: async (next) => { title = next; calls.titles.push(next); },
      catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }), models: async () => [], composerCommands: () => [],
    };
  };
  let services!: HostExtensionServices;
  const kit: HostExtension = {
    id: "test.fixture", name: "Fixture runtime", permissions: ["runtime:extend", "sessions"],
    activate: (context) => {
      services = context.services;
      const record = { threadId: "saved", cwd: local!, title: "Saved", updatedAt: 1, messages: [{ role: "user" as const, text: "hello" }] };
      return context.services.registerRuntimeBackend({
        kind: "fixture", adapter, newThreadCatalog: async () => ({ models: [{ provider: "test", id: "available", name: "Available" }], thinkingLevels: {} }), listThreads: async () => [record],
        lookup: async (threadId) => threadId === "saved" ? record : undefined, composerCommands: () => [], open: async (threadId, cwd) => open(threadId, cwd),
      });
    },
  };
  const history = new ProjectHistory(join(root, "projects.json"));
  await history.load();
  const host = new PiHost(local!, () => undefined, history, false, false, {
    hostExtensions: [kit], kitStateDir: join(root, "kit-state"),
    createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never,
  });
  cleanups.push(() => host.dispose());
  await host.start();
  await expect.poll(() => host.threadPath("saved")).toBe(externalThreadPath("fixture", "saved"));
  return { calls, services: () => services, host, cwd: local! };
}

describe("services that name a thread by id", () => {
  it("exposes the composer catalog and effective project gate to extensions", async () => {
    const b = await bench({ runtimeEnabled: false });
    const services = b.services();
    const choices = await services.runtimeChoices!(b.cwd, "fixture");
    expect(choices).toMatchObject([{ backend: { kind: "fixture" }, enabled: false, readiness: { state: "ready" } }]);
    expect(choices[0]!.catalog).toEqual(await b.host.runtimeCatalog("fixture"));
    expect(choices[0]!.catalog!.models).toMatchObject([{ provider: "test", id: "available" }]);
  });

  it("reopens a released thread when the composer prepares and sends a message", async () => {
    const b = await bench();
    const active = (await b.host.snapshot()).sessionId;
    const prepared = await b.host.preparePrompt("continue", "saved");
    expect(prepared.tauThreadId).toBe("saved");
    await b.host.prompt("continue", [], "saved", undefined, prepared);
    expect(b.calls).toMatchObject({ opens: 1, prompts: [{ text: "continue", attachments: 0 }] });
    expect((await b.host.snapshot()).sessionId).toBe(active);
  });

  it("reopens a released thread once for concurrent prompt preparation", async () => {
    const b = await bench();
    const prepared = await Promise.all([
      b.host.preparePrompt("one", "saved"),
      b.host.preparePrompt("two", "saved"),
    ]);
    expect(prepared.map((prompt) => prompt.tauThreadId)).toEqual(["saved", "saved"]);
    expect(b.calls.opens).toBe(1);
  });

  it("reopens a released thread when a message is sent without preparation", async () => {
    const b = await bench();
    await b.host.prompt("continue", [], "saved");
    expect(b.calls).toMatchObject({ opens: 1, prompts: [{ text: "continue", attachments: 0 }] });
  });

  it("sends a prepared message even when its runtime was released after preparation", async () => {
    const b = await bench();
    const prepared = await b.host.preparePrompt("continue", "saved");
    const threads = (b.host as unknown as { threads: { release(id: string): Promise<void> } }).threads;
    await threads.release("saved");
    await b.host.prompt("continue", [], "saved", undefined, prepared);
    expect(b.calls).toMatchObject({ opens: 2, prompts: [{ text: "continue", attachments: 0 }] });
  });

  it("renames a released thread by reopening it off screen, and a generated title never does", async () => {
    const b = await bench();
    await expect(b.services().setThreadTitle("saved", "Generated", "generated")).rejects.toThrow("not open any more");
    expect(b.calls.opens).toBe(0);
    await b.services().setThreadTitle("saved", "Better name", "renamed");
    expect(b.calls).toMatchObject({ opens: 1, titles: ["Better name"] });
  });

  it("changes the model of a released thread without putting it on screen", async () => {
    const b = await bench();
    await b.services().sessions.setModel!("saved", "openai", "gpt-small");
    expect(b.calls).toMatchObject({ opens: 1, model: ["openai/gpt-small"] });
    expect((await b.host.snapshot()).sessionId).not.toBe("saved");
  });

  it("refuses a model change where the runtime has no model selection", async () => {
    const b = await bench({ catalogWrite: false });
    await expect(b.services().sessions.setModel!("saved", "openai", "gpt-small")).rejects.toThrow("Model selection is not available");
  });

  it("hands images to the thread and refuses them where its model cannot read images", async () => {
    const b = await bench();
    await b.services().sessions.send!("saved", "look", { attachments: [image] });
    expect(b.calls.prompts).toEqual([{ text: "look", attachments: 1 }]);
    const blind = await bench({ images: false });
    await expect(blind.services().sessions.send!("saved", "look", { attachments: [image] })).rejects.toThrow("does not support image input");
    await expect(blind.services().sessions.send!("saved", "look", { delivery: "queue", attachments: [image] })).rejects.toThrow("does not support image input");
    expect(blind.calls.prompts).toEqual([]);
  });

  it("keeps the composer identity through the extension service and the reopened runtime", async () => {
    const b = await bench();
    const identity = { clientTurnId: "turn-1", clientMessageId: "message-1" };
    await b.services().sessions.send!("saved", "look", { attachments: [image], identity });
    expect(b.calls.prompts).toEqual([{ text: "look", attachments: 1, identity }]);
  });

  it("keeps the sender's identity when a queued message reaches the runtime", async () => {
    const b = await bench();
    const identity = { clientTurnId: "queued-turn", clientMessageId: "queued-message" };
    await b.services().sessions.send!("saved", "queued", { delivery: "queue", identity });
    await expect.poll(() => b.calls.prompts).toEqual([{ text: "queued", attachments: 0, identity }]);
  });

  it("gives a runtime without file input the received host-local path, keeping images", async () => {
    const b = await bench();
    const file: UiPromptAttachment = { kind: "file", name: "spec.txt", mimeType: "text/plain", path: join(tmpdir(), "received-spec.txt"), size: 1 };
    await b.services().sessions.send!("saved", "look", { attachments: [file, image] });
    expect(b.calls.prompts).toEqual([{ text: `look\n\nAttached files:\n- ${file.path}`, attachments: 1 }]);
  });
});
