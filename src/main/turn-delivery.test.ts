import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { TurnDelivery, type TurnDeliveryPort } from "./turn-delivery.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

function makeThread(options: { kind?: string; journal?: boolean; turnReporting?: "streamed" | "awaited"; prompt?: (input: never) => Promise<unknown> } = {}) {
  const sent: Array<{ text: string; delivery: string }> = [];
  const backend = {
    kind: options.kind ?? "pi",
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId: "session",
    providerSessionId: "session",
    cwd: "/repo",
    turnReporting: options.turnReporting ?? "streamed",
    capabilities: options.journal === false ? {} : { journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined } },
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0, title: "Named" }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async (text: string) => ({ runtimeText: text, visibleText: text }),
    prompt: options.prompt ?? (async (input: { text: string; delivery: string }) => { sent.push({ text: input.text, delivery: input.delivery }); return {}; }),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return { thread: new ThreadRuntime(backend as never), sent, backend };
}

function makeDelivery(thread: ThreadRuntime, overrides: Partial<TurnDeliveryPort> = {}) {
  const events: HostEvent[] = [];
  const failures: unknown[] = [];
  const port: TurnDeliveryPort = {
    clientTurns: { enqueue: vi.fn(), cancel: vi.fn() } as never,
    clientMessages: { appendMarker: vi.fn(() => true), failIfUnpersisted: vi.fn() } as never,
    turnObservers: { accepted: vi.fn(), prepare: vi.fn(async () => undefined), ended: vi.fn(async () => undefined), cancelled: vi.fn(async () => undefined) } as never,
    turnsInFlight: { record: vi.fn(), clear: vi.fn() } as never,
    projection: { composerCommands: () => [], isExtensionCommand: () => false } as never,
    prompts: { assertBound: vi.fn(), assertImageInput: vi.fn() } as never,
    binding: { settle: vi.fn(async () => undefined) } as never,
    index: { refreshShell: vi.fn(async () => undefined) } as never,
    assertAvailable: () => undefined,
    requireThread: () => thread,
    emit: (event) => { events.push(event); },
    fail: (error) => { failures.push(error); },
    ...overrides,
  };
  return { delivery: new TurnDelivery(port), port, events, failures };
}

