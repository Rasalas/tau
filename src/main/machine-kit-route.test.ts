import { describe, expect, it, vi } from "vitest";
import { createHostMethods, invokeHostMethod } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import type { HostMachines } from "./host-machines.js";
import type { PiHost } from "./pi-host.js";
import { MachineKitRoute } from "./machine-kit-route.js";
import { activateHostKit } from "./test-support/host-kit-harness.js";
import type { HostPushEvent } from "../shared/host-transport.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";

const machine = "0123456789abcdef0123456789abcdef";
const workspace = "ws1_remote";

function fixture() {
  const local = vi.fn(async (..._args: unknown[]): Promise<unknown> => "local");
  const call = vi.fn(async (..._args: unknown[]): Promise<unknown> => "remote");
  let active = { sessionId: `${machine}~t1`, backendKind: "machine" };
  const authorize = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
  const host = {
    invokeHostExtension: local,
    authorizeHostExtension: authorize,
    activeThreadIdentity: () => active,
  } as unknown as PiHost;
  const stop = vi.fn();
  const listeners: Array<(event: { name: string; payload?: unknown }) => void> = [];
  const watch = vi.fn((_machine: string, _extension: string, _topic: string, listener: (event: { name: string; payload?: unknown }) => void) => { listeners.push(listener); return stop; });
  const machines = {
    list: () => [{ id: machine }],
    index: () => ({ projects: [{ workspaceId: "ws1_project" }], sessions: [{ id: "t1", workspaceId: workspace }] }),
    call, watch,
  } as unknown as HostMachines;
  const routes = new MachineKitRoute({ machines: () => machines, active: () => active });
  const unsupported = (): never => { throw new Error("not used"); };
  const methods = createHostMethods({
    bootstrap: unsupported, requireHost: async () => host, host: () => host,
    machines: () => machines, machineRoutes: routes, jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
      inspectExtensions: unsupported, loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported,
    },
  });
  return { local, call, authorize, host, machines, methods, routes, watch, stop, listeners, localActive: () => { active = { sessionId: "local", backendKind: "pi" }; } };
}

