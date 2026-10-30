import { describe, expect, it, vi } from "vitest";
import type { PiKitBridge, PiKitTranscriptMessage } from "tau/host-extension";
import threadTitlesPiExtension from "./pi.js";
import { TITLE_SYSTEM_PROMPT, TITLE_INSTRUCTIONS_LIMIT, titleSystemPrompt } from "./protocol.js";

function harness(transcript: PiKitTranscriptMessage[]) {
  const commands = new Map<string, (ctx: any, input: Record<string, unknown>) => Promise<unknown>>();
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  let sessionName: string | undefined;
  let idle = false;
  let current = true;
  let sessionId = "session";
  const complete = vi.fn(async (_model: unknown, request: { systemPrompt: string }) => ({ request, stopReason: "stop", content: [{ type: "text", text: "Automatic thread titles" }] }));
  const context = {
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { find: () => ({ provider: "provider", id: "model", name: "Model" }), complete },
  };
  const bridge = {
    extensionId: "tau.thread-titles",
    registerCommand: (name: string, handler: any) => commands.set(name, handler),
    publishEvent: vi.fn(),
    refreshSnapshot: vi.fn(),
    pinEntries: vi.fn(),
    observeUserTurns: vi.fn(),
    transcript: () => transcript,
    openSession: () => undefined,
    isCurrentSession: () => current,
  } satisfies PiKitBridge as unknown as PiKitBridge;
  const pi = {
    on: (name: string, handler: any) => events.set(name, handler),
    getSessionName: () => sessionName,
    setSessionName: vi.fn((title: string) => { sessionName = title; }),
  };
  threadTitlesPiExtension(pi as never, bridge);
  return { commands, events, context, pi, bridge, complete, setCurrent: (value: boolean) => { current = value; }, setSessionId: (value: string) => { sessionId = value; }, setIdle: (value: boolean) => { idle = value; } };
}

const conversation: PiKitTranscriptMessage[] = [{ role: "user", content: [{ type: "text", text: "Fix automatic titles" }] }];

