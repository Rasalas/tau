// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { serviceTierKitExtension } from "./desktop.js";

function activate(state: { tier: "standard" | "fast"; available: boolean }) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => {
    if (command === "set-tier") state = { ...state, tier: (input as { tier: "standard" | "fast" }).tier };
    return state;
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(serviceTierKitExtension);
  const [speed] = registry.getComposerSpeeds();
  const changed = vi.fn();
  speed!.subscribe(changed);
  return { registry, invoke, speed: speed!, changed };
}

const thread = (backendKind?: string) => ({ sessionId: "s", backendKind, model: { provider: "openai", id: "gpt-6-sol" } }) as unknown as HostSnapshot;

describe("Service Tier Kit desktop extension", () => {
  it("gives Fast to the thinking chip, not the composer's menu, and says why where the model has none", async () => {
    const { registry, invoke, speed, changed } = activate({ tier: "standard", available: false });
    expect(registry.getComposerControls()).toEqual([]);
    const opus = { ...thread(), model: { provider: "anthropic", id: "claude-opus-5" } } as unknown as HostSnapshot;
    expect(speed.read(opus)).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("tau.service-tier", "state", undefined);
    expect(speed.read(opus)).toEqual({ fast: false, available: false, reason: "Pi offers Fast for OpenAI models only" });
    // Another runtime's thread is another kit's.
    expect(speed.read(thread("codex"))).toBeUndefined();
  });

  it("switches the tier through the host", async () => {
    const { invoke, speed, changed } = activate({ tier: "standard", available: true });
    speed.read(thread("pi"));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(speed.read(thread("pi"))).toMatchObject({ fast: false, available: true });
    await speed.set(true, thread("pi"));
    expect(invoke).toHaveBeenCalledWith("tau.service-tier", "set-tier", { tier: "fast" });
    expect(speed.read(thread("pi"))).toMatchObject({ fast: true, available: true });
    // A draft on another provider's model has none, whatever the thread on screen runs.
    expect(speed.read({ ...thread("pi"), model: { provider: "anthropic", id: "claude-opus-5" } } as unknown as HostSnapshot)).toMatchObject({ fast: true, available: false });
  });

  it("follows tier changes the host announces", async () => {
    const { registry, speed, changed } = activate({ tier: "standard", available: true });
    speed.read(thread());
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "tau.service-tier", name: "state", payload: { tier: "fast", available: true } });
    expect(speed.read(thread())).toMatchObject({ fast: true });
  });
});