describe("machine kit routing", () => {
  it("sends Files read with the active thread's original workspace to its machine, never the local kit", async () => {
    const f = fixture();
    const input = { workspace, relPath: "README.md" };
    await expect(invokeHostMethod(f.methods, "host-extension", ["tau.files", "read", input])).resolves.toBe("remote");
    expect(f.call).toHaveBeenCalledWith(machine, "tau.files", "read", input);
    expect(f.local).not.toHaveBeenCalled();
  });

  it("routes either indexed workspace field, including project-only workspaces", () => {
    const f = fixture();
    f.localActive();
    for (const input of [{ workspace }, { workspaceId: workspace }, { workspace: "ws1_project" }]) {
      expect(f.routes.routeOf("tau.workspace", input)).toEqual({ machine, input });
    }
    expect(f.routes.routeOf("tau.workspace", { workspace: "ws1_local" })).toBeUndefined();
    expect(f.routes.routeOf("tau.preview", { workspace })).toBeUndefined();
  });

  it("ignores a peer's proxy projects so reciprocal indexes cannot bounce a workspace call", () => {
    const indexes = {
      a: { projects: [{ workspaceId: "ws1_a" }, { workspaceId: "ws1_b" }, { workspaceId: "ws1_here" }], sessions: [{ id: "own", backendKind: "pi", workspaceId: "ws1_a" }, { id: "b~one", backendKind: "machine", workspaceId: "ws1_b" }, { id: "here~one", backendKind: "machine", workspaceId: "ws1_here" }] },
      b: { projects: [{ workspaceId: "ws1_a" }, { workspaceId: "ws1_b" }, { workspaceId: "ws1_here" }], sessions: [{ id: "own", backendKind: "codex", workspaceId: "ws1_b" }, { id: "a~one", backendKind: "machine", workspaceId: "ws1_a" }, { id: "here~one", backendKind: "machine", workspaceId: "ws1_here" }] },
    };
    const machines = { list: () => [{ id: "a" }, { id: "b" }], index: (id: keyof typeof indexes) => indexes[id] } as unknown as HostMachines;
    const routes = new MachineKitRoute({ machines: () => machines, active: () => ({ sessionId: "local", backendKind: "pi" }) });
    expect(routes.routeOf("tau.files", { workspace: "ws1_b" })).toEqual({ machine: "b", input: { workspace: "ws1_b" } });
    expect(routes.routeOf("tau.files", { workspace: "ws1_a" })).toEqual({ machine: "a", input: { workspace: "ws1_a" } });
    expect(routes.routeOf("tau.files", { workspace: "ws1_here" })).toBeUndefined();
  });

  it("adds the active remote session's workspace to each routed kit, while local explicit calls stay here", () => {
    const f = fixture();
    for (const extension of ["tau.workspace", "tau.files", "tau.terminal", "tau.review"]) {
      expect(f.routes.routeOf(extension, { relPath: "a" })).toEqual({ machine, input: { relPath: "a", workspace } });
      expect(f.routes.routeOf(extension, { workspace: "ws1_local" })).toBeUndefined();
    }
    f.localActive();
    expect(f.routes.routeOf("tau.files", undefined)).toBeUndefined();
  });

  it("leaves the native folder dialog on the source host", async () => {
    const f = fixture();
    await invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "pick-folder"]);
    expect(f.local).toHaveBeenCalledWith("tau.workspace", "pick-folder", undefined, expect.anything());
    expect(f.call).not.toHaveBeenCalled();
  });

  it("checks source-client authority and audit before forwarding with the host's remote connection", async () => {
    const f = fixture();
    const registry = await activateHostKit({
      id: "tau.workspace", name: "Workspace", permissions: ["workspace:read", "workspace:write"],
      activate: (context) => {
        context.registerCommand("stage-file", vi.fn(), { audit: { label: "staged changes" } });
        context.registerCommand("changes", vi.fn(), { access: "read" });
      },
    });
    f.authorize.mockImplementation((...args) => registry.authorizeInvocation(args[0] as string, args[1] as string, args[2], args[3] as HostInvocationPrincipal));
    const audit = vi.fn();
    const reader: HostInvocationPrincipal = { kind: "workbench-client", pairedClient: "phone", readOnly: true, audit };
    await expect(invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "stage-file", { workspace, relPath: "a" }], reader)).rejects.toThrow(/read.only/i);
    expect(f.call).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "tau.workspace/stage-file", label: "staged changes" }), false);
    await invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "changes", { workspace }], reader);
    expect(f.call).toHaveBeenCalledOnce();
    const writer: HostInvocationPrincipal = { kind: "workbench-client", pairedClient: "phone", audit };
    await invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "stage-file", { workspace, relPath: "a" }], writer);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "tau.workspace/stage-file" }), true);
    await registry.deactivate("tau.workspace");
  });

  it("keeps a remote shell on its machine after navigation and unwraps its thread id", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ id: "s1", sessionId: "t1", workspaceId: workspace });
    const open = f.routes.routeOf("tau.terminal", { workspaceId: workspace, sessionId: `${machine}~t1` })!;
    await expect(f.routes.call(open, "tau.terminal", "open")).resolves.toMatchObject({ id: "s1", sessionId: `${machine}~t1` });
    expect(f.call).toHaveBeenCalledWith(machine, "tau.terminal", "open", { workspaceId: workspace, sessionId: "t1" });
    f.localActive();
    for (const command of ["input", "resize", "kill", "replay", "foreground", "restart"]) {
      expect(f.routes.routeOf("tau.terminal", { id: "s1", command })).toEqual({ machine, input: { id: "s1", command } });
    }
    expect(f.routes.routeOf("tau.terminal", { from: "s1" })).toEqual({ machine, input: { from: "s1" } });
    expect(f.routes.routeOf("tau.terminal", { id: "local-shell" })).toBeUndefined();
  });

  it("relays a known shell's output only to the watching client and stops watches on detach", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ id: "s1" });
    await f.routes.call(f.routes.routeOf("tau.terminal", {})!, "tau.terminal", "open");
    const first = vi.fn();
    const second = vi.fn();
    f.routes.subscribe("watching", ["tau.terminal/output/s1"], first);
    f.routes.subscribe("other", [], second);
    expect(f.watch).toHaveBeenCalledWith(machine, "tau.terminal", "output/s1", expect.any(Function));
    f.listeners[0]!({ name: "data", payload: { id: "s1", data: "rex", offset: 3 } });
    expect(first).toHaveBeenCalledWith({ type: "extension-event", extensionId: "tau.terminal", name: "data", topic: "output/s1", payload: { id: "s1", data: "rex", offset: 3 } });
    expect(second).not.toHaveBeenCalled();
    f.localActive();
    f.routes.refresh();
    expect(f.stop).not.toHaveBeenCalled();
    f.routes.detach("watching");
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("merges remote terminal lists and session events without losing local shells", async () => {
    const f = fixture();
    const remote = { id: "s1", sessionId: "t1", workspaceId: workspace };
    const local = { id: "local", workspaceId: "ws1_local" };
    f.call.mockResolvedValueOnce([remote]);
    await expect(f.routes.call(f.routes.routeOf("tau.terminal", {})!, "tau.terminal", "list", async () => [local])).resolves.toEqual([{ ...remote, sessionId: `${machine}~t1` }, local]);
    const emitted: HostPushEvent[] = [];
    f.routes.subscribe("watching", ["tau.terminal/sessions"], (event) => emitted.push(event));
    f.listeners[0]!({ name: "sessions", payload: [] });
    expect(emitted).toEqual([{ type: "extension-event", extensionId: "tau.terminal", name: "sessions", topic: "sessions", payload: [local] }]);
  });

  it("refreshes a watched remote terminal table after reconnect, and a newer push wins the read", async () => {
    let notify!: (machines: Array<{ id: string; status: string }>) => void;
    let event!: (event: { name: string; payload: unknown }) => void;
    let complete!: (value: unknown) => void;
    const call = vi.fn(async (..._args: unknown[]): Promise<unknown> => new Promise((resolve) => { complete = resolve; }));
    const machines = {
      list: () => [{ id: machine, status: "connected" }],
      subscribe: (listener: typeof notify) => { notify = listener; listener([{ id: machine, status: "connected" }]); return () => undefined; },
      watch: (_machine: string, _extension: string, _topic: string, listener: typeof event) => { event = listener; return () => undefined; },
      call,
    } as unknown as HostMachines;
    const routes = new MachineKitRoute({ machines: () => machines, active: () => ({ sessionId: `${machine}~t1`, backendKind: "machine" }) });
    const emit = vi.fn();
    routes.subscribe("watching", ["tau.terminal/sessions"], emit);
    notify([{ id: machine, status: "disconnected" }]);
    notify([{ id: machine, status: "connected" }]);
    expect(call).toHaveBeenCalledWith(machine, "tau.terminal", "list");
    event({ name: "sessions", payload: [{ id: "new", sessionId: "t1" }] });
    complete([{ id: "stale", sessionId: "t1" }]);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ payload: [{ id: "new", sessionId: `${machine}~t1` }] }));
    notify([{ id: machine, status: "disconnected" }]);
    notify([{ id: machine, status: "connected" }]);
    complete([]);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ payload: [] }));
  });

  it("translates checkpoint identity and moves Workspace watches when the active machine is left", () => {
    const f = fixture();
    const emit = vi.fn();
    f.routes.subscribe("watching", ["tau.workspace/checkpoints"], emit);
    f.listeners[0]!({ name: "checkpoint", payload: { type: "turn-checkpoint", sessionId: "t1", checkpoint: { id: "c1" } } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sessionId: `${machine}~t1` }) }));
    f.localActive();
    f.routes.refresh();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("recreates a watched subscription when a forgotten machine is added again", () => {
    const f = fixture();
    const list = vi.spyOn(f.machines, "list");
    f.routes.subscribe("watching", ["tau.workspace/head"], vi.fn());
    expect(f.watch).toHaveBeenCalledOnce();
    list.mockReturnValueOnce([]);
    f.routes.refresh();
    expect(f.stop).toHaveBeenCalledOnce();
    f.routes.refresh();
    expect(f.watch).toHaveBeenCalledTimes(2);
  });
});
