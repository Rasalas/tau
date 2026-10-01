import type { HostEvent } from "../shared/contracts.js";
import type { HostPushEvent } from "../shared/host-transport.js";
import type { HostMachines } from "./host-machines.js";

// These kits own the workspace features named in ADR 0030.
const ROUTED_KITS = new Set(["tau.workspace", "tau.files", "tau.terminal", "tau.review"]);
type Identity = { sessionId: string; backendKind: string };
type Route = { machine: string; input: unknown };
type Client = { topics: readonly string[]; emit(event: HostPushEvent): void; stops: Array<() => void>; key: string };

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export class MachineKitRoute {
  private readonly shellMachine = new Map<string, string>();
  private readonly clients = new Map<string, Client>();
  private readonly terminalLists = new Map<string, unknown[]>();
  private readonly terminalRevisions = new Map<string, number>();
  private connected = new Set<string>();

  constructor(private readonly deps: { machines(): HostMachines | undefined; active(): Identity | undefined }) {
    deps.machines()?.subscribe?.((machines) => {
      const before = this.connected;
      this.connected = new Set(machines.filter((machine) => machine.status === "connected").map((machine) => machine.id));
      this.refresh();
      for (const machine of this.connected) if (!before.has(machine)) this.recoverTerminals(machine);
    });
  }

  private revision(machine: string): number { return this.terminalRevisions.get(machine) ?? 0; }
  private revise(machine: string): void { this.terminalRevisions.set(machine, this.revision(machine) + 1); }

  /** A remote monitor's resync restores its index; the kit's session table needs its own read. */
  private recoverTerminals(machine: string): void {
    if (this.activeMachine()?.machine !== machine && !this.terminalLists.has(machine)) return;
    if (![...this.clients.values()].some((client) => client.topics.includes("tau.terminal/sessions"))) return;
    this.revise(machine);
    const revision = this.revision(machine);
    void this.deps.machines()?.call(machine, "tau.terminal", "list").then((result) => {
      if (!this.connected.has(machine) || this.revision(machine) !== revision || !Array.isArray(result)) return;
      const payload = this.remotePayload(machine, "tau.terminal", "sessions", result);
      for (const client of this.clients.values()) if (client.topics.includes("tau.terminal/sessions")) client.emit({
        type: "extension-event", extensionId: "tau.terminal", name: "sessions", topic: "sessions", payload,
      });
      this.refresh();
    }).catch(() => { /* The next connection or explicit list refresh tries again. */ });
  }

  private activeMachine(): { machine: string; sessionId: string } | undefined {
    const active = this.deps.active();
    if (active?.backendKind !== "machine") return undefined;
    const split = active.sessionId.indexOf("~");
    return split > 0 ? { machine: active.sessionId.slice(0, split), sessionId: active.sessionId.slice(split + 1) } : undefined;
  }

  routeOf(extensionId: string, input: unknown): Route | undefined {
    if (!ROUTED_KITS.has(extensionId)) return undefined;
    const machines = this.deps.machines();
    if (!machines) return undefined;
    const item = fields(input);
    const named = item.workspace ?? item.workspaceId;
    if (typeof named === "string") {
      for (const machine of machines.list()) {
        const index = machines.index(machine.id);
        if (!index) continue;
        const home = index.sessions.some((session) => session.backendKind !== "machine" && session.workspaceId === named);
        const proxy = index.sessions.some((session) => session.backendKind === "machine" && session.workspaceId === named);
        // A peer also lists workspaces of its proxies; only the original home may receive the call.
        if (home || !proxy && index.projects.some((project) => project.workspaceId === named)) return { machine: machine.id, input };
      }
      return undefined;
    }
    if (extensionId === "tau.terminal" && typeof item.id === "string") {
      const machine = this.shellMachine.get(item.id);
      if (machine) return { machine, input };
      // An existing local shell stays local even while a remote thread is shown.
      return undefined;
    }
    if (extensionId === "tau.terminal" && typeof item.from === "string") {
      const machine = this.shellMachine.get(item.from);
      return machine ? { machine, input } : undefined;
    }
    const active = this.activeMachine();
    if (!active) return undefined;
    const workspace = machines.index(active.machine)?.sessions.find((session) => session.id === active.sessionId)?.workspaceId;
    if (!workspace) throw new Error("The machine has not published this thread's workspace.");
    return { machine: active.machine, input: { ...item, workspace } };
  }

  async call(route: Route, extensionId: string, command: string, readLocalTerminals?: () => Promise<unknown>): Promise<unknown> {
    const machines = this.deps.machines();
    if (!machines) throw new Error("Machine connections are unavailable.");
    const item = fields(route.input);
    const prefix = `${route.machine}~`;
    const input = typeof item.sessionId === "string" && item.sessionId.startsWith(prefix)
      ? { ...item, sessionId: item.sessionId.slice(prefix.length) } : route.input;
    const revision = this.revision(route.machine);
    const result = await machines.call(route.machine, extensionId, command, input);
    if (extensionId === "tau.terminal") {
      const records = Array.isArray(result) ? result : [result];
      for (const record of records) {
        const id = fields(record).id;
        if (typeof id === "string") this.shellMachine.set(id, route.machine);
      }
      if (command === "open" || command === "restart") {
        const id = fields(result).id;
        if (typeof id === "string") {
          const previous = (this.terminalLists.get(route.machine) ?? []).filter((record) => fields(record).id !== id && fields(record).id !== item.id);
          this.terminalLists.set(route.machine, [...previous, this.localIds(route.machine, result)]);
        }
      } else if (command === "kill") {
        this.terminalLists.set(route.machine, (this.terminalLists.get(route.machine) ?? []).filter((record) => fields(record).id !== item.id));
      }
      if (command === "list" && Array.isArray(result)) {
        if (this.revision(route.machine) === revision) this.remotePayload(route.machine, extensionId, "sessions", result);
        if (readLocalTerminals) {
          const local = await readLocalTerminals();
          if (Array.isArray(local)) this.terminalLists.set("", local);
        }
      }
    }
    this.refresh();
    return extensionId === "tau.terminal" && command === "list" ? this.terminals() : this.localIds(route.machine, result);
  }

  private localIds(machine: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.localIds(machine, item));
    const item = fields(value);
    return typeof item.sessionId === "string" ? { ...item, sessionId: `${machine}~${item.sessionId}` } : value;
  }

  private terminals(): unknown[] {
    return [...this.terminalLists.values()].flat();
  }

  /** Local and remote session lists update their own table, keeping shells of other machines. */
  localEvent(event: HostEvent): HostEvent {
    if (event.type !== "extension-event" || event.extensionId !== "tau.terminal" || event.name !== "sessions" || !Array.isArray(event.payload)) return event;
    this.terminalLists.set("", event.payload);
    return { ...event, payload: this.terminals() };
  }

  localResult(extension: string, command: string, result: unknown): unknown {
    if (extension !== "tau.terminal" || command !== "list" || !Array.isArray(result)) return result;
    this.terminalLists.set("", result);
    return this.terminals();
  }

  private remotePayload(machine: string, extension: string, name: string, payload: unknown): unknown {
    const translated = this.localIds(machine, payload);
    if (extension === "tau.terminal" && name === "sessions" && Array.isArray(translated)) {
      this.revise(machine);
      this.terminalLists.set(machine, translated);
      for (const session of translated) {
        const id = fields(session).id;
        if (typeof id === "string") this.shellMachine.set(id, machine);
      }
      return this.terminals();
    }
    return translated;
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
        const extension = key.slice(0, split);
        const topic = key.slice(split + 1);
        if (split <= 0 || !ROUTED_KITS.has(extension)) return [];
        const owners = extension === "tau.terminal" && topic === "sessions"
          ? [...new Set([active, ...[...this.terminalLists].filter(([machine, records]) => machine && records.length > 0).map(([machine]) => machine)].filter((machine): machine is string => Boolean(machine)))]
          : [extension === "tau.terminal" && topic.startsWith("output/") ? this.shellMachine.get(topic.slice("output/".length)) : active];
        return owners.flatMap((machine) => machine && available.has(machine) ? [{ extension, topic, machine }] : []);
      });
      const key = JSON.stringify(watches);
      if (client.key === key) continue;
      client.stops.splice(0).forEach((stop) => stop());
      client.key = key;
      if (!machines) continue;
      for (const watch of watches) {
        try {
          client.stops.push(machines.watch(watch.machine, watch.extension, watch.topic, (event) => client.emit({
            type: "extension-event", extensionId: watch.extension, name: event.name,
            payload: this.remotePayload(watch.machine, watch.extension, event.name, event.payload), topic: watch.topic,
          })));
        } catch { /* A removed machine has no connection to watch. */ }
      }
    }
  }

  detach(connection: string): void {
    this.clients.get(connection)?.stops.forEach((stop) => stop());
    this.clients.delete(connection);
  }
}
