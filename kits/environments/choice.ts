import type { HostReadiness, HostResources, RuntimeReadinessState } from "tau/host-extension";

/** T3's limits: a reading older than 15 s (from when it arrived here), CPU at 95 %, 5 % memory free. */
export const READING_MAX_AGE_MS = 15_000;
export const CPU_LIMIT = 0.95;
export const MEMORY_FLOOR = 0.05;

/** Weights run 0–100; 0 keeps a machine out of every automatic choice. This computer is spared by default. */
export const MAX_WEIGHT = 100;
export const LOCAL_WEIGHT = 5;
export const MACHINE_WEIGHT = 50;

export type MachineWeights = Readonly<Record<string, number>>;

export function weightOf(weights: MachineWeights, id: string, local: boolean): number {
  const value = weights[id];
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_WEIGHT, Math.max(0, Math.round(value))) : local ? LOCAL_WEIGHT : MACHINE_WEIGHT;
}

/** `values.tau.environments.weights`: a JSON object of host id to weight. */
export function readWeights(raw: unknown): Record<string, number> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch {
    return {};
  }
}

export interface MachineCandidate {
  id: string;
  name: string;
  /** This computer. */
  local?: boolean;
  weight: number;
  resources?: HostResources;
  /** When the reading arrived here, on this host's clock; `sampledAt` is the other machine's. */
  receivedAt?: number;
  readiness?: HostReadiness;
  /** Why it cannot take work at all now (offline, Read only, did not answer). */
  unavailable?: string;
}

export interface MachineNeeds {
  /** Runtime backend kind; Pi when absent. */
  backend?: string;
  /** `provider/id`. */
  model?: string;
}

export interface MachineVerdict {
  id: string;
  name: string;
  local?: boolean;
  score?: number;
  /** Weight, cores, CPU and memory behind `score`. */
  facts?: string;
  /** Why it was left out. */
  excluded?: string;
}

export interface MachineChoice {
  /** Absent when no machine qualifies. */
  chosen?: MachineVerdict;
  /** One line for a tooltip. */
  reason: string;
  verdicts: MachineVerdict[];
}

const NOT_READY: Record<Exclude<RuntimeReadinessState, "ready">, string> = {
  "sign-in-required": "is not signed in",
  "not-installed": "is not installed",
  "unavailable": "is unavailable",
  "checking": "has not answered yet",
};

const percent = (share: number) => `${Math.round(share * 100)} %`;

function runtimeProblem(readiness: HostReadiness | undefined, needs: MachineNeeds): string | undefined {
  if (!readiness) return "what it can run is unknown";
  const kind = needs.backend ?? "pi";
  const runtime = readiness.runtimes.find((entry) => entry.kind === kind);
  if (!runtime) return `it has no ${kind}`;
  if (runtime.state !== "ready") return `${runtime.label} ${NOT_READY[runtime.state]}`;
  if (needs.model && runtime.modelIds && !runtime.modelIds.includes(needs.model)) return `${runtime.label} there has no ${needs.model}`;
  return undefined;
}

/** Why a machine is left out, or its score. T3's filter, then readiness and the budget of one turn per core. */
function judge(candidate: MachineCandidate, needs: MachineNeeds, now: number): MachineVerdict {
  const base = { id: candidate.id, name: candidate.name, ...(candidate.local ? { local: true } : {}) };
  const out = (excluded: string): MachineVerdict => ({ ...base, excluded });
  if (candidate.unavailable) return out(candidate.unavailable);
  if (!Number.isFinite(candidate.weight) || candidate.weight <= 0) return out("weight 0, never automatically");
  const problem = runtimeProblem(candidate.readiness, needs);
  if (problem) return out(problem);
  const { resources, receivedAt } = candidate;
  if (!resources || receivedAt === undefined) return out("no reading of its load");
  if (now - receivedAt > READING_MAX_AGE_MS) return out(`its reading is ${Math.round((now - receivedAt) / 1000)} s old`);
  if (receivedAt > now + 5_000) return out("its reading comes from the future");
  if (resources.cpuUtilization === undefined) return out("its CPU was not measured yet");
  if (resources.cpuUtilization >= CPU_LIMIT) return out(`CPU ${percent(resources.cpuUtilization)}`);
  if (resources.totalMemory <= 0 || resources.cpuCount <= 0) return out("no usable reading");
  const memory = resources.availableMemory / resources.totalMemory;
  if (memory <= MEMORY_FLOOR) return out(`only ${percent(memory)} memory free`);
  if (resources.runningTurns >= resources.cpuCount) return out(`${resources.runningTurns} turns running on ${resources.cpuCount} cores`);
  const score = candidate.weight * resources.cpuCount * (1 - resources.cpuUtilization) * memory;
  const facts = `weight ${candidate.weight} · ${resources.cpuCount} ${resources.cpuCount === 1 ? "core" : "cores"} · CPU ${percent(resources.cpuUtilization)} · ${percent(memory)} memory free`;
  return { ...base, score, facts };
}

const who = (verdict: MachineVerdict) => (verdict.local ? "this computer" : verdict.name);
const rounded = (score: number) => (score >= 10 ? Math.round(score) : Math.round(score * 10) / 10);

/**
 * Where new work goes: the machine with the highest weight × cores × idle CPU
 * share × free memory share, among the ones that can run it now. Ties go to
 * the earlier candidate. Pure; the host half gathers the readings.
 */
export function chooseMachine(candidates: readonly MachineCandidate[], needs: MachineNeeds, now: number): MachineChoice {
  const verdicts = candidates.map((candidate) => judge(candidate, needs, now));
  let chosen: MachineVerdict | undefined;
  for (const verdict of verdicts) {
    if (verdict.score !== undefined && (!chosen || verdict.score > chosen.score!)) chosen = verdict;
  }
  const others = verdicts.filter((verdict) => verdict !== chosen).map((verdict) => (verdict.excluded ? `${who(verdict)} left out: ${verdict.excluded}` : `${who(verdict)} ${rounded(verdict.score!)}`));
  if (!chosen) return { reason: `No machine can take it now${others.length ? ` (${others.join("; ")})` : ""}.`, verdicts };
  const head = `${chosen.local ? "This computer" : chosen.name} has the most room: ${rounded(chosen.score!)} (${chosen.facts})`;
  return { chosen, reason: others.length ? `${head}; ${others.join("; ")}.` : `${head}.`, verdicts };
}