describe("TurnDelivery", () => {
  it("appends a marker and hands a steer to a journal-backed runtime", async () => {
    const { thread, sent } = makeThread();
    const { delivery, port } = makeDelivery(thread);
    await delivery.queued("steer", "wait", [], "session", "message");
    expect(sent).toEqual([{ text: "wait", delivery: "steer" }]);
    expect(port.clientMessages.appendMarker).toHaveBeenCalled();
    expect(port.turnObservers.accepted).toHaveBeenCalled();
  });

  it("opens no turn observer for an extension command", async () => {
    const { thread } = makeThread();
    const { delivery, port } = makeDelivery(thread, {
      projection: { composerCommands: () => [], isExtensionCommand: () => true } as never,
    });
    await delivery.queued("followUp", "/reload", [], "session");
    expect(port.turnObservers.accepted).not.toHaveBeenCalled();
  });

  it("fails the marker and cancels the turn when the runtime refuses", async () => {
    const { thread } = makeThread({ prompt: (async () => { throw new Error("refused"); }) as never });
    const { delivery, port, failures } = makeDelivery(thread);
    await expect(delivery.queued("steer", "wait", [], "session", "message")).rejects.toThrow("refused");
    expect(port.clientMessages.failIfUnpersisted).toHaveBeenCalled();
    expect(port.clientTurns.cancel).toHaveBeenCalled();
    expect(port.turnObservers.cancelled).toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });

  it("takes the runtime path for a backend with no host journal", async () => {
    const { thread, sent } = makeThread({ journal: false });
    const { delivery, port } = makeDelivery(thread);
    await delivery.queued("steer", "wait", [], "session");
    expect(sent).toEqual([{ text: "wait", delivery: "steer" }]);
    // No marker, no observer: an attached Pi owns turn and journal alike.
    expect(port.clientMessages.appendMarker).not.toHaveBeenCalled();
    expect(port.turnObservers.accepted).not.toHaveBeenCalled();
  });

  it("brackets an external streamed backend's turn with the observers and refreshes its shell", async () => {
    const { thread, sent } = makeThread({ kind: "external", journal: false });
    const { delivery, port } = makeDelivery(thread);
    await delivery.toRuntime(thread, "work", [], "prompt", { clientTurnId: "t", clientMessageId: "m" });
    expect(sent).toEqual([{ text: "work", delivery: "prompt" }]);
    expect(port.turnObservers.accepted).toHaveBeenCalledWith("session", expect.any(String), { deferBefore: false });
    await delivery.queued("steer", "wait", [], "session");
    expect(port.turnObservers.accepted).toHaveBeenLastCalledWith("session", expect.any(String), { deferBefore: false, expectsInput: false });
    // A steer joins the observed turn: announced, never ended on its own.
    expect(port.turnObservers.ended).toHaveBeenCalledTimes(1);
    expect(port.turnObservers.prepare).toHaveBeenCalledTimes(1);
    // Admission reaches the caller as soon as the backend reports it.
    const admitted = vi.fn();
    const early = makeThread({ kind: "external", journal: false, prompt: (async (input: { onAdmitted?: (accepted: boolean) => void }) => { input.onAdmitted?.(true); await new Promise((resolve) => setTimeout(resolve, 5)); return {}; }) as never });
    const earlyDelivery = makeDelivery(early.thread);
    const run = earlyDelivery.delivery.toRuntime(early.thread, "work", [], "prompt", undefined, undefined, admitted);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(admitted).toHaveBeenCalledWith(true);
    await run;
    expect(port.turnObservers.prepare).toHaveBeenCalled();
    expect(port.turnObservers.ended).toHaveBeenCalledWith("session", expect.any(String), "completed");
    expect(port.turnObservers.cancelled).not.toHaveBeenCalled();
    expect(port.index.refreshShell).toHaveBeenCalledWith(thread, true);
    expect(port.clientTurns.enqueue).toHaveBeenCalled();
  });

  it("cancels the observers' turn when a streamed backend refuses the prompt, and fails it when the run breaks", async () => {
    const refused = makeThread({ kind: "external", journal: false, prompt: (async () => { throw new Error("refused"); }) as never });
    const refusedDelivery = makeDelivery(refused.thread);
    await expect(refusedDelivery.delivery.toRuntime(refused.thread, "work", [], "prompt", { clientTurnId: "t", clientMessageId: "m" })).rejects.toThrow("refused");
    expect(refusedDelivery.port.turnObservers.cancelled).toHaveBeenCalled();
    expect(refusedDelivery.port.turnObservers.ended).not.toHaveBeenCalled();
    expect(refusedDelivery.port.clientTurns.cancel).toHaveBeenCalled();

    const broken = makeThread({ kind: "external", journal: false, prompt: (async (input: { onAdmitted?: (accepted: boolean) => void }) => { input.onAdmitted?.(true); throw new Error("broke"); }) as never });
    const brokenDelivery = makeDelivery(broken.thread);
    await expect(brokenDelivery.delivery.toRuntime(broken.thread, "work", [], "prompt")).rejects.toThrow("broke");
    expect(brokenDelivery.port.turnObservers.ended).toHaveBeenCalledWith("session", expect.any(String), "failed");
    expect(brokenDelivery.port.turnObservers.cancelled).not.toHaveBeenCalled();
  });

  it("brackets an awaited backend's turn with a running status", async () => {
    const { thread, sent } = makeThread({ journal: false, turnReporting: "awaited" });
    const { delivery, events, port } = makeDelivery(thread);
    await delivery.toRuntime(thread, "work", [], "prompt");
    expect(sent).toEqual([{ text: "work", delivery: "prompt" }]);
    expect(events).toEqual([
      { type: "agent-status", sessionId: "session", running: true },
      { type: "agent-status", sessionId: "session", running: false },
    ]);
    expect(port.index.refreshShell).toHaveBeenCalled();
    expect(thread.adapterTitle).toBe("Named");
  });

  it("refuses a request queued behind an abort of the same thread", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { thread } = makeThread({ journal: false, turnReporting: "awaited", prompt: (async () => { await gate; return {}; }) as never });
    const { delivery, events } = makeDelivery(thread);
    const first = delivery.toRuntime(thread, "first", [], "prompt");
    const second = delivery.toRuntime(thread, "second", [], "prompt", { clientTurnId: "turn", clientMessageId: "message" })
      .then(() => undefined, (error: unknown) => error);
    // The first request is already past the generation check; only the queued one is refused.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    thread.adapterAbortGeneration += 1;
    release();
    await first;
    expect(String(await second)).toContain("aborted");
    expect(events).toContainEqual(expect.objectContaining({ type: "user-message-failed", clientMessageId: "message" }));
  });

  it("refuses images for a backend whose adapter cannot carry them", async () => {
    const { thread } = makeThread({ journal: false, turnReporting: "awaited" });
    const { delivery } = makeDelivery(thread);
    const attachment = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "iVBORw==", size: 4 };
    await expect(delivery.toRuntime(thread, "look", [attachment], "prompt")).rejects.toThrow("not supported");
  });
});
