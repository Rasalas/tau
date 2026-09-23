import { describe, expect, it, vi } from "vitest";
import type { RuntimeExtensionFactory, RuntimeExtensionOptions } from "tau/host-extension";
import { THREAD_MODE_ENTRY } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPlanHostExtension } from "./host.js";
import { PLAN_HOST_EXTENSION_ID, PLAN_MODE_INSTRUCTIONS } from "./protocol.js";

async function harness() {
  let factory: RuntimeExtensionFactory | undefined;
  let options: RuntimeExtensionOptions | undefined;
  const start = vi.fn(async () => ({ sessionId: "new-thread", cwd: "/repo" }));
  const registry = await activateHostKit(createPlanHostExtension(), {
    log: vi.fn(),
    registerRuntimeExtension: (_name, registered, registeredOptions) => { factory = registered; options = registeredOptions; return () => undefined; },
    sessions: { start } as never,
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  factory!({ on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); } } as never, { sessionId: "s", cwd: "/repo" });
  const ctx = (mode?: string) => ({ sessionManager: { getBranch: () => mode ? [{ type: "custom", customType: THREAD_MODE_ENTRY, data: { mode } }] : [] } });
  return { registry, options, handlers, ctx, start };
}

describe("Plan Kit host extension", () => {
  it("gives Pi threads the plan mode", async () => {
    const { options } = await harness();
    expect(options?.modes).toEqual(["plan"]);
  });

  it("adds the instructions and refuses writing tools only while the thread plans", async () => {
    const { handlers, ctx } = await harness();
    const start = handlers.get("before_agent_start")!;
    const toolCall = handlers.get("tool_call")!;
    expect(start({ systemPrompt: "base" }, ctx("plan"))).toEqual({ systemPrompt: `base\n\n${PLAN_MODE_INSTRUCTIONS}` });
    expect(start({ systemPrompt: "base" }, ctx())).toBeUndefined();
    expect(start({ systemPrompt: "base" }, ctx("default"))).toBeUndefined();
    expect(toolCall({ toolName: "edit" }, ctx("plan"))).toMatchObject({ block: true });
    expect(toolCall({ toolName: "read" }, ctx("plan"))).toBeUndefined();
    expect(toolCall({ toolName: "bash" }, ctx("plan"))).toBeUndefined();
    expect(toolCall({ toolName: "write" }, ctx("default"))).toBeUndefined();
  });

  it("starts the thread a plan is implemented in", async () => {
    const { registry, start } = await harness();
    await expect(registry.invoke(PLAN_HOST_EXTENSION_ID, "implement-in-new-thread", {
      cwd: "/repo", prompt: "PLEASE IMPLEMENT THIS PLAN:\n# x", title: "Implement x", backend: "codex", model: { provider: "openai", id: "m" },
    })).resolves.toEqual({ sessionId: "new-thread" });
    expect(start).toHaveBeenCalledWith({ cwd: "/repo", prompt: "PLEASE IMPLEMENT THIS PLAN:\n# x", title: "Implement x", backend: "codex", model: { provider: "openai", id: "m" } });
    await expect(registry.invoke(PLAN_HOST_EXTENSION_ID, "implement-in-new-thread", { cwd: "/repo" })).rejects.toThrow(/prompt/u);
  });
});
