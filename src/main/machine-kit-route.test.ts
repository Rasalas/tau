import type { HostMachineRoutingContribution } from "./host-machine-routing.js";
import { describe, expect, it, vi } from "vitest";
import { createHostMethods, invokeHostMethod } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import type { HostMachines } from "./host-machines.js";
import type { PiHost } from "./pi-host.js";
import { MachineKitRoute } from "./machine-kit-route.js";
import { activateHostKit } from "./test-support/host-kit-harness.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";

const machine = "0123456789abcdef0123456789abcdef";
const workspace = "ws1_remote";

function routingContributions() {
  const policies = new Map<string, HostMachineRoutingContribution>([
    ["tau.workspace", { policy: { localCommands: ["pick-folder", "create-scratch", "create-project", "publish-visualization", "release-visualization"] }, onDispose: () => () => undefined }],
    ["tau.files", { policy: {}, onDispose: () => () => undefined }],
    ["tau.review", { policy: {}, onDispose: () => () => undefined }],
    ["tau.terminal", { policy: {}, onDispose: () => () => undefined }],
  ]);
  return (id: string) => policies.get(id);
}

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
  const routes = new MachineKitRoute({ routing: routingContributions(), machines: () => machines, active: () => active });
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
  it("keeps workspace identities returned inside a remote worktree listing on that machine", async () => {
    const f = fixture();
    const rootWorkspace = "ws1_remote_root";
    f.call.mockResolvedValueOnce([{ workspace, rootWorkspace }]);
    await invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "worktree-list", { workspace }]);
    expect(f.routes.routeOf("tau.workspace", { workspace: rootWorkspace }, "workspace-info")).toEqual({ machine, input: { workspace: rootWorkspace } });
  });

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
    const routes = new MachineKitRoute({ routing: routingContributions(), machines: () => machines, active: () => ({ sessionId: "local", backendKind: "pi" }) });
    expect(routes.routeOf("tau.files", { workspace: "ws1_b" })).toEqual({ machine: "b", input: { workspace: "ws1_b" } });
    expect(routes.routeOf("tau.files", { workspace: "ws1_a" })).toEqual({ machine: "a", input: { workspace: "ws1_a" } });
    expect(routes.routeOf("tau.files", { workspace: "ws1_here" })).toBeUndefined();
  });

  it("keeps a worktree it made on a machine there before that machine lists it, and names the machine to a client that names it here", async () => {
    const call = vi.fn(async (): Promise<unknown> => ({ workspaceId: "ws1_worktree", displayPath: "/srv/shop-worktrees/tau-1" }));
    const machines = { list: () => [{ id: machine, name: "rex" }], index: () => ({ projects: [{ workspaceId: workspace }], sessions: [] }), call } as unknown as HostMachines;
    const routes = new MachineKitRoute({ routing: routingContributions(), machines: () => machines, active: () => ({ sessionId: "local", backendKind: "pi" }) });
    const host = {
      invokeHostExtension: vi.fn(), authorizeHostExtension: vi.fn(async () => undefined), activeThreadIdentity: () => undefined,
      resolveWorkspacePath: () => { throw new Error("This host does not know that workspace."); },
    } as unknown as PiHost;
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
    await invokeHostMethod(methods, "host-extension", ["tau.workspace", "create-worktree", { branch: "tau/x", workspace }]);
    expect(call).toHaveBeenCalledWith(machine, "tau.workspace", "create-worktree", { branch: "tau/x", workspace });
    expect(routes.routeOf("tau.workspace", { workspace: "ws1_worktree" })).toEqual({ machine, input: { workspace: "ws1_worktree" } });
    await expect(invokeHostMethod(methods, "new-session", [undefined, [], "ws1_worktree"])).rejects.toThrow("This project is on rex. Choose rex under Run on to start a thread there.");
    await expect(invokeHostMethod(methods, "new-session", [undefined, [], "ws1_elsewhere"])).rejects.toThrow("This host does not know that workspace.");
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

describe("extension-contributed machine routing", () => {
  it("cleans up a failed routing activation and all disposal observers", async () => {
    const registry = await activateHostKit({ id: "acme.seed", name: "Seed", activate() {} });
    const stopObserver = registry.observeMachineRouting(() => { throw new Error("watch failed"); });
    const extension = { id: "acme.routing", name: "Routing", activate(context: import("./host-extensions.js").HostExtensionContext) { context.registerMachineRouting(); } };
    await expect(registry.activate(extension)).resolves.toBe(false);
    expect(registry.machineRoutingFor(extension.id)).toBeUndefined();
    stopObserver();
    await expect(registry.activate(extension)).resolves.toBe(true);
    const released = vi.fn();
    registry.machineRoutingFor(extension.id)!.onDispose(() => { throw new Error("adapter failed"); });
    registry.machineRoutingFor(extension.id)!.onDispose(released);
    await expect(registry.deactivate(extension.id)).rejects.toThrow();
    expect(released).toHaveBeenCalledOnce();
    expect(registry.machineRoutingFor(extension.id)).toBeUndefined();
    await registry.dispose();
  });

  it("routes an arbitrary kit, relays its topics and replaces watches on reload", async () => {
    const extension = {
      id: "acme.inspector", name: "Inspector",
      activate(context: import("./host-extensions.js").HostExtensionContext) {
        context.registerMachineRouting({ localCommands: ["window"] });
        context.registerCommand("read", () => "local", { access: "read" });
        context.registerCommand("window", () => "window", { access: "read" });
      },
    };
    const registry = await activateHostKit(extension);
    const f = fixture();
    const routes = new MachineKitRoute({
      machines: () => f.machines,
      active: () => ({ sessionId: `${machine}~t1`, backendKind: "machine" }),
      routing: (id) => registry.machineRoutingFor(id),
      observeRouting: (listener) => registry.observeMachineRouting(listener),
    });
    const route = routes.routeOf(extension.id, { path: "hello" }, "read")!;
    expect(route).toEqual({ machine, input: { path: "hello", workspace } });
    expect(routes.routeOf(extension.id, undefined, "window")).toBeUndefined();
    expect(routes.routeOf("acme.unregistered", { workspace })).toBeUndefined();
    await expect(routes.call(route, extension.id, "read")).resolves.toBe("remote");
    const emit = vi.fn();
    routes.subscribe("inspector", [`${extension.id}/changes`], emit);
    expect(f.watch).toHaveBeenLastCalledWith(machine, extension.id, "changes", expect.any(Function));
    f.listeners.at(-1)!({ name: "changed", payload: { sessionId: "t1" } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ extensionId: extension.id, topic: "changes", payload: { sessionId: `${machine}~t1` } }));
    await registry.deactivate(extension.id);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(routes.routeOf(extension.id, { workspace })).toBeUndefined();
    await registry.activate(extension);
    expect(f.watch).toHaveBeenCalledTimes(2);
    routes.dispose();
    expect(f.stop).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("never forwards an owner command for a paired device", async () => {
    const f = fixture();
    const registry = await activateHostKit({ id: "tau.workspace", name: "Workspace", activate(context) {
      context.registerMachineRouting();
      context.registerCommand("owner-only", () => undefined, { access: "owner" });
    } });
    f.authorize.mockImplementation((...args) => registry.authorizeInvocation(args[0] as string, args[1] as string, args[2], args[3] as HostInvocationPrincipal));
    await expect(invokeHostMethod(f.methods, "host-extension", ["tau.workspace", "owner-only", { workspace }], { kind: "workbench-client", pairedClient: "phone" })).rejects.toThrow(/owner|this machine/i);
    expect(f.call).not.toHaveBeenCalled();
    await registry.dispose();
  });
});
