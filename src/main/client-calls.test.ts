import { describe, expect, it } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { ClientCalls } from "./client-calls.js";
import { WindowExtensionRegistry } from "./window-extensions.js";

type ClientCall = Extract<HostEvent, { type: "client-call" }>;

function calls(timeoutMs = 50): { calls: ClientCalls; published: ClientCall[] } {
  const published: ClientCall[] = [];
  const instance = new ClientCalls((event) => { if (event.type === "client-call") published.push(event); }, timeoutMs);
  return { calls: instance, published };
}

describe("calls from the host into a client's process", () => {
  it("publishes one call and resolves with the client's answer", async () => {
    const { calls: pending, published } = calls();
    const answer = pending.call("tau.preview", "open-view", { url: "about:blank" });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ extensionId: "tau.preview", command: "open-view", input: { url: "about:blank" } });
    pending.settle(published[0]!.callId, { ok: true });
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("fails the call when the client reports an error", async () => {
    const { calls: pending, published } = calls();
    const answer = pending.call("tau.preview", "open-view");
    pending.settle(published[0]!.callId, undefined, "This window cannot draw a preview.");
    await expect(answer).rejects.toThrow(/cannot draw a preview/u);
  });

  it("gives up when no client answers", async () => {
    const { calls: pending } = calls(10);
    await expect(pending.call("tau.preview", "open-view")).rejects.toThrow(/No client answered/u);
  });

  it("ignores an answer to a call it does not know", () => {
    const { calls: pending } = calls();
    expect(() => pending.settle("never-asked", "x")).not.toThrow();
  });

  it("fails everything still waiting when the host stops", async () => {
    const { calls: pending } = calls(10_000);
    const answer = pending.call("tau.preview", "open-view");
    pending.dispose();
    await expect(answer).rejects.toThrow(/stopped waiting/u);
  });
});

describe("the window half registry", () => {
  const registry = () => new WindowExtensionRegistry({ invokeHost: async () => undefined });

  it("routes a call to the half that belongs to the extension", async () => {
    const instance = registry();
    instance.register("tau.preview", () => ({ handle: (command, input) => ({ command, input }) }));
    await expect(instance.invoke("tau.preview", "place", { x: 1 })).resolves.toEqual({ command: "place", input: { x: 1 } });
  });

  it("says so when this window has no such half", async () => {
    await expect(registry().invoke("tau.absent", "place")).rejects.toThrow(/no half of tau.absent/u);
  });

  it("lets every half go when the window does", () => {
    const instance = registry();
    let disposed = false;
    instance.register("tau.preview", () => ({ handle: () => undefined, dispose: () => { disposed = true; } }));
    instance.dispose();
    expect(disposed).toBe(true);
    expect(instance.ids).toEqual([]);
  });
});
