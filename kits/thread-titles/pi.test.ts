import { describe, expect, it, vi } from "vitest";
import type { PiKitBridge, PiKitTranscriptMessage } from "tau/host-extension";
import threadTitlesPiExtension from "./pi.js";
import { TITLE_SYSTEM_PROMPT } from "./protocol.js";

function harness(transcript: PiKitTranscriptMessage[]) {
  const commands = new Map<string, (ctx: any, input: Record<string, unknown>) => Promise<unknown>>();
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  let sessionName: string | undefined;
  let idle = false;
  const complete = vi.fn(async (_model: unknown, request: { systemPrompt: string }) => ({ request, stopReason: "stop", content: [{ type: "text", text: "Automatic thread titles" }] }));
  const context = {
    isIdle: () => idle,
    sessionManager: { getSessionId: () => "session" },
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
    isCurrentSession: () => true,
  } satisfies PiKitBridge as unknown as PiKitBridge;
  const pi = {
    on: (name: string, handler: any) => events.set(name, handler),
    getSessionName: () => sessionName,
    setSessionName: vi.fn((title: string) => { sessionName = title; }),
  };
  threadTitlesPiExtension(pi as never, bridge);
  return { commands, events, context, pi, complete, setIdle: (value: boolean) => { idle = value; } };
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
    await kit.events.get("agent_settled")!({}, kit.context);

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

  it("stays silent when the thread has nothing to title", async () => {
    const kit = harness([]);
    kit.setIdle(true);
    await expect(kit.commands.get("generate")!(kit.context, { provider: "provider", modelId: "model" })).resolves.toBeUndefined();
    expect(kit.complete).not.toHaveBeenCalled();
  });
});