describe("thread titles inside an attached Pi runtime", () => {
  it("preserves a manual rename during the title request", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    kit.complete.mockImplementationOnce(async (_model, request) => {
      kit.pi.setSessionName("Mein Titel");
      return { request, stopReason: "stop", content: [{ type: "text", text: "Generated title" }] };
    });
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model" })).resolves.toBeUndefined();
    expect(kit.pi.getSessionName()).toBe("Mein Titel");
  });
  it("waits for the run to settle before titling the thread", async () => {
    const kit = harness(conversation);
    const generated = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", force: false });
    await Promise.resolve();
    expect(kit.complete).not.toHaveBeenCalled();

    kit.setIdle(true);
    // Pi supplies a fresh ExtensionContext for each event of the same session.
    await kit.events.get("agent_settled")!({}, { ...kit.context });

    await expect(generated).resolves.toEqual({ title: "Automatic thread titles" });
    expect(kit.pi.setSessionName).toHaveBeenCalledWith("Automatic thread titles");
    // Both halves ask with the kit's one prompt, whoever owns the runtime.
    expect(kit.complete.mock.calls[0]?.[1]).toMatchObject({ systemPrompt: TITLE_SYSTEM_PROMPT });
  });

  it("refuses a forced title while the run is active", async () => {
    const kit = harness(conversation);
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", force: true }))
      .rejects.toThrow(/Wait for the active agent run/u);
  });

  it("rejects a pending title when the Pi session goes away", async () => {
    const kit = harness(conversation);
    const generated = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model" });
    kit.events.get("session_shutdown")!({}, kit.context);
    await expect(generated).rejects.toThrow(/session changed/u);
  });

  it("uses the shared prompt for custom instructions after waiting for the run", async () => {
    const kit = harness(conversation);
    const generated = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "  Use German.\r\nLead with TAU-42.  " });
    kit.setIdle(true);
    await kit.events.get("agent_settled")!({}, kit.context);
    await generated;
    expect(kit.complete.mock.calls[0]?.[1]).toMatchObject({ systemPrompt: titleSystemPrompt("Use German.\nLead with TAU-42.") });
  });

  it("applies a host-requested title only after its matching approval and refreshes the snapshot", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "Use German.", requestId: "request-1", deferApply: true })).resolves.toEqual({ pending: true });
    await expect(kit.commands.get("result")!({ ...kit.context }, { requestId: "request-1" })).resolves.toEqual({ title: "Automatic thread titles" });
    expect(kit.pi.setSessionName).not.toHaveBeenCalled();
    await expect(kit.commands.get("apply")!(kit.context, { requestId: "stale-request" })).resolves.toBeUndefined();
    expect(kit.pi.setSessionName).not.toHaveBeenCalled();
    await expect(kit.commands.get("apply")!(kit.context, { requestId: "request-1" })).resolves.toEqual({ title: "Automatic thread titles" });
    expect(kit.pi.setSessionName).toHaveBeenCalledOnce();
    expect(kit.bridge.refreshSnapshot).toHaveBeenCalledWith(kit.context);
    await expect(kit.commands.get("apply")!(kit.context, { requestId: "request-1" })).resolves.toBeUndefined();
  });


  it("keeps a rename that arrived between completion and the host's apply command", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    await kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", requestId: "request", deferApply: true });
    kit.pi.setSessionName("Manual rename");
    await expect(kit.commands.get("apply")!(kit.context, { requestId: "request" })).resolves.toBeUndefined();
    expect(kit.pi.getSessionName()).toBe("Manual rename");
  });

  it("prevents an older in-flight regeneration from replacing the newest one", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    let finishFirst!: () => void;
    kit.complete.mockImplementationOnce((_model, request) => new Promise((resolve) => {
      finishFirst = () => resolve({ request, stopReason: "stop", content: [{ type: "text", text: "Obsolete title" }] });
    }));
    const first = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", force: true });
    await kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", force: true });
    finishFirst();
    await expect(first).resolves.toBeUndefined();
    expect(kit.pi.setSessionName).toHaveBeenCalledExactlyOnceWith("Automatic thread titles");
  });

  it("preserves a native title even when custom instructions are supplied", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    kit.pi.setSessionName("Native title");
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "Use German." })).resolves.toBeUndefined();
    expect(kit.complete).not.toHaveBeenCalled();
  });

  it.each(["rename", "session", "context", "shutdown"])("discards a title when %s changes during inference, including forced regeneration", async (change) => {
    const kit = harness(conversation);
    kit.setIdle(true);
    kit.pi.setSessionName("Original title");
    kit.pi.setSessionName.mockClear();
    kit.complete.mockImplementationOnce(async (_model, request) => {
      if (change === "rename") kit.pi.setSessionName("Manual title");
      if (change === "session") kit.setSessionId("other-session");
      if (change === "context") kit.setCurrent(false);
      if (change === "shutdown") kit.events.get("session_shutdown")!({}, kit.context);
      return { request, stopReason: "stop", content: [{ type: "text", text: "Obsolete title" }] };
    });
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", force: true })).resolves.toBeUndefined();
    expect(kit.pi.setSessionName).not.toHaveBeenCalledWith("Obsolete title");
  });

  it("replaces queued instructions and ignores cancellation of the old request", async () => {
    const kit = harness(conversation);
    const first = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "Use English.", requestId: "old", deferApply: true });
    const second = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "Use German.", requestId: "new", deferApply: true });
    await expect(first).resolves.toEqual({ pending: true });
    await expect(kit.commands.get("result")!(kit.context, { requestId: "old" })).resolves.toBeUndefined();
    await kit.commands.get("cancel")!(kit.context, { requestId: "old" });
    kit.setIdle(true);
    await kit.events.get("agent_settled")!({}, { ...kit.context });
    await expect(second).resolves.toEqual({ pending: true });
    await expect(kit.commands.get("result")!(kit.context, { requestId: "new" })).resolves.toEqual({ title: "Automatic thread titles" });
    expect(kit.complete.mock.calls[0]?.[1]).toMatchObject({ systemPrompt: titleSystemPrompt("Use German.") });
    expect(kit.pi.setSessionName).not.toHaveBeenCalled();
    await kit.commands.get("cancel")!(kit.context, { requestId: "new" });
    await expect(kit.commands.get("apply")!(kit.context, { requestId: "new" })).resolves.toBeUndefined();
    expect(kit.pi.setSessionName).not.toHaveBeenCalled();
  });

  it("rejects oversized command instructions before using the model", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", instructions: "x".repeat(TITLE_INSTRUCTIONS_LIMIT + 1) })).rejects.toThrow("at most 2,000");
    expect(kit.complete).not.toHaveBeenCalled();
  });

  it("settles a waiting direct request after a manual rename without starting inference", async () => {
    const kit = harness(conversation);
    const generated = kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model" });
    kit.pi.setSessionName("Manual title");
    kit.setIdle(true);
    await kit.events.get("agent_settled")!({}, { ...kit.context });
    await expect(generated).resolves.toBeUndefined();
    expect(kit.complete).not.toHaveBeenCalled();
  });

  it("deduplicates waiting requests across fresh contexts of the same session", async () => {
    const kit = harness(conversation);
    const input = { provider: "provider", modelId: "model", instructions: "Use German." };
    const first = kit.commands.get("generate")!(kit.context, input);
    const second = kit.commands.get("generate")!({ ...kit.context }, input);
    kit.setIdle(true);
    await kit.events.get("agent_settled")!({}, { ...kit.context });
    await expect(first).resolves.toEqual({ title: "Automatic thread titles" });
    await expect(second).resolves.toEqual({ title: "Automatic thread titles" });
    expect(kit.complete).toHaveBeenCalledOnce();
  });

  it("returns asynchronous inference failures through the result command", async () => {
    const kit = harness(conversation);
    kit.setIdle(true);
    kit.complete.mockRejectedValueOnce(new Error("Model unavailable"));
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model", requestId: "request", deferApply: true })).resolves.toEqual({ pending: true });
    await expect(kit.commands.get("result")!(kit.context, { requestId: "request" })).rejects.toThrow("Model unavailable");
    expect(kit.pi.setSessionName).not.toHaveBeenCalled();
  });

  it("stays silent when the thread has nothing to title", async () => {
    const kit = harness([]);
    kit.setIdle(true);
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model" })).resolves.toBeUndefined();
    expect(kit.complete).not.toHaveBeenCalled();
  });
});
