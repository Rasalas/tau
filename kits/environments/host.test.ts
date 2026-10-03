import { describe, expect, it, vi } from "vitest";
import type { HostExtension, HostMachine, HostMachineServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { AGENTS_EVENT, ENVIRONMENTS_EXTENSION_ID } from "./protocol.js";

function fakeMachines(list: HostMachine[]) {
  let listener: ((machines: readonly HostMachine[]) => void) | undefined;
  const machines: HostMachineServices = {
    self: { id: "mini-id", name: "mini", version: "0.7.0" },
    list: () => list,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
    call: vi.fn(async () => ({ device: "agents-device", owner: false })),
    request: vi.fn(async () => undefined),
    watch: vi.fn(() => () => undefined),
    upload: vi.fn(async () => ({ id: "blob", size: 0, sha256: "" })),
  };
  return { machines, changed: () => listener?.(list) };
}

describe("Machines Kit on the host", () => {
  it("starts off screen in the named remote workspace with the draft's settings", async () => {
    const { machines } = fakeMachines([]);
    machines.request = vi.fn(async () => ({ sessionId: "t9", path: "/remote/t9" }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    const input = { machine: "rex", workspaceId: "ws-rex", prompt: "Fix it", backend: "codex", model: { provider: "openai", id: "gpt" }, thinkingLevel: "high", mode: "plan" };
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", input)).toEqual({ sessionId: "t9", path: "/remote/t9" });
    expect(machines.request).toHaveBeenCalledExactlyOnceWith("rex", "start-thread", [{ cwd: "ws-rex", prompt: "Fix it", backend: "codex", model: input.model, thinkingLevel: "high", mode: "plan" }]);
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", { machine: "rex", prompt: "x" })).rejects.toThrow("name a workspace");
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", input, { kind: "workbench-client", connection: "c1", pairedClient: "d1", readOnly: true })).rejects.toThrow(/Read.only|read.only/u);
    expect(machines.request).toHaveBeenCalledOnce();
  });
  it("allocates projectless work on its chosen home and leaves ordinary projects to transfer", async () => {
    const { machines } = fakeMachines([]);
    machines.call = vi.fn(async () => ({ workspaceId: "ws-remote-scratch" }));
    machines.request = vi.fn(async () => ({ sessionId: "scratch-thread", path: "/sessions/scratch" }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    const classify = vi.fn(async (input: unknown) => (input as { workspace: string }).workspace === "ws-local-scratch");
    const workspace: HostExtension = { id: "tau.workspace", name: "Workspace fixture", activate(context) {
      context.registerCommand("is-projectless", classify, { access: "read", callers: [ENVIRONMENTS_EXTENSION_ID] });
    } };
    await registry.activate(workspace);
    const input = { machine: "rex", projectPath: "ws-local-scratch", prompt: "Write a note", backend: "codex" };
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", input)).toMatchObject({ sessionId: "scratch-thread" });
    expect(machines.call).toHaveBeenCalledExactlyOnceWith("rex", "tau.workspace", "create-scratch");
    expect(machines.request).toHaveBeenCalledExactlyOnceWith("rex", "start-thread", [{ cwd: "ws-remote-scratch", prompt: "Write a note", backend: "codex" }]);
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", { ...input, projectPath: "ws-project" })).toBeUndefined();
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", { ...input, prompt: undefined })).rejects.toThrow("provide a prompt");
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", input, { kind: "workbench-client", connection: "c1", pairedClient: "d1", readOnly: true })).rejects.toThrow(/Read.only|read.only/u);
    expect(machines.call).toHaveBeenCalledOnce();

  });

  it("rejects an older receiving kit rather than silently dropping images", async () => {
    const { machines } = fakeMachines([{ id: "rex", name: "rex", status: "connected", address: "wss://rex/" }]);
    machines.call = vi.fn(async () => { throw Object.assign(new Error("No thread-start command"), { code: "unknown-command" }); });
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "start-there", {
      machine: "rex", workspaceId: "ws-rex", prompt: "look", attachments: [{ kind: "image", name: "shot.png", mimeType: "image/png", data: "AA==", size: 1 }],
    })).rejects.toThrow("Update rex in Settings");
    expect(machines.request).not.toHaveBeenCalled();
  });

  it("reports the machines this host's agents reach, and again when they change", async () => {
    const list: HostMachine[] = [{ id: "rex-id", name: "rex", status: "connected", roundTripMs: 3, address: "wss://rex/" }];
    const { machines, changed } = fakeMachines(list);
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines }, (event) => events.push(event));
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "agents")).toEqual({ available: true, machines: [{ id: "rex-id", name: "rex", status: "connected", roundTripMs: 3 }] });
    list[0] = { ...list[0]!, status: "refused", detail: "revoked" };
    changed();
    expect(events.at(-1)).toMatchObject({ name: AGENTS_EVENT, payload: { machines: [{ status: "refused", detail: "revoked" }] } });
  });

  it("says there are none on a host that keeps no machines", async () => {
    const registry = await activateHostKit(createEnvironmentsHostExtension());
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "agents")).toEqual({ available: false, machines: [] });
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "probe", { machine: "rex" })).rejects.toThrow(/keeps no machines/u);
  });

  it("reaches the same kit on another machine, which names the device the call came as", async () => {
    const { machines } = fakeMachines([]);
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "probe", { machine: "rex" })).toMatchObject({ device: "agents-device", owner: false, ms: expect.any(Number) });
    expect(machines.call).toHaveBeenCalledWith("rex", ENVIRONMENTS_EXTENSION_ID, "whoami");
    const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: "d1" };
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "whoami", undefined, paired)).toEqual({ device: "d1", owner: false });
  });

  it("asks a machine how busy it is and what it could run, only when called", async () => {
    const { machines } = fakeMachines([]);
    machines.request = vi.fn(async (_machine: string, method: string) => ({ method }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    expect(machines.request).not.toHaveBeenCalled();
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", { machine: "rex" })).toEqual({ method: "host-resources" });
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "readiness", { machine: "mini-id" })).toEqual({ method: "readiness" });
    expect(machines.request).toHaveBeenCalledWith("rex", "host-resources", [], { timeoutMs: 20_000 });
    expect(machines.request).toHaveBeenCalledWith("mini-id", "readiness", [], { timeoutMs: 20_000 });
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", {})).rejects.toThrow(/name a machine/u);
    // A paired device may look.
    const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: "d1", readOnly: true as const };
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "readiness", { machine: "rex" }, paired)).resolves.toEqual({ method: "readiness" });
  });

  it("has nothing to ask on a host that keeps no machines", async () => {
    const registry = await activateHostKit(createEnvironmentsHostExtension());
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", { machine: "rex" })).rejects.toThrow(/keeps no machines/u);
  });

  it("registers the hidden backend and throttles index rescans to one per second, then cleans up", async () => {
    vi.useFakeTimers();
    try {
      const { machines } = fakeMachines([]);
      let changedIndex: (() => void) | undefined;
      const stopIndex = vi.fn();
      machines.index = () => ({ projects: [], sessions: [] });
      machines.followThread = vi.fn(() => () => undefined);
      machines.subscribeIndex = (listener) => { changedIndex = () => listener("rex-id"); return stopIndex; };
      const stopBackend = vi.fn();
      const registerRuntimeBackend = vi.fn(() => stopBackend);
      const refreshIndex = vi.fn(async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }));
      const registry = await activateHostKit(createEnvironmentsHostExtension(), {
        machines, registerRuntimeBackend, sessions: {
          list: async () => [], open: () => { throw new Error("Not used."); },
          prepare: async () => { throw new Error("Not used."); }, start: async () => { throw new Error("Not used."); },
          remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
          exclusive: (work) => work(), refreshIndex,
        },
      });
      expect(registerRuntimeBackend).toHaveBeenCalledWith(expect.objectContaining({ kind: "machine", hidden: true, order: 90 }));
      changedIndex?.();
      changedIndex?.();
      await vi.advanceTimersByTimeAsync(999);
      expect(refreshIndex).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshIndex).toHaveBeenCalledOnce();
      expect(refreshIndex).toHaveBeenCalledWith({ publish: true });
      changedIndex?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshIndex).toHaveBeenCalledTimes(2);
      changedIndex?.();
      await registry.deactivate(ENVIRONMENTS_EXTENSION_ID);
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshIndex).toHaveBeenCalledTimes(2);
      expect(stopIndex).toHaveBeenCalledOnce();
      expect(stopBackend).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
