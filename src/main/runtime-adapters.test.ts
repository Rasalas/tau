import { describe, expect, it } from "vitest";
import { assertRuntimeAdapter, createClaudeCodeRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, selectRuntimeAdapter } from "./runtime-adapters.js";

describe("runtime adapter selection", () => {
  it("selects the embedded Pi transport by default", () => {
    expect(selectRuntimeAdapter("pi")).toBe(PI_AGENT_RUNTIME_ADAPTER);
    expect(selectRuntimeAdapter("pi").capabilities.skillInvocationDialect).toBe("pi");
    expect(selectRuntimeAdapter("pi").transport).toBeUndefined();
  });

  it("selects a real Claude Code transport explicitly", () => {
    const adapter = selectRuntimeAdapter("claude-code");
    expect(adapter.id).toBe("claude-code");
    expect(adapter.capabilities.skillInvocationDialect).toBe("claude-code");
    expect(adapter.transport?.sendPrompt).toBeTypeOf("function");
    expect(createClaudeCodeRuntimeAdapter({ command: "claude-test" }).id).toBe("claude-code");
  });

  it.skipIf(process.platform === "win32")("uses the selected Claude transport for every turn", async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: "/bin/echo" });
    const first = await adapter.transport!.sendPrompt({ cwd: process.cwd(), sessionId: "session", text: "/tdd fix it" });
    const second = await adapter.transport!.sendPrompt({ cwd: process.cwd(), sessionId: "session", text: "continue" });
    expect(first.assistantText).toContain("/tdd fix it");
    expect(second.assistantText).toContain("--resume");
    expect(second.assistantText).toContain("continue");
  });

  it("rejects an accidental provider-shaped adapter selection", () => {
    expect(() => selectRuntimeAdapter("anthropic")).toThrow("TAU_RUNTIME_ADAPTER");
  });

  it("rejects a dialect that does not match the selected adapter", () => {
    expect(() => assertRuntimeAdapter({ id: "pi", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("must declare");
    expect(() => assertRuntimeAdapter({ id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("requires");
    expect(() => assertRuntimeAdapter({ id: "anthropic" as never, capabilities: { skillInvocationDialect: "pi" } })).toThrow("Unsupported runtime adapter");
  });
});
