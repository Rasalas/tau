import type { HostExtensionContext, HostMachine, HostSessionSummary, HostTrashedThread } from "tau/host-extension";
import { decodeState } from "./meta.js";
import { THREAD_RAIL_EXTENSION_ID, TRASH_EVENT, type RailState } from "./protocol.js";

export const MACHINE_STATE_TOPIC = "machine-state";
export const MACHINE_META_EVENT = "machine-meta";
export const MACHINE_TRASH_EVENT = "machine-trash";

/** Copied from kits/environments/machine-backend.ts; kits cannot import one another. */
export function parseMachineThreadId(threadId: string): { machine: string; sessionId: string } | undefined {
  const separator = threadId.indexOf("~");
  return separator > 0 && separator < threadId.length - 1 ? { machine: threadId.slice(0, separator), sessionId: threadId.slice(separator + 1) } : undefined;
}

/** An indexed local id can contain a separator, even the name of a known machine. */
export function machineThreadOwner(id: string, sessions: ReadonlyMap<string, HostSessionSummary>, machines: readonly HostMachine[]): ReturnType<typeof parseMachineThreadId> {
  const session = sessions.get(id);
  if (session && !session.path.startsWith("tau-thread:machine:")) return undefined;
  const parsed = parseMachineThreadId(id);
  return parsed && (session || machines.some((machine) => machine.id === parsed.machine)) ? parsed : undefined;
}

/** Peers send only their own state. Their merged caches stay on their local clients. */
export function followMachineState(context: HostExtensionContext, changed: () => void, owner: (id: string) => ReturnType<typeof parseMachineThreadId>, cache?: { states: Record<string, RailState>; save(states: Record<string, RailState>): void }) {
  const machines = context.services.machines;
  if (!machines) return {
    merged: (local: RailState) => local,
    mergedTrash: (local: HostTrashedThread[]) => local,
    refresh: async (_machine: string) => undefined,
    dispose: () => undefined,
  };
  const states = new Map<string, RailState>(Object.entries(cache?.states ?? {}));
  const trash = new Map<string, HostTrashedThread[]>();
  const watches = new Map<string, () => void>();
  const connected = new Set<string>();
  const stateRevisions = new Map<string, number>();
  const trashRevisions = new Map<string, number>();
  const reads = new Map<string, Promise<void>>();
  const readAgain = new Set<string>();
  const bump = (revisions: Map<string, number>, machine: string) => {
    const revision = (revisions.get(machine) ?? 0) + 1;
    revisions.set(machine, revision);
    return revision;
  };
  let disposed = false;
  const publishTrash = async () => {
    const local = (await context.services.sessions.trash()).filter((entry) => entry.backendKind !== "machine");
    if (!disposed) context.emit(TRASH_EVENT, mergedTrash(local));
  };
  const setState = (machine: string, value: unknown) => { states.set(machine, decodeState(value)); cache?.save(Object.fromEntries(states)); changed(); };
  const setTrash = (machine: string, value: unknown) => {
    if (!Array.isArray(value)) return;
    trash.set(machine, value.filter((entry): entry is HostTrashedThread => !!entry && typeof entry === "object" && typeof entry.sessionId === "string" && entry.backendKind !== "machine"));
    void publishTrash().catch(logFailure);
  };
  const logFailure = (error: unknown) => context.services.log("thread-rail.machine-read-failed", error instanceof Error ? error.message : String(error));
  const refresh = async (machine: string) => {
    if (disposed || !connected.has(machine)) return;
    const pending = reads.get(machine);
    if (pending) {
      // Index pushes can outpace a slow read. Keep its answer usable, then
      // read once more for all the notifications that arrived meanwhile.
      readAgain.add(machine);
      await pending;
      // A caller refreshing after a write needs that follow-up's answer.
      return reads.get(machine);
    }
    const stateRevision = bump(stateRevisions, machine);
    const trashRevision = bump(trashRevisions, machine);
    const reading = Promise.all([
      machines.call(machine, THREAD_RAIL_EXTENSION_ID, "state", { homeOnly: true }).then((value) => {
        if (!disposed && connected.has(machine) && stateRevisions.get(machine) === stateRevision) setState(machine, value);
      }).catch(logFailure),
      machines.call(machine, THREAD_RAIL_EXTENSION_ID, "trash", { homeOnly: true }).then((value) => {
        if (!disposed && connected.has(machine) && trashRevisions.get(machine) === trashRevision) setTrash(machine, value);
      }).catch(logFailure),
    ]).then(() => undefined).finally(() => {
      reads.delete(machine);
      if (readAgain.delete(machine)) void refresh(machine);
    });
    reads.set(machine, reading);
    await reading;
  };
  const update = (list: readonly HostMachine[]) => {
    if (disposed) return;
    for (const [machine, stop] of watches) {
      if (!list.some((entry) => entry.id === machine)) { stop(); watches.delete(machine); states.delete(machine); trash.delete(machine); }
    }
    for (const machine of states.keys()) if (!list.some((entry) => entry.id === machine)) states.delete(machine);
    cache?.save(Object.fromEntries(states));
    const before = new Set(connected);
    connected.clear();
    for (const machine of list) {
      if (!watches.has(machine.id)) watches.set(machine.id, machines.watch(machine.id, MACHINE_STATE_TOPIC, (event) => {
        if (disposed || !connected.has(machine.id)) return;
        // A push is newer than any outstanding initial/index read.
        if (event.name === MACHINE_META_EVENT) {
          bump(stateRevisions, machine.id);
          setState(machine.id, event.payload);
        }
        if (event.name === MACHINE_TRASH_EVENT) {
          bump(trashRevisions, machine.id);
          setTrash(machine.id, event.payload);
        }
      }));
      if (machine.status === "connected") {
        connected.add(machine.id);
        if (!before.has(machine.id)) void refresh(machine.id);
      }
    }
    for (const machine of before) if (!connected.has(machine)) {
      bump(stateRevisions, machine);
      bump(trashRevisions, machine);
    }
    changed();
    void publishTrash().catch(logFailure);
  };
  const merged = (local: RailState): RailState => {
    const threads = { ...local.threads };
    // The index keeps cached rows while their home is offline. Their last
    // known pin, snooze and settled state must stay with those rows too.
    for (const [machine, state] of states) for (const [id, meta] of Object.entries(state.threads)) {
      const projectedId = `${machine}~${id}`;
      if (owner(projectedId)?.machine === machine) threads[projectedId] = meta;
    }
    return { threads, settings: local.settings };
  };
  const mergedTrash = (local: HostTrashedThread[]): HostTrashedThread[] => {
    const localIds = new Set(local.map((entry) => entry.sessionId));
    return [...local, ...[...connected].flatMap((machine) => (trash.get(machine) ?? []).flatMap((entry) => {
      const sessionId = `${machine}~${entry.sessionId}`;
      return !localIds.has(sessionId) && owner(sessionId)?.machine === machine ? [{ ...entry, sessionId }] : [];
    }))];
  };
  const stopMachines = machines.subscribe(update);
  const stopIndex = machines.subscribeIndex?.((machine) => { void refresh(machine); });
  update(machines.list());
  return {
    merged, mergedTrash, refresh,
    dispose() { disposed = true; stopMachines(); stopIndex?.(); for (const stop of watches.values()) stop(); },
  };
}
