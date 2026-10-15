import { describe, expect, it, vi } from "vitest";
import { terminalMachineRouting } from "./machine-routing.js";
import { createMachineRoutingFixture, createMachineReconnectFixture, machine, workspace } from "../../src/main/test-support/machine-routing-harness.js";
const fixture = () => createMachineRoutingFixture(terminalMachineRouting);

describe("Terminal machine routing", () => {
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
    const emitted: unknown[] = [];
    f.routes.subscribe("watching", ["tau.terminal/sessions"], (event) => emitted.push(event));
    f.listeners[0]!({ name: "sessions", payload: [] });
    expect(emitted).toEqual([{ type: "extension-event", extensionId: "tau.terminal", name: "sessions", topic: "sessions", payload: [local] }]);
  });

  it("refreshes a watched remote terminal table after reconnect, and a newer push wins the read", async () => {
    const { routes, call, notify, event, complete } = createMachineReconnectFixture(terminalMachineRouting);
    const emit = vi.fn();
    routes.subscribe("watching", ["tau.terminal/sessions"], emit);
    notify([{ id: machine, status: "disconnected" }]);
    notify([{ id: machine, status: "connected" }]);
    expect(call).toHaveBeenCalledWith(machine, "tau.terminal", "list", undefined);
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
});
