import type { HostEvent } from "../shared/contracts.js";
import type { HostPushEvent } from "../shared/host-transport.js";
import type { HostMachines } from "./host-machines.js";
import type { HostMachineRoutingAdapter, HostMachineRoutingContribution } from "./host-machine-routing.js";
import { machineKitError } from "../shared/machine-compatibility.js";
type Identity = { sessionId: string; backendKind: string };
type Route = { machine: string; input: unknown };
type Client = { topics: readonly string[]; emit(event: HostPushEvent): void; stops: Array<() => void>; key: string };
const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const CREATED_KEPT = 200;

/** Generic transport and workspace identity; feature policies live in their kits. */
export class MachineKitRoute {
  private readonly createdOn = new Map<string, string>();
  private readonly clients = new Map<string, Client>();
  private readonly adapters = new Map<string, { contribution: HostMachineRoutingContribution; adapter: HostMachineRoutingAdapter; stop: () => void }>();
  private connected = new Set<string>();
  private stopMachines?: () => void;
  private stopRouting?: () => void;

  constructor(private readonly deps: { machines(): HostMachines | undefined; active(): Identity | undefined; routing?(id: string): HostMachineRoutingContribution | undefined; observeRouting?(listener: () => void): (() => void) | undefined }) {
    this.stopMachines = deps.machines()?.subscribe?.((machines) => {
      const before = this.connected;
      this.connected = new Set(machines.filter((machine) => machine.status === "connected").map((machine) => machine.id));
      this.refresh();
      for (const machine of this.connected) if (!before.has(machine)) for (const { adapter } of this.adapters.values()) adapter.reconnect?.(machine);
    });
  }

  private adapter(id: string): HostMachineRoutingAdapter | undefined {
    this.stopRouting ??= this.deps.observeRouting?.(() => this.refresh());
    const contribution = this.deps.routing?.(id);
    const existing = this.adapters.get(id);
    if (existing?.contribution === contribution) return existing?.adapter;
    if (existing) { existing.stop(); existing.adapter.dispose?.(); this.adapters.delete(id); }
    if (!contribution) return undefined;
    const adapter = contribution.policy.create?.({
      activeMachine: () => this.activeMachine()?.machine,
      call: (machine, command, input) => this.remoteCall(machine, id, command, input),
      emit: (name, payload, topic) => {
        for (const client of this.clients.values()) if (client.topics.includes(`${id}/${topic}`)) client.emit({ type: "extension-event", extensionId: id, name, payload, topic });
      },
      refresh: () => this.refresh(),
      watching: (topic) => [...this.clients.values()].some((client) => client.topics.includes(`${id}/${topic}`)),
      connected: (machine) => this.connected.has(machine),
    }) ?? {};
    const stop = contribution.onDispose(() => {
      this.adapters.delete(id);
      // Rebuild watches even when a replacement registers the same topics.
      for (const client of this.clients.values()) client.key = "";
      try { adapter.dispose?.(); }
      finally { this.refresh(); }
    });
    this.adapters.set(id, { contribution, adapter, stop });
    return adapter;
  }

  private activeMachine(): { machine: string; sessionId: string } | undefined {
    const active = this.deps.active();
    if (active?.backendKind !== "machine") return undefined;
    const split = active.sessionId.indexOf("~");
    return split > 0 ? { machine: active.sessionId.slice(0, split), sessionId: active.sessionId.slice(split + 1) } : undefined;
  }

  /** The machine whose own workspace this is: listed in its index, or created there by a routed call. */
  private homeOf(workspaceId: string): { id: string; name: string } | undefined {
    const machines = this.deps.machines();
    if (!machines) return undefined;
    const created = this.createdOn.get(workspaceId);
    for (const machine of machines.list()) {
      if (machine.id === created) return machine;
      const index = machines.index(machine.id);
      if (!index) continue;
      const home = index.sessions.some((session) => session.backendKind !== "machine" && session.workspaceId === workspaceId);
      const proxy = index.sessions.some((session) => session.backendKind === "machine" && session.workspaceId === workspaceId);
      // A peer also lists workspaces of its proxies; only the original home may receive the call.
      if (home || !proxy && index.projects.some((project) => project.workspaceId === workspaceId)) return machine;
    }
    return undefined;
  }

  /** Names the machine a workspace this host does not know is on, for the error a client reads. */
  machineName(workspaceId: string): string | undefined {
    return this.homeOf(workspaceId)?.name;
  }

