import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, HostMcpToolCall, HostMcpToolGate, RuntimeExtensionFactory } from "tau/host-extension";
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
    await expect(registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "root" })).rejects.toThrow("Access level must be read-only, ask, auto or full.");
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
    // Auto sits between ask and full: it narrows full and never widens ask.
    await expect(agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: "auto" })).resolves.toBe("auto");
    await expect(agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: null })).resolves.toBe("full");
    await expect(toolCall("child", "edit")).resolves.toBeUndefined();

    await expect(stranger!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "child", level: "full" })).rejects.toThrow();
  });

  it("tells Servers Kit the level a thread runs at, and nobody else", async () => {
    const registry = await activateHostKit(createAccessHostExtension(), { log: vi.fn(), registerRuntimeExtension: () => () => undefined, setPermissionLevel: () => undefined });
    let agents: HostExtensionContext | undefined;
    let servers: HostExtensionContext | undefined;
    let stranger: HostExtensionContext | undefined;
    await registry.activate({ id: "tau.agents", name: "Agents", activate: (context) => { agents = context; } });
    await registry.activate({ id: "tau.servers", name: "Servers", activate: (context) => { servers = context; } });
    await registry.activate({ id: "tau.other", name: "Other", activate: (context) => { stranger = context; } });

    await expect(servers!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level-of", { threadId: "t1" })).resolves.toBe("full");
    await agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "t1", level: "ask" });
    await expect(servers!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level-of", { threadId: "t1" })).resolves.toBe("ask");
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "read-only" });
    await expect(servers!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level-of", { threadId: "t2" })).resolves.toBe("read-only");
    await expect(servers!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level-of", {})).rejects.toThrow("threadId");
    await expect(stranger!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level-of", { threadId: "t1" })).rejects.toThrow();
  });

  it("gates Tau's tools over MCP with the same decision as Pi's, thread levels included", async () => {
    const gates: HostMcpToolGate[] = [];
    const registry = await activateHostKit(createAccessHostExtension(), {
      log: vi.fn(),
      registerRuntimeExtension: () => () => undefined,
      setPermissionLevel: () => undefined,
      mcp: {
        registerTools: () => () => undefined,
        gate: (gate) => { gates.push(gate); return () => { gates.splice(gates.indexOf(gate), 1); }; },
        connect: async () => undefined,
      },
    });
    let agents: HostExtensionContext | undefined;
    await registry.activate({ id: "tau.agents", name: "Agents", activate: (context) => { agents = context; } });
    const asked: string[] = [];
    let approve = false;
    const call = (toolName: string, threadId = "codex-thread", annotations?: HostMcpToolCall["annotations"]) => gates[0]!({
      threadId,
      cwd: "/project",
      toolName,
      input: { threadId: "child-1" },
      ...(annotations ? { annotations } : {}),
      signal: new AbortController().signal,
      confirm: async (title, message) => { asked.push(`${title} ${message}`); return approve; },
    } satisfies HostMcpToolCall);

    expect(gates).toHaveLength(1);
    // Full access runs everything, as it does for Pi.
    await expect(call("tau_apply_thread_changes")).resolves.toBeUndefined();

    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "ask" });
    await expect(call("preview_snapshot")).resolves.toBeUndefined();
    // A kit's tool that declares itself mutating is asked about, one that declares nothing is not.
    await expect(call("kit_publish", "codex-thread", { readOnlyHint: false })).resolves.toEqual({ block: true, reason: "Blocked by Tau: kit_publish was not approved." });
    await expect(call("kit_list")).resolves.toBeUndefined();
    asked.length = 0;
    await expect(call("tau_apply_thread_changes")).resolves.toEqual({ block: true, reason: "Blocked by Tau: tau_apply_thread_changes was not approved." });
    expect(asked).toEqual(["Wants to apply an agent's work Apply the changes of thread child-1"]);
    approve = true;
    await expect(call("tau_apply_thread_changes")).resolves.toBeUndefined();

    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "full" });
    await agents!.invokeHostExtension(ACCESS_HOST_EXTENSION_ID, "thread-level", { threadId: "narrow", level: "read-only" });
    await expect(call("tau_apply_thread_changes", "narrow")).resolves.toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
    await expect(call("tau_apply_thread_changes", "codex-thread")).resolves.toBeUndefined();

    await registry.deactivate(ACCESS_HOST_EXTENSION_ID);
    expect(gates).toEqual([]);
  });

  it("starts at the level the host's config holds and follows the config, not a client's defaults", async () => {
    let held: Record<string, string> = { level: "read-only" };
    let changed: ((change: { kind: string; paths: readonly string[] }) => void) | undefined;
    let policy: (() => AccessLevel) | undefined;
    const settings = vi.fn(async (id: string) => ({ options: {}, values: id === ACCESS_HOST_EXTENSION_ID ? held : {} }));
    const registry = await activateHostKit(createAccessHostExtension(), {
      log: vi.fn(),
      registerRuntimeExtension: () => () => undefined,
      setPermissionLevel: (provider) => { policy = provider as () => AccessLevel; },
      settings: settings as never,
      observeConfigChanges: (listener) => { changed = listener; return () => { changed = undefined; }; },
    });
    await expect(registry.invoke(ACCESS_HOST_EXTENSION_ID, "level")).resolves.toBe("read-only");
    expect(policy?.()).toBe("read-only");

    held = { level: "ask" };
    changed?.({ kind: "keybindings", paths: [] });
    changed?.({ kind: "config", paths: ["/home/.tau/config.json"] });
    await vi.waitFor(() => expect(policy?.()).toBe("ask"));

    // A read that started before a choice arrived does not put the old level back.
    held = { level: "read-only" };
    changed?.({ kind: "config", paths: [] });
    await registry.invoke(ACCESS_HOST_EXTENSION_ID, "set-level", { level: "full" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(policy?.()).toBe("full");

    await registry.deactivate(ACCESS_HOST_EXTENSION_ID);
    expect(changed).toBeUndefined();
  });

  it("does not activate without the runtime permission its manifest declares", async () => {
    const registry = await activateHostKit({ ...createAccessHostExtension(), permissions: [] });
    expect(registry.isActive(ACCESS_HOST_EXTENSION_ID)).toBe(false);
  });
});


