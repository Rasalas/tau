import { vi } from "vitest";
import { MachineKitRoute } from "../machine-kit-route.js";
import type { HostMachineRoutingPolicy, HostMachineRoutingContribution } from "../host-machine-routing.js";
import type { HostMachines } from "../host-machines.js";
import type { PiHost } from "../pi-host.js";

export const machine = "0123456789abcdef0123456789abcdef";
export const workspace = "ws1_remote";
const contribution = (policy: HostMachineRoutingPolicy) => {
  const value: HostMachineRoutingContribution = { policy, onDispose: () => () => undefined };
  return (id: string) => id === "tau.terminal" ? value : undefined;
};

export function createMachineRoutingFixture(policy: HostMachineRoutingPolicy) {
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
  const routes = new MachineKitRoute({ routing: contribution(policy), machines: () => machines, active: () => active });
  return { local, call, authorize, host, machines, routes, watch, stop, listeners, localActive: () => { active = { sessionId: "local", backendKind: "pi" }; } };
}

export function createMachineReconnectFixture(policy: HostMachineRoutingPolicy) {
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
  const routes = new MachineKitRoute({ routing: contribution(policy), machines: () => machines, active: () => ({ sessionId: `${machine}~t1`, backendKind: "machine" }) });
  return { routes, call, notify: (value: Parameters<typeof notify>[0]) => notify(value), event: (value: Parameters<typeof event>[0]) => event(value), complete: (value: unknown) => complete(value) };
}
