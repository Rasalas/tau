import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostBackendOpenContext, HostExtension } from "./host-extensions.js";
import { PiHost } from "./pi-host.js";
import { ProjectHistory } from "./project-history.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ThreadRuntimeBackend } from "./runtime-types.js";
import { LIMIT_CONTINUATION_PROMPT, RESUME_MARGIN_MS } from "./thread-limits.js";
import { RESTART_CONTINUATION_PROMPT } from "./turn-reconciliation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
const adapter: AgentRuntimeAdapter = { id: "recovery-fixture", capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } };

/** Real host startup and stores, with only the runtime provider replaced. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-host-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const cwd = join(root, "project");
  await Promise.all([cwd, join(root, "agent"), join(root, "sessions")].map((path) => mkdir(path)));
  for (const [key, path] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_CODING_AGENT_SESSION_DIR: "sessions", TAU_CONFIG_FILE: "config.json", TAU_THEMES_DIR: "themes", TAU_PACKAGES_HOME: "packages" })) vi.stubEnv(key, join(root, path));
  vi.stubEnv("TAU_NO_WATCH", "1");
  vi.stubEnv("TAU_NO_RUNTIME_UPDATES", "1");
  const start = async () => {
    const delivered: Array<{ text: string; hidden: boolean }> = [];
    let streaming = false;
    const attempts: string[] = [];
    let admissionGate: Promise<void> | undefined;
    let rejectAdmission: (() => void) | undefined;
    const blockNextAdmission = () => {
      admissionGate = new Promise<void>((_resolve, reject) => { rejectAdmission = () => reject(new Error("Fixture runtime stopped before admission")); });
    };
    let events!: HostBackendOpenContext;
    const idleWaiters = new Set<() => void>();
    const kit: HostExtension = {
      id: "test.recovery", name: "Recovery fixture", permissions: ["runtime:extend"],
      activate: ({ services }) => {
        const record = { threadId: "saved", cwd, title: "Saved", updatedAt: 1, messages: [{ role: "user" as const, text: "earlier" }] };
        return services.registerRuntimeBackend({
          kind: adapter.id, adapter, listThreads: async () => [record], lookup: async (id) => id === "saved" ? record : undefined, composerCommands: () => [],
          open: async (threadId, workspace, _options, context): Promise<ThreadRuntimeBackend> => {
            events = context;
            return {
              kind: adapter.id, runtimeAdapter: adapter, threadId, providerSessionId: threadId, cwd: workspace, turnReporting: "streamed",
              capabilities: { resume: { hiddenPrompt: true } },
              start: async () => undefined, dispose: async () => undefined,
              waitForIdle: async () => { if (streaming) await new Promise<void>((resolve) => idleWaiters.add(resolve)); },
              state: () => ({ streaming, idle: !streaming, hasMessages: true, title: "Saved", activeTools: [], supportsImageInput: true, extensionCount: 0 }),
              preparePrompt: async (text) => ({ tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: adapter.id, runtimeCapabilities: adapter.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: text }),
              prompt: async (input) => {
                attempts.push(input.text);
                if (admissionGate) { const gate = admissionGate; admissionGate = undefined; await gate; }
                delivered.push({ text: input.text, hidden: input.hidden === true });
                streaming = true;
                input.onAdmitted?.(true);
                await new Promise<void>((resolve) => idleWaiters.add(resolve));
                return {};
              },
              abort: async () => { rejectAdmission?.(); streaming = false; for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); },
              transcript: async () => [], persist: async () => undefined, setTitle: async () => undefined,
              catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }), models: async () => [], composerCommands: () => [],
            };
          },
        });
      },
    };
    const history = new ProjectHistory(join(root, "projects.json"));
    await history.load();
    const host = new PiHost(cwd, () => undefined, history, false, false, {
      defaultBackendKind: adapter.id, hostExtensions: [kit], kitStateDir: join(root, "kit-state"),
      queuedMessagesPath: join(root, "queue.json"), threadLimitsPath: join(root, "limits.json"), turnsInFlightPath: join(root, "turns.json"),
      createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never,
    });
    let disposed = false;
    const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); } };
    cleanups.push(dispose);
    await host.start();
    const settle = (error?: string, resetsAt?: number) => {
      streaming = false;
      events.onEvent({ type: "turn-settled", status: error ? "error" : "completed", ...(error ? { error, limit: { resetsAt } } : {}) });
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    };
    return { host, delivered, attempts, blockNextAdmission, settle, dispose, texts: () => delivered.map((entry) => entry.text) };
  };
  return { root, cwd, start };
}

describe("host durable recovery through public operations", () => {
  it("retains the queue head across restart when a later add persists during blocked admission", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "head awaiting admission", attachments: [] });
    await first.host.queue.flush();
    first.blockNextAdmission();
    first.settle();
    await expect.poll(() => first.attempts).toEqual(["running", "head awaiting admission"]);
    first.host.queue.add("saved", { text: "later follow-up", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({
      held: true, messages: [{ text: "head awaiting admission" }, { text: "later follow-up" }],
    });
    expect(second.texts()).toEqual([]);
  });

  it("retains one copy of a rejected queue head after restart", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "reject this admission", attachments: [] });
    first.host.queue.add("saved", { text: "later follow-up", attachments: [] });
    await first.host.queue.flush();
    first.blockNextAdmission();
    first.settle();
    await expect.poll(() => first.attempts).toEqual(["running", "reject this admission"]);
    await first.host.abort("saved");
    await expect.poll(() => first.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "reject this admission" }, { text: "later follow-up" }] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "reject this admission" }, { text: "later follow-up" }] });
  });

  it("does not recover a new prompt accepted while the startup index is loading", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    await writeFile(join(f.root, "queue.json"), JSON.stringify({ version: 1, threads: { saved: [{ id: "retained", text: "older follow-up", attachments: [], queuedAt: 1 }] } }));
    const b = await f.start();
    await b.host.prompt("newly accepted work", [], "saved");
    await expect.poll(() => b.host.queue.view("saved")?.messages.length).toBe(1);
    expect(b.texts()).toEqual(["newly accepted work"]);
  });

  it("holds a limited queue through restart until its scheduled reset continuation settles", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("limited job", [], "saved");
    first.host.queue.add("saved", { text: "after reset", attachments: [] });
    first.settle("Usage limit reached", Date.now() + 60_000);
    expect(first.host.queue.view("saved")?.held).toBe(true);
    const scheduled = first.host.limits.resumeAtReset("saved");
    await first.host.queue.flush();
    await first.host.limits.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.limits.get("saved")?.resumeAt).toBe(scheduled.resumeAt);
    expect(second.host.queue.view("saved")?.held).toBe(true);
    expect(second.texts()).toEqual([]);
    // Only the timer is fake. Store reads and runtime admission remain real.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      // Re-arm through the public operation so the restored reset uses this clock.
      second.host.limits.resumeAtReset("saved");
      await vi.advanceTimersByTimeAsync(120_000 + RESUME_MARGIN_MS);
      expect(second.delivered).toEqual([{ text: LIMIT_CONTINUATION_PROMPT, hidden: true }]);
    } finally { vi.useRealTimers(); }
    second.settle();
    await expect.poll(second.texts).toEqual([LIMIT_CONTINUATION_PROMPT, "after reset"]);
    await second.host.queue.flush();
  });

  it("continues interrupted work before its retained follow-ups", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    const first = await f.start();
    await first.host.prompt("unfinished job", [], "saved");
    first.host.queue.add("saved", { text: "after continuation", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(second.texts).toEqual([RESTART_CONTINUATION_PROMPT]);
    await expect.poll(() => second.host.queue.view("saved")?.held).toBe(false);
    expect(second.delivered).toEqual([{ text: RESTART_CONTINUATION_PROMPT, hidden: true }]);
    second.settle();
    await expect.poll(second.texts).toEqual([RESTART_CONTINUATION_PROMPT, "after continuation"]);
    await second.host.queue.flush();
  });

  it("holds accepted follow-ups after restart, then sends the retained order exactly once", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "first follow-up", attachments: [] });
    first.host.queue.add("saved", { text: "second follow-up", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "first follow-up" }, { text: "second follow-up" }] });
    second.settle();
    expect(second.texts()).toEqual([]);
    await second.host.prompt("resume explicitly", [], "saved");
    second.settle();
    second.settle();
    await expect.poll(second.texts).toEqual(["resume explicitly", "first follow-up"]);
    second.settle();
    await expect.poll(second.texts).toEqual(["resume explicitly", "first follow-up", "second follow-up"]);
    expect(second.host.queue.view("saved")).toBeUndefined();
    await second.host.queue.flush();
  });
});