it("narrows an external runtime's permission policy for the scheduled thread only", async () => {
  let policy: ((threadId?: string) => AccessLevel) | undefined;
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: (provider) => { policy = provider; } });
  let caller: HostExtensionContext | undefined;
  await registry.activate({ id: "tau.scheduling", name: "Scheduling", activate(context) { caller = context; } });
  await caller!.invokeHostExtension("tau.access", "thread-level", { threadId: "scheduled", level: "read-only" });
  expect(policy?.("scheduled")).toBe("read-only");
  expect(policy?.("other")).toBe("full");
  await registry.invoke("tau.access", "set-level", { level: "ask" });
  await caller!.invokeHostExtension("tau.access", "thread-level", { threadId: "scheduled", level: "full" });
  expect(policy?.("scheduled")).toBe("ask");
  await registry.deactivate("tau.access");
});


it("lets Scheduling read the configured default for new threads through the existing level command", async () => {
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: () => undefined, settings: async () => ({ options: {}, values: { level: "ask" } }) });
  let caller: HostExtensionContext | undefined;
  await registry.activate({ id: "tau.scheduling", name: "Scheduling", activate(context) { caller = context; } });
  expect(await caller!.invokeHostExtension("tau.access", "level")).toBe("ask");
  await registry.invoke("tau.access", "set-level", { level: "full" });
  expect(await caller!.invokeHostExtension("tau.access", "level")).toBe("full");
  await registry.deactivate("tau.access");
});

