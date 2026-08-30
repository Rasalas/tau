import { performance } from "node:perf_hooks";

export type LifecycleMode = "full" | "safe";
export type LifecycleScenario = "bootstrap" | "cold-switch" | "warm-switch";

export interface LifecyclePhase {
  name: string;
  durationMs: number;
}

export interface LifecycleMeasurement {
  mode: LifecycleMode;
  scenario: LifecycleScenario;
  phases: LifecyclePhase[];
  totalMs: number;
  subprocesses: number;
  ipcBytes: number;
}

/** Small instrumentation collector used by the host and repeatable fixtures. */
export class HostLifecycleInstrumentation {
  private readonly measurements: LifecycleMeasurement[] = [];
  private active?: { mode: LifecycleMode; scenario: LifecycleScenario; startedAt: number; phases: LifecyclePhase[]; subprocesses: number; ipcBytes: number };

  isActive(): boolean { return this.active !== undefined; }

  begin(mode: LifecycleMode, scenario: LifecycleScenario): void {
    if (this.active) throw new Error("A host lifecycle measurement is already active");
    this.active = { mode, scenario, startedAt: performance.now(), phases: [], subprocesses: 0, ipcBytes: 0 };
  }

  phase(name: string, startedAt: number): void {
    if (!this.active) return;
    this.active.phases.push({ name, durationMs: round(performance.now() - startedAt) });
  }

  countSubprocess(): void { if (this.active) this.active.subprocesses += 1; }
  recordIpc(payload: unknown): void {
    if (!this.active) return;
    try { this.active.ipcBytes += Buffer.byteLength(JSON.stringify(payload), "utf8"); } catch { /* diagnostics never break lifecycle */ }
  }

  end(): LifecycleMeasurement | undefined {
    if (!this.active) return undefined;
    const active = this.active;
    this.active = undefined;
    const measurement: LifecycleMeasurement = {
      mode: active.mode,
      scenario: active.scenario,
      phases: active.phases,
      totalMs: round(performance.now() - active.startedAt),
      subprocesses: active.subprocesses,
      ipcBytes: active.ipcBytes,
    };
    this.measurements.push(measurement);
    return measurement;
  }

  getMeasurements(): readonly LifecycleMeasurement[] { return this.measurements; }
  reset(): void { this.measurements.length = 0; this.active = undefined; }
}

export function summarizeLifecycle(measurements: readonly LifecycleMeasurement[]): Record<string, { median: number; p95: number }> {
  const groups = new Map<string, number[]>();
  for (const item of measurements) {
    const key = `${item.mode}:${item.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), item.totalMs]);
  }
  return Object.fromEntries([...groups].map(([key, values]) => [key, {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  }]));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
function round(value: number): number { return Math.round(value * 10) / 10; }