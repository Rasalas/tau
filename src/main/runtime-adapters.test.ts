import { describe, expect, it } from "vitest";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, selectDefaultBackend } from "./runtime-adapters.js";

// Core's half of what used to be the Claude Code adapter's test: which backend
// a start picks, and what shape core accepts from a kit that registers one.
// The kit itself now lives in `kits/claude-code/` and only names its own kind.
describe("runtime adapter selection", () => {
  it("runs Pi unless the environment names another backend", () => {
    expect(selectDefaultBackend("pi")).toBe("pi");
    expect(selectDefaultBackend(undefined)).toBe("pi");
    expect(selectDefaultBackend(" Claude-Code ")).toBe("claude-code");
    expect(PI_AGENT_RUNTIME_ADAPTER.capabilities.skillInvocationDialect).toBe("pi");
    expect(PI_AGENT_RUNTIME_ADAPTER.transport).toBeUndefined();
  });

  it("forces Pi in safe mode even when another backend was requested", () => {
    expect(selectDefaultBackend("claude-code", { safeMode: true })).toBe("pi");
  });

  it("rejects an adapter whose shape does not fit its kind", () => {
    expect(() => assertRuntimeAdapter({ id: "pi", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("must declare");
    expect(() => assertRuntimeAdapter({ id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("requires");
    // A provider name is not a backend; without a transport it is refused where it would be used.
    expect(() => assertRuntimeAdapter({ id: "anthropic", capabilities: { skillInvocationDialect: "pi" } })).toThrow("requires a configured transport");
    expect(() => assertRuntimeAdapter({ id: "", capabilities: { skillInvocationDialect: "pi" } })).toThrow("Unsupported runtime adapter");
    const adapter = { id: "acme", capabilities: { skillInvocationDialect: "claude-code" }, transport: { sendPrompt: async () => ({}) } };
    expect(assertRuntimeAdapter(adapter)).toBe(adapter);
  });
});