it("keeps each kit's narrowing of a thread apart, so Scheduling lifting its ceiling leaves an agent's in place", async () => {
  let policy: ((threadId?: string) => AccessLevel) | undefined;
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: (provider) => { policy = provider; } });
  let agents: HostExtensionContext | undefined;
  let scheduling: HostExtensionContext | undefined;
  await registry.activate({ id: "tau.agents", name: "Agents", activate(context) { agents = context; } });
  await registry.activate({ id: "tau.scheduling", name: "Scheduling", activate(context) { scheduling = context; } });
  await agents!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: "auto" });
  await expect(scheduling!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: "ask" })).resolves.toBe("ask");
  await expect(scheduling!.invokeHostExtension("tau.access", "thread-level-of", { threadId: "t" })).resolves.toBe("ask");
  await expect(scheduling!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: null })).resolves.toBe("auto");
  expect(policy?.("t")).toBe("auto");
  await agents!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: null });
  expect(policy?.("t")).toBe("full");
  await registry.deactivate("tau.access");
});

it("keeps core's narrowing of a thread when a kit lifts its own, as an external MCP client's ceiling needs", async () => {
  let policy: ((threadId?: string) => AccessLevel) | undefined;
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: (provider) => { policy = provider; } });
  let scheduling: HostExtensionContext | undefined;
  await registry.activate({ id: "tau.scheduling", name: "Scheduling", activate(context) { scheduling = context; } });
  // The host itself calls without a kit identity (ADR 0046).
  await expect(registry.invoke("tau.access", "thread-level", { threadId: "t", level: "read-only" })).resolves.toBe("read-only");
  await scheduling!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: "ask" });
  await scheduling!.invokeHostExtension("tau.access", "thread-level", { threadId: "t", level: null });
  expect(policy?.("t")).toBe("read-only");
  await registry.deactivate("tau.access");
});

it("refuses a paired device that tries to lift a thread's narrowing", async () => {
  let policy: ((threadId?: string) => AccessLevel) | undefined;
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: (provider) => { policy = provider; } });
  await registry.invoke("tau.access", "thread-level", { threadId: "t", level: "ask" });
  const device = { kind: "workbench-client", connection: "phone", pairedClient: "device" } as const;
  await expect(registry.invoke("tau.access", "thread-level", { threadId: "t", level: null }, device)).rejects.toThrow("Only a connection");
  expect(policy?.("t")).toBe("ask");
  await registry.deactivate("tau.access");
});

it("tells clients how far a thread is narrowed, without the workbench's level, and when that changes", async () => {
  const events: PublishedKitEvent[] = [];
  const registry = await activateHostKit(createAccessHostExtension(), { setPermissionLevel: () => undefined }, (event) => events.push(event));
  await registry.invoke("tau.access", "set-level", { level: "read-only" });
  events.length = 0;
  await expect(registry.invoke("tau.access", "thread-narrowing", { threadId: "t" })).resolves.toBeNull();
  await registry.invoke("tau.access", "thread-level", { threadId: "t", level: "ask" });
  // The composer shows the stricter of this and the level its person picked.
  await expect(registry.invoke("tau.access", "thread-narrowing", { threadId: "t" })).resolves.toBe("ask");
  expect(events).toEqual([{ type: "extension-event", extensionId: "tau.access", name: "thread-narrowing", payload: { threadId: "t" } }]);
  // The same narrowing again changes nothing a client draws.
  await registry.invoke("tau.access", "thread-level", { threadId: "t", level: "ask" });
  expect(events).toHaveLength(1);
  // A device that may only look still reads it.
  const looker = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
  await expect(registry.invoke("tau.access", "thread-narrowing", { threadId: "t" }, looker)).resolves.toBe("ask");
  await registry.invoke("tau.access", "thread-level", { threadId: "t", level: null });
  expect(events).toHaveLength(2);
  await expect(registry.invoke("tau.access", "thread-narrowing", { threadId: "t" })).resolves.toBeNull();
  await registry.deactivate("tau.access");
});
