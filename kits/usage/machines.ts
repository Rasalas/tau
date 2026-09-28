import { useEffect, useState } from "react";
import type { PlatformEnvironments } from "tau";
import type { UsageEntry, UsageLimitsSummary, UsageSummary } from "./protocol.js";

/** Another machine this window reaches, by its host id. */
export interface UsageMachine {
  id: string;
  name: string;
}

/** What one other machine's Usage answered, or why it did not. */
export interface MachineRead {
  machine: UsageMachine;
  summary?: UsageSummary;
  limits?: UsageLimitsSummary;
  error?: string;
}

/**
 * The machines besides the one the page shows that the window is connected
 * to now. A browser or a phone has no list (`environments` undefined), and
 * so reads only the host it talks to.
 */
export function otherMachines(environments: PlatformEnvironments | undefined): UsageMachine[] {
  const snapshot = environments?.readExtension ? environments.getSnapshot() : undefined;
  return (snapshot?.environments ?? [])
    .filter((machine) => machine.id !== snapshot!.shown && machine.status === "connected")
    .map((machine) => ({ id: machine.id, name: machine.name }));
}

export function useOtherMachines(environments: PlatformEnvironments | undefined): UsageMachine[] {
  const [machines, setMachines] = useState<UsageMachine[]>(() => otherMachines(environments));
  useEffect(() => {
    if (!environments) return undefined;
    const update = () => setMachines((current) => {
      const next = otherMachines(environments);
      return next.length === current.length && next.every((machine, index) => machine.id === current[index]!.id && machine.name === current[index]!.name) ? current : next;
    });
    update();
    return environments.subscribe(update);
  }, [environments]);
  return machines;
}

/** Every machine's entries in one list, another machine's marked with its id. */
export function mergeEntries(local: readonly UsageEntry[], reads: readonly MachineRead[]): UsageEntry[] {
  return [...local, ...reads.flatMap((read) => (read.summary?.entries ?? []).map((entry) => ({ ...entry, machine: read.machine.id })))];
}

/**
 * Every machine's limits in one answer. Another machine's accounts carry its
 * id and say where they are ("Codex on rex"); one with an identity still
 * joins the same account read here (`groupAccounts`).
 */
export function mergeLimits(local: UsageLimitsSummary | undefined, reads: readonly MachineRead[]): UsageLimitsSummary | undefined {
  const remote = reads.filter((read) => read.limits);
  if (!local && remote.length === 0) return undefined;
  const tag = (read: MachineRead) => <T extends { runtime: string; label: string }>(account: T) => ({ ...account, machine: read.machine.id, label: `${account.label} on ${read.machine.name}` });
  return {
    checkedAt: Math.max(local?.checkedAt ?? 0, ...remote.map((read) => read.limits!.checkedAt)),
    accounts: [...(local?.accounts ?? []), ...remote.flatMap((read) => read.limits!.accounts.map(tag(read)))],
    sources: [
      ...(local?.sources ?? []),
      ...reads.flatMap((read) => read.limits
        ? read.limits.sources.map((source) => ({ ...source, label: `${source.label} on ${read.machine.name}` }))
        : [{ extensionId: `${read.machine.id}:tau.usage`, label: `Usage on ${read.machine.name}`, status: "unavailable" as const, detail: `Not available: ${read.error ?? "no answer"}.` }]),
    ],
    history: [...(local?.history ?? []), ...remote.flatMap((read) => (read.limits!.history ?? []).map((sample) => ({ ...sample, account: tag(read)(sample.account) })))],
  };
}
