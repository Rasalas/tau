import type { HostMachineServices, HostReadiness, HostResources } from "tau/host-extension";
import { chooseMachine, weightOf, type MachineCandidate, type MachineWeights } from "./choice.js";
import type { ChooseMachineAnswer, ChooseMachineInput } from "./protocol.js";

/** A reading this old is taken again, so it is still within the 15 s when the choice is made. */
const RESOURCES_REFRESH_MS = 10_000;
/** A first reading watches the counters for 5 s. */
const RESOURCES_TIMEOUT_MS = 12_000;
/** Readiness asks every runtime and waits up to 5 s for each; it changes seldom. */
const READINESS_REFRESH_MS = 60_000;
const READINESS_TIMEOUT_MS = 20_000;

interface Kept<T> { value: T; receivedAt: number }

export interface MachineChooserPorts {
  machines(): HostMachineServices | undefined;
  weights(): Promise<MachineWeights>;
  now?(): number;
}

/**
 * Gathers each machine's load and readiness through `services.machines`
 * (this computer by its own id), timed by when the answer arrived here, and
 * hands them to `chooseMachine`.
 */
export function createMachineChooser(ports: MachineChooserPorts) {
  const now = () => ports.now?.() ?? Date.now();
  const resources = new Map<string, Kept<HostResources>>();
  const readiness = new Map<string, Kept<HostReadiness>>();
  const asking = new Map<string, Promise<void>>();

  const refresh = <T,>(kept: Map<string, Kept<T>>, machines: HostMachineServices, id: string, method: string, maxAge: number, timeoutMs: number): Promise<void> => {
    const held = kept.get(id);
    if (held && now() - held.receivedAt < maxAge) return Promise.resolve();
    const key = `${method}\n${id}`;
    let pending = asking.get(key);
    if (!pending) {
      pending = machines.request(id, method, [], { timeoutMs })
        .then((value) => { kept.set(id, { value: value as T, receivedAt: now() }); })
        .finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    return pending;
  };

  return async function choose(input: ChooseMachineInput): Promise<ChooseMachineAnswer> {
    const machines = ports.machines();
    if (!machines) return { machine: null, reason: "This host keeps no other machines; this computer runs it.", machines: [] };
    const weights = await ports.weights();
    const allowed = input.machines ? new Set(input.machines) : undefined;
    const others = machines.list().filter((machine) => machine.id !== machines.self.id && (!allowed || allowed.has(machine.id)));
    const candidates = await Promise.all([{ id: machines.self.id, name: machines.self.name, local: true }, ...others].map(async (machine): Promise<MachineCandidate> => {
      const local = "local" in machine;
      const base = { id: machine.id, name: machine.name, ...(local ? { local: true } : {}), weight: weightOf(weights, machine.id, local) };
      if (!local) {
        if (machine.status !== "connected") return { ...base, unavailable: machine.status };
        if (machine.readOnly) return { ...base, unavailable: "Read only for this computer's agents" };
      }
      if (base.weight <= 0) return base;
      const results = await Promise.allSettled([
        refresh(resources, machines, machine.id, "host-resources", RESOURCES_REFRESH_MS, RESOURCES_TIMEOUT_MS),
        refresh(readiness, machines, machine.id, "readiness", READINESS_REFRESH_MS, READINESS_TIMEOUT_MS),
      ]);
      const reading = resources.get(machine.id);
      const ready = readiness.get(machine.id);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      // A machine that stopped answering is out, unless what it said last is still fresh.
      if (failed && (!reading || !ready)) return { ...base, unavailable: `did not answer: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}` };
      return { ...base, ...(reading ? { resources: reading.value, receivedAt: reading.receivedAt } : {}), ...(ready ? { readiness: ready.value } : {}) };
    }));
    const choice = chooseMachine(candidates, { ...(input.backend ? { backend: input.backend } : {}), ...(input.model ? { model: input.model } : {}) }, now());
    const machine = choice.chosen && !choice.chosen.local ? choice.chosen.id : null;
    return { machine, reason: choice.chosen ? choice.reason : `${choice.reason} This computer runs it.`, machines: choice.verdicts };
  };
}
