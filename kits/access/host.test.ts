import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createAccessHostExtension } from "./host.js";
import { ACCESS_HOST_EXTENSION_ID, type AccessLevel } from "./protocol.js";

async function harness() {
  const events: PublishedKitEvent[] = [];
  const runtimeExtensions: string[] = [];
  let policy: (() => AccessLevel) | undefined;
  const registry = await activateHostKit(createAccessHostExtension(), {
    log: vi.fn(),
    registerRuntimeExtension: (name) => { runtimeExtensions.push(name); return () => undefined; },
    setPermissionLevel: (provider) => { policy = provider as (() => AccessLevel) | undefined; },
  }, (event) => events.push(event));
  return { registry, events, runtimeExtensions, policy: () => policy?.() };
}

describe("Access Kit host extension", () => {
  it("contributes the gate to Pi runtimes and starts with full access", async () => {
    const { registry, runtimeExtensions, policy } = await harness();
    expect(runtimeExtensions).toEqual(["tau-access"]);
    await expect(registry.invoke(ACCESS_HOST_EXTENSION_ID, "level")).resolves.toBe("full");
    expect(policy()).toBe("full");
  });

  it("changes the level, the external permission policy, and tells the desktop side", async () => {
    const { registry, events, policy } = await harness();
    await expect(registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "read-only" })).resolves.toBe("read-only");
    expect(policy()).toBe("read-only");
    expect(events).toEqual([{ type: "extension-event", extensionId: ACCESS_HOST_EXTENSION_ID, name: "level", payload: "read-only" }]);
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "read-only" });
    expect(events).toHaveLength(1);
  });

  it("rejects unknown levels and restores full access when deactivated", async () => {
    const { registry, policy } = await harness();
    await expect(registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "root" })).rejects.toThrow("Access level must be read-only, ask or full.");
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "ask" });
    expect(policy()).toBe("ask");
    await registry.deactivate(ACCESS_HOST_EXTENSION_ID);
    expect(policy()).toBeUndefined();
  });

  it("narrows one thread for the Agents Kit and never widens it", async () => {
    let gate: RuntimeExtensionFactory | undefined;
    const registry = await activateHostKit(createAccessHostExtension(), {
      log: vi.fn(),
      registerRuntimeExtension: (_name, factory) => { gate = factory; return () => undefined; },
      setPermissionLevel: () => undefined,
    });
    let agents: HostExtensionContext | undefined;
    await registry.activate({ id: "tau.agents", name: "Agents", activate: (context) => { agents = context; } });
    let stranger: HostExtensionContext | undefined;
    await registry.activate({ id: "tau.other", name: "Other", activate: (context) => { stranger = context; } });

    const toolCall = (sessionId: string, toolName: string) => {
      let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
      gate!({ on: (_event: string, callback: typeof handler) => { handler = callback; } } as never, { sessionId, cwd: "/project" });
      return handler!({ type: "tool_call", toolName, toolCallId: "call", input: { path: "a" } }, { ui: { confirm: async () => false } });
    };

    await expect(agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: "read-only" })).resolves.toBe("read-only");
    await expect(toolCall("child", "edit")).resolves.toMatchObject({ block: true });
    await expect(toolCall("other", "edit")).resolves.toBeUndefined();

    // A thread asking for full access under a read-only workbench stays read-only.
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "read-only" });
    await expect(agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: "full" })).resolves.toBe("read-only");
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "full" });
    await expect(agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: null })).resolves.toBe("full");
    await expect(toolCall("child", "edit")).resolves.toBeUndefined();

    await expect(stranger!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: "full" })).rejects.toThrow();
  });

  it("does not activate without the runtime permission its manifest declares", async () => {
    const registry = await activateHostKit({ ...createAccessHostExtension(), permissions: [] });
    expect(registry.isActive(ACCESS_HOST_EXTENSION_ID)).toBe(false);
  });
});
