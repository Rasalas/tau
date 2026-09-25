import { describe, expect, it, vi } from "vitest";
import type { RuntimeExtensionContribution, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createComputerUseHostExtension, settingsIncludeComputerUse } from "./host.js";
import {
  COMPUTER_USE_EXTENSION_ID,
  COMPUTER_USE_PACKAGE,
  COMPUTER_USE_RUNTIME_EXTENSION,
  COMPUTER_USE_SCREEN_RUNTIME_EXTENSION,
  SCREEN_EVENT,
  type ScreenState,
} from "./protocol.js";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

/** The slice of Pi's extension API the driver and the observer touch. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  const pi = {
    on: (event: string, handler: Handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools.push(tool); },
    registerCommand: vi.fn(),
  };
  const fire = async (event: string, payload: Record<string, unknown>, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  return { pi, tools, fire };
}

const sessionContext = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId }, ui: { notify: vi.fn() }, hasUI: false, cwd: "/project" });

/** A driver that registers one tool at session start, as the real package does on macOS. */
function fakeDriver(execute = vi.fn(async () => ({ content: [{ type: "text", text: "raised" }] }))) {
  const driver = ((pi: { on: (event: string, handler: Handler) => void; registerTool: (tool: unknown) => void }) => {
    pi.on("session_start", () => { pi.registerTool({ name: "computer_use_bring_to_front", execute }); });
  }) as unknown as RuntimeExtensionFactory;
  return { driver, execute };
}

async function activate(options: {
  driver?: RuntimeExtensionFactory;
  load?: () => Promise<RuntimeExtensionFactory>;
  callClient?: (extensionId: string, command: string, input?: unknown) => Promise<unknown>;
} = {}) {
  const contributions: RuntimeExtensionContribution[] = [];
  const events: PublishedKitEvent[] = [];
  const driver = options.driver ?? fakeDriver().driver;
  const loadRuntimeExtension = vi.fn(options.load ?? (async () => driver));
  const registry = await activateHostKit(createComputerUseHostExtension(), {
    loadRuntimeExtension,
    registerRuntimeExtension: (name, factory, extensionOptions) => {
      contributions.push({ name, factory, ...extensionOptions });
      return () => undefined;
    },
    callClient: (options.callClient ?? (async () => { throw new Error("no window"); })) as never,
  }, (event) => events.push(event));
  const invoke = (command: string, input?: unknown) => registry.invoke(COMPUTER_USE_EXTENSION_ID, command, input);
  /** Starts every contributed extension in one runtime of `sessionId`, as Pi would. */
  const runtime = async (sessionId: string) => {
    const { pi, tools, fire } = fakePi();
    for (const contribution of contributions) await contribution.factory(pi as never, { sessionId, cwd: "/project" });
    await fire("session_start", {}, sessionContext(sessionId));
    return { tools, fire: (event: string, payload: Record<string, unknown>) => fire(event, payload, sessionContext(sessionId)) };
  };
  return { contributions, loadRuntimeExtension, invoke, runtime, events, registry };
}

