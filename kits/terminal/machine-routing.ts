import type { HostMachineRoutingAdapter, HostMachineRoutingPolicy } from "tau/host-extension";

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const localIds = (machine: string, value: unknown): unknown => Array.isArray(value) ? value.map((item) => localIds(machine, item)) : typeof fields(value).sessionId === "string" ? { ...fields(value), sessionId: `${machine}~${fields(value).sessionId}` } : value;

/** Terminal owns shell identity, merged inventories and reconnect recovery. */
export const terminalMachineRouting: HostMachineRoutingPolicy = {
  create(context): HostMachineRoutingAdapter {
    const shellMachine = new Map<string, string>();
    const lists = new Map<string, unknown[]>();
    const revisions = new Map<string, number>();
    let disposed = false;
    const revision = (machine: string) => revisions.get(machine) ?? 0;
    const revise = (machine: string) => revisions.set(machine, revision(machine) + 1);
    const terminals = () => [...lists.values()].flat();
    const remoteEvent = (machine: string, name: string, payload: unknown): unknown => {
      const translated = localIds(machine, payload);
      if (name !== "sessions" || !Array.isArray(translated)) return translated;
      revise(machine);
      lists.set(machine, translated);
      for (const session of translated) {
        const id = fields(session).id;
        if (typeof id === "string") shellMachine.set(id, machine);
      }
      return terminals();
    };
    return {
      route(input) {
        const item = fields(input);
        if (typeof (item.workspace ?? item.workspaceId) === "string") return undefined;
        const id = item.id ?? item.from;
        return typeof id === "string" ? shellMachine.get(id) ?? null : undefined;
      },
      beforeCall: revision,
      async remoteResult(machine, command, input, result, local, startedAt) {
        const item = fields(input);
        for (const record of Array.isArray(result) ? result : [result]) {
          const id = fields(record).id;
          if (typeof id === "string") shellMachine.set(id, machine);
        }
        if (command === "open" || command === "restart") {
          const id = fields(result).id;
          if (typeof id === "string") lists.set(machine, [...(lists.get(machine) ?? []).filter((record) => fields(record).id !== id && fields(record).id !== item.id), localIds(machine, result)]);
        } else if (command === "kill") lists.set(machine, (lists.get(machine) ?? []).filter((record) => fields(record).id !== item.id));
        if (command === "list" && Array.isArray(result)) {
          if (revision(machine) === startedAt) remoteEvent(machine, "sessions", result);
          if (local) {
            const records = await local();
            if (Array.isArray(records)) lists.set("", records);
          }
        }
        return command === "list" ? terminals() : localIds(machine, result);
      },
      localResult(command, result) {
        if (command !== "list" || !Array.isArray(result)) return result;
        lists.set("", result);
        return terminals();
      },
      localEvent(name, payload) {
        if (name !== "sessions" || !Array.isArray(payload)) return payload;
        lists.set("", payload);
        return terminals();
      },
      remoteEvent,
      owners(topic) {
        const active = context.activeMachine();
        if (topic === "sessions") return [...new Set([active, ...[...lists].filter(([machine, records]) => machine && records.length > 0).map(([machine]) => machine)].filter((machine): machine is string => Boolean(machine)))];
        const owner = topic.startsWith("output/") ? shellMachine.get(topic.slice("output/".length)) : active;
        return owner ? [owner] : [];
      },
      reconnect(machine) {
        if (context.activeMachine() !== machine && !lists.has(machine) || !context.watching("sessions")) return;
        revise(machine);
        const startedAt = revision(machine);
        void context.call(machine, "list").then((result) => {
          if (disposed || !context.connected(machine) || revision(machine) !== startedAt || !Array.isArray(result)) return;
          context.emit("sessions", remoteEvent(machine, "sessions", result), "sessions");
          context.refresh();
        }).catch(() => { /* Another connection or explicit list retries. */ });
      },
      dispose() { disposed = true; lists.clear(); shellMachine.clear(); },
    };
  },
};