  routeOf(extensionId: string, input: unknown, command = ""): Route | undefined {
    const adapter = this.adapter(extensionId);
    if (!adapter || this.deps.routing?.(extensionId)?.policy.localCommands?.includes(command)) return undefined;
    const machines = this.deps.machines();
    if (!machines) return undefined;
    const item = fields(input);
    const named = item.workspace ?? item.workspaceId;
    if (typeof named === "string") {
      const home = this.homeOf(named);
      return home ? { machine: home.id, input } : undefined;
    }
    const selected = adapter.route?.(input);
    if (selected !== undefined) return selected === null ? undefined : { machine: selected, input };
    const active = this.activeMachine();
    if (!active) return undefined;
    const workspace = machines.index(active.machine)?.sessions.find((session) => session.id === active.sessionId)?.workspaceId;
    if (!workspace) throw new Error("The machine has not published this thread's workspace.");
    return { machine: active.machine, input: { ...item, workspace } };
  }

  private async remoteCall(machine: string, extension: string, command: string, input?: unknown): Promise<unknown> {
    const machines = this.deps.machines();
    if (!machines) throw new Error("Machine connections are unavailable.");
    try { return await machines.call(machine, extension, command, input); }
    catch (error) { throw machineKitError(error, machines.list().find((item) => item.id === machine)?.name ?? machine, extension, command); }
  }

  async call(route: Route, extensionId: string, command: string, readLocal?: () => Promise<unknown>): Promise<unknown> {
    const adapter = this.adapter(extensionId);
    const item = fields(route.input);
    const prefix = `${route.machine}~`;
    const input = typeof item.sessionId === "string" && item.sessionId.startsWith(prefix) ? { ...item, sessionId: item.sessionId.slice(prefix.length) } : route.input;
    const revision = adapter?.beforeCall?.(route.machine);
    const result = await this.remoteCall(route.machine, extensionId, command, input);
    const created = fields(result).workspaceId;
    if (typeof created === "string" && created) {
      this.createdOn.delete(created);
      this.createdOn.set(created, route.machine);
      if (this.createdOn.size > CREATED_KEPT) this.createdOn.delete(this.createdOn.keys().next().value!);
    }
    const translated = adapter?.remoteResult ? await adapter.remoteResult(route.machine, command, route.input, result, readLocal, revision) : this.localIds(route.machine, result);
    this.refresh();
    return translated;
  }

  private localIds(machine: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.localIds(machine, item));
    const item = fields(value);
    return typeof item.sessionId === "string" ? { ...item, sessionId: `${machine}~${item.sessionId}` } : value;
  }

  localEvent(event: HostEvent): HostEvent {
    if (event.type !== "extension-event") return event;
    const adapter = this.adapter(event.extensionId);
    return adapter?.localEvent ? { ...event, payload: adapter.localEvent(event.name, event.payload) } : event;
  }

  localResult(extension: string, command: string, result: unknown): unknown {
    const adapter = this.adapter(extension);
    return adapter?.localResult ? adapter.localResult(command, result) : result;
  }

  subscribe(connection: string, topics: readonly string[], emit: (event: HostPushEvent) => void): void {
    this.detach(connection);
    this.clients.set(connection, { topics, emit, stops: [], key: "" });
    this.refresh();
  }

  refresh(): void {
    const machines = this.deps.machines();
    const available = new Set(machines?.list().map((machine) => machine.id));
    const active = this.activeMachine()?.machine;
    for (const client of this.clients.values()) {
      const watches = client.topics.flatMap((key) => {
        const split = key.indexOf("/");
        if (split <= 0) return [];
        const extension = key.slice(0, split);
        const topic = key.slice(split + 1);
        const adapter = this.adapter(extension);
        if (!adapter) return [];
        const owners = adapter.owners?.(topic) ?? (active ? [active] : []);
        return owners.flatMap((machine) => available.has(machine) ? [{ extension, topic, machine }] : []);
      });
      const key = JSON.stringify(watches);
      if (client.key === key) continue;
      client.stops.splice(0).forEach((stop) => stop());
      client.key = key;
      if (!machines) continue;
      for (const watch of watches) {
        try {
          client.stops.push(machines.watch(watch.machine, watch.extension, watch.topic, (event) => {
            const adapter = this.adapter(watch.extension);
            if (!adapter) return;
            client.emit({ type: "extension-event", extensionId: watch.extension, name: event.name, payload: adapter.remoteEvent ? adapter.remoteEvent(watch.machine, event.name, event.payload) : this.localIds(watch.machine, event.payload), topic: watch.topic });
          }));
        } catch { /* A removed machine has no connection to watch. */ }
      }
    }
  }

  detach(connection: string): void {
    this.clients.get(connection)?.stops.forEach((stop) => stop());
    this.clients.delete(connection);
  }

  dispose(): void {
    this.stopMachines?.();
    this.stopRouting?.();
    for (const connection of this.clients.keys()) this.detach(connection);
    for (const { adapter, stop } of this.adapters.values()) { stop(); adapter.dispose?.(); }
    this.adapters.clear();
  }
}
