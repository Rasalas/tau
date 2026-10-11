import { describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { TauConfig } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";
import { RuntimeGate } from "./runtime-gate.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

const OFF = "/projects/off";
const ON = "/projects/on";
/** The refusal every path shows for `codex` in `/projects/off`. */
const MESSAGE = "Codex is turned off for “off”. Turn it on under Settings → Providers, with Applies to set to the project.";

/** A live thread of the `codex` kind that records what reached it. */
function fakeThread(threadId: string, cwd: string, delivered: string[]): ThreadRuntime {
  const backend = {
    kind: "codex" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd,
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
      fork: { runtimeOwned: false },
      resume: { hiddenPrompt: false },
    },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: "codex" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities, visibleText: text, runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; delivery?: string; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push(`${threadId}:${input.delivery ?? "prompt"}:${input.text}`);
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({ streaming: false, idle: true, hasMessages: true, sessionFile: `/${threadId}.jsonl`, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never, { session: { sessionId: threadId, abort: async () => undefined, dispose: async () => undefined }, dispose: async () => undefined } as never);
}

/** A host with a thread in a project that turned `codex` off and one in a project that did not. */
function bench() {
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined };
  const host = new PiHost(ON, () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.rememberProject = async () => {};
  internals.index.refreshShell = async () => {};
  internals.index.refresh = async () => {};
  internals.prewarm.scheduleThreads = () => {};
  internals.prewarm.scheduleSpare = () => {};
  const configs: Record<string, TauConfig> = { [OFF]: { runtimeEnabled: { codex: false } }, [ON]: { runtimeEnabled: { codex: true } } };
  const gate = new RuntimeGate({
    config: (path) => (path ? configs[path] : undefined) ?? {},
    // A worktree of the off project follows it.
    owner: async (cwd) => cwd.startsWith(OFF) ? OFF : cwd,
    label: (kind) => kind === "codex" ? "Codex" : kind,
    projectName: (path) => path.split("/").pop() ?? path,
    projectPaths: () => [OFF, ON],
  });
  // The gate the host's components built is the one every path asks.
  internals.prompts.port.runtimeGate = gate;
  const off = fakeThread("off", OFF, delivered);
  const worktree = fakeThread("worktree", `${OFF}-wt`, delivered);
  const on = fakeThread("on", ON, delivered);
  for (const [id, cwd, runtime] of [["off", OFF, off], ["worktree", OFF, worktree], ["on", ON, on]] as const) {
    internals.threads.adopt({ threadId: id, cwd, runtime, isolation: "in-process" });
  }
  internals.threads.setActive("on");
  internals.cwd = ON;
  return { host, internals, delivered, off, worktree, on };
}

describe("a runtime a project turned off (ADR 0032)", () => {
  it("refuses a send there and still sends in the project that kept it", async () => {
    const { host, delivered } = bench();
    await expect(host.prompt("hello", [], "off")).rejects.toThrow(MESSAGE);
    expect(delivered).toEqual([]);
    await host.prompt("hello", [], "on");
    expect(delivered).toEqual(["on:prompt:hello"]);
  });

  it("refuses a steer and a follow-up", async () => {
    const { host, delivered } = bench();
    await expect(host.steer("now", [], "off")).rejects.toThrow(MESSAGE);
    await expect(host.followUp("later", [], "off")).rejects.toThrow(MESSAGE);
    expect(delivered).toEqual([]);
  });

  it("refuses a message queued from the composer or by a kit, and a queued one at delivery", async () => {
    const { host, delivered } = bench();
    await expect(host.queue.submit("off", { text: "from the composer", attachments: [] })).rejects.toThrow(MESSAGE);
    await expect(host.queue.submit("on", { text: "from the composer", attachments: [] })).resolves.toMatchObject({ text: "from the composer" });
    await vi.waitFor(() => { expect(delivered).toEqual(["on:prompt:from the composer"]); });
    delivered.length = 0;
    for (const delivery of ["prompt", "steer", "queue"] as const) {
      await expect(host.sendToThread("off", "from a kit", delivery)).rejects.toThrow(MESSAGE);
    }
    expect(host.queue.list("off")).toEqual([]);
    await expect((host as unknown as { deliverQueued(id: string, message: unknown): Promise<void> }).deliverQueued("off", { id: "q", text: "waiting", attachments: [], queuedAt: 0 })).rejects.toThrow(MESSAGE);
    expect(delivered).toEqual([]);
  });

  it("holds a queued message the switch caught, instead of sending it", async () => {
    const { host, delivered } = bench();
    host.queue.add("off", { text: "waiting", attachments: [] });
    await vi.waitFor(() => { expect(host.queue.isHeld("off")).toBe(true); });
    expect(host.queue.list("off").map((message) => message.text)).toEqual(["waiting"]);
    expect(delivered).toEqual([]);
  });

  it("follows a worktree to the project it was made from", async () => {
    const { host, delivered } = bench();
    await expect(host.prompt("hello", [], "worktree")).rejects.toThrow(MESSAGE);
    expect(delivered).toEqual([]);
  });

  it("refuses a thread an extension starts before it builds a runtime", async () => {
    const { host, internals } = bench();
    internals.runtimes.open = vi.fn();
    internals.runtimes.openExternal = vi.fn();
    internals.seam.backends.set("codex", { kind: "codex", label: "Codex" });
    await expect(host.startThread({ cwd: OFF, prompt: "work", backend: "codex" })).rejects.toThrow(MESSAGE);
    expect(internals.runtimes.openExternal).not.toHaveBeenCalled();
  });

  it("rejects a new thread's submission with the message and keeps the draft", async () => {
    const { host, internals } = bench();
    internals.runtimes.openExternal = vi.fn();
    internals.seam.backends.set("codex", { kind: "codex", label: "Codex", adapter: PI_AGENT_RUNTIME_ADAPTER });
    const result = await host.newSession("hello", [], OFF, undefined, { backendKind: "codex", sessionId: "draft" } as never);
    expect((result as { submission?: unknown }).submission).toEqual({ accepted: false, message: MESSAGE });
    expect(internals.runtimes.openExternal).not.toHaveBeenCalled();
  });

  it("refuses a fork and a duplicate of its thread", async () => {
    const { host, internals, off } = bench();
    internals.requireActive = () => off;
    await expect(host.forkThread("entry", "off")).rejects.toThrow(MESSAGE);
    await expect(host.forkThread("entry", "off", `${OFF}-wt`)).rejects.toThrow(MESSAGE);
  });

  it("marks a thread a restart cut short as interrupted instead of continuing it", async () => {
    const { internals, delivered } = bench();
    internals.continueThreadsAfterRestart = () => true;
    internals.repairDanglingToolCalls = async () => 0;
    const setInterrupted = vi.fn();
    internals.index.setInterrupted = setInterrupted;
    const turn = (sessionId: string, cwd: string) => ({ sessionId, cwd, turnId: `turn-${sessionId}`, backend: "codex", startedAt: 1, prompt: { text: "work" } });
    await internals.reconcileInterruptedTurns([turn("off", OFF), turn("on", ON)]);
    expect(setInterrupted).toHaveBeenCalledWith("off", true);
    expect(setInterrupted).not.toHaveBeenCalledWith("on", true);
    expect(delivered.filter((entry) => entry.startsWith("off:"))).toEqual([]);
    expect(delivered.some((entry) => entry.startsWith("on:"))).toBe(true);
  });
});