describe("Computer Use host extension", () => {
  it("registers the Pi extension the host loaded from Tau's own dependencies, and the screen observer", async () => {
    const { contributions, loadRuntimeExtension, runtime } = await activate();

    expect(loadRuntimeExtension).toHaveBeenCalledWith(COMPUTER_USE_PACKAGE);
    expect(contributions.map((entry) => entry.name)).toEqual([COMPUTER_USE_RUNTIME_EXTENSION, COMPUTER_USE_SCREEN_RUNTIME_EXTENSION]);
    // The driver still registers its tools with Pi itself.
    expect((await runtime("thread")).tools.map((tool) => tool.name)).toEqual(["computer_use_bring_to_front"]);
  });

  it("activates before the package has loaded, and a runtime waits for it", async () => {
    const { driver } = fakeDriver();
    let release!: (factory: RuntimeExtensionFactory) => void;
    const pending = new Promise<RuntimeExtensionFactory>((resolve) => { release = resolve; });
    const { runtime } = await activate({ load: () => pending });

    let started = false;
    const opening = runtime("thread").then((opened) => { started = true; return opened; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(false);
    release(driver);
    expect((await opening).tools.map((tool) => tool.name)).toEqual(["computer_use_bring_to_front"]);
  });

  it("stands down when the user already configured the Pi package, while the observer stays", async () => {
    const { contributions } = await activate();
    const [driver, observer] = contributions;

    expect(driver!.enabledFor?.({ global: {}, project: {} })).toBe(true);
    expect(driver!.enabledFor?.({ global: { packages: [`npm:${COMPUTER_USE_PACKAGE}`] }, project: {} })).toBe(false);
    expect(driver!.enabledFor?.({ global: {}, project: { packages: [{ source: `npm:${COMPUTER_USE_PACKAGE}@1.0.0` }] } })).toBe(false);
    expect(observer!.enabledFor).toBeUndefined();
  });

  it("recognizes string and object package declarations and ignores unrelated ones", () => {
    expect(settingsIncludeComputerUse({ packages: [`npm:${COMPUTER_USE_PACKAGE}`] })).toBe(true);
    expect(settingsIncludeComputerUse({ packages: [{ source: `npm:${COMPUTER_USE_PACKAGE}@0.1.12`, autoload: true }] })).toBe(true);
    expect(settingsIncludeComputerUse({ packages: ["npm:pi-subagents"] })).toBe(false);
    expect(settingsIncludeComputerUse({})).toBe(false);
  });

  it("feeds a thread's screen from its computer-use calls and serves the frame on request", async () => {
    const { runtime, invoke, events } = await activate();
    const thread = await runtime("thread-1");
    const shot = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(shot, 0);
    shot.writeUInt32BE(64, 16);
    shot.writeUInt32BE(48, 20);
    const data = shot.toString("base64");

    await thread.fire("tool_call", { toolName: "computer_use_get_window_state", toolCallId: "a", input: { pid: 7, window_id: 3 } });
    await thread.fire("tool_result", { toolName: "computer_use_get_window_state", toolCallId: "a", input: { pid: 7, window_id: 3 }, content: [{ type: "image", data, mimeType: "image/png" }], details: {}, isError: false });
    await thread.fire("tool_call", { toolName: "computer_use_click", toolCallId: "b", input: { pid: 7, window_id: 3, x: 10, y: 20 } });
    await thread.fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: "a.ts" } });

    const state = await invoke("screen-state", { threadId: "thread-1" }) as ScreenState;
    expect(state).toMatchObject({ window: { pid: 7, windowId: 3 }, frame: { width: 64, height: 48 }, canBringToFront: true });
    expect(state.actions).toEqual([expect.objectContaining({ kind: "click", point: { x: 10, y: 20 }, space: { width: 64, height: 48 } })]);
    expect(await invoke("screen-frame", { threadId: "thread-1" })).toMatchObject({ data, seq: state.frame!.seq });
    expect(events.every((event) => event.name === SCREEN_EVENT)).toBe(true);
    expect((events.at(-1)!.payload as ScreenState).actions).toHaveLength(1);
    expect(await invoke("screen-state", { threadId: "other" })).toBeNull();
  });

  it("raises the window through the thread's own driver tool", async () => {
    const { driver, execute } = fakeDriver();
    const { runtime, invoke } = await activate({ driver });
    const thread = await runtime("thread-1");
    await expect(invoke("screen-front", { threadId: "thread-1" })).rejects.toThrow(/drives no window/u);

    await thread.fire("tool_call", { toolName: "computer_use_get_window_state", toolCallId: "a", input: { pid: 7, window_id: 3 } });
    await invoke("screen-front", { threadId: "thread-1" });

    expect(execute).toHaveBeenCalledWith("tau-screen-front", { pid: 7, window_id: 3 }, expect.any(AbortSignal), undefined, expect.objectContaining({ cwd: "/project" }));
  });

  it("lets a device click into the thread's window through its driver, and a Read-only one only look", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    const shot = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(shot, 0);
    shot.writeUInt32BE(200, 16);
    shot.writeUInt32BE(100, 20);
    const data = shot.toString("base64");
    const driver = ((pi: { on: (event: string, handler: Handler) => void; registerTool: (tool: unknown) => void }) => {
      pi.on("session_start", () => {
        for (const name of ["computer_use_click", "computer_use_get_window_state"]) {
          pi.registerTool({ name, execute: async (_id: string, params: unknown) => {
            calls.push({ name, params });
            return name.endsWith("get_window_state") ? { content: [{ type: "image", data, mimeType: "image/png" }], details: {} } : { content: [] };
          } });
        }
      });
    }) as unknown as RuntimeExtensionFactory;
    const { runtime, invoke, registry } = await activate({ driver });
    const thread = await runtime("thread-1");
    await thread.fire("tool_result", { toolName: "computer_use_get_window_state", toolCallId: "a", input: { pid: 7, window_id: 3 }, content: [{ type: "image", data, mimeType: "image/png" }], details: {}, isError: false });
    const before = (await invoke("screen-state", { threadId: "thread-1" }) as ScreenState).frame!.seq;

    await invoke("screen-input", { threadId: "thread-1", input: { kind: "click", x: 0.5, y: 0.5 } });
    expect(calls).toEqual([
      { name: "computer_use_click", params: { pid: 7, window_id: 3, x: 100, y: 50 } },
      { name: "computer_use_get_window_state", params: { pid: 7, window_id: 3 } },
    ]);
    expect((await invoke("screen-state", { threadId: "thread-1" }) as ScreenState).frame!.seq).toBeGreaterThan(before);

    const readOnly = { kind: "workbench-client", connection: "phone", pairedClient: "c1", readOnly: true } as const;
    await expect(registry.invoke(COMPUTER_USE_EXTENSION_ID, "screen-input", { threadId: "thread-1", input: { kind: "key", key: "Enter" } }, readOnly)).rejects.toThrow();
    await expect(registry.invoke(COMPUTER_USE_EXTENSION_ID, "screen-state", { threadId: "thread-1" }, readOnly)).resolves.toMatchObject({ threadId: "thread-1" });
    expect(calls).toHaveLength(2);
  });

  it("records only the window the feed names, and says so when there is no window client", async () => {
    // The host binds the extension id in front of what the kit passes.
    const callClient = vi.fn(async (_extensionId: string, command: string) => command === "access" ? "denied" : "granted");
    const { runtime, invoke } = await activate({ callClient });
    const thread = await runtime("thread-1");

    await expect(invoke("screen-live-start", { threadId: "thread-1" })).rejects.toThrow(/drives no window/u);
    await thread.fire("tool_call", { toolName: "computer_use_click", toolCallId: "a", input: { pid: 7, window_id: 3, x: 1, y: 1 } });
    await invoke("screen-live-start", { threadId: "thread-1", windowId: 999 });
    // Always a window on the host's machine: the driven window and its capture live there.
    expect(callClient).toHaveBeenLastCalledWith(COMPUTER_USE_EXTENSION_ID, "live-start", { windowId: 3 }, { window: "host" });
    expect(await invoke("screen-access")).toBe("denied");

    const offline = await activate();
    expect(await offline.invoke("screen-access")).toBe("unavailable");
  });
});
