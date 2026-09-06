import { describe, expect, it, vi } from "vitest";
import { createServiceTierExtension } from "./tier.js";

describe("service tier extension", () => {
  it("sets the priority tier on every request and reports the thread and model", () => {
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const pi = { on: (_name: string, fn: typeof handler) => { handler = fn; } };
    const onApplied = vi.fn();
    createServiceTierExtension({ fastRequested: () => true, available: () => true, onApplied })(pi as never);
    const ctx = { sessionManager: { getSessionId: () => "s1" }, model: { provider: "openai-codex", id: "gpt" } };
    expect(handler?.({ type: "before_provider_request", payload: { model: "gpt" } }, ctx)).toEqual({ model: "gpt", service_tier: "priority" });
    handler?.({ type: "before_provider_request", payload: { model: "gpt" } }, ctx);
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onApplied).toHaveBeenCalledWith("s1 · openai-codex/gpt");
  });

  it("leaves the payload alone when fast is off or unavailable", () => {
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const pi = { on: (_name: string, fn: typeof handler) => { handler = fn; } };
    createServiceTierExtension({ fastRequested: () => true, available: () => false, onApplied: vi.fn() })(pi as never);
    expect(handler?.({ type: "before_provider_request", payload: {} }, {})).toBeUndefined();
  });
});
