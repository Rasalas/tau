import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import type { HostEvent, ThreadHostEvent } from "../shared/contracts.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import type { HostLogger } from "./host-log.js";
import { ThreadRuntime } from "./thread-runtime.js";

export interface HostReportPort {
  emit(event: HostEvent): void;
  threadFor(sessionId: string): ThreadRuntime | undefined;
  logger?: HostLogger;
}

/**
 * Host observability with separate channels for events, failures and timing.
 * Keeping those channels explicit prevents a timing record from becoming a
 * user error, or a renderer error from replacing the full logger detail.
 */
export class HostReport {
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];

  constructor(
    private readonly port: HostReportPort,
    private readonly metrics?: HostLifecycleInstrumentation,
  ) {}

  log(label: string, detail?: string): void {
    this.port.emit({ type: "event-log", label, detail, timestamp: Date.now() });
  }

  logForThread(thread: ThreadRuntime, label: string, detail?: string): void {
    const event: ThreadHostEvent = { type: "event-log", label, detail, timestamp: Date.now(), sessionId: thread.sessionId };
    if (thread.deferHostEvent(event)) return;
    this.port.emit(event);
  }

  errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void {
    if (thread?.deferError(error)) return;
    const message = this.errorMessage(error);
    this.port.logger?.error("host.error", error);
    if (sessionId) this.port.emit({ type: "error", message, sessionId });
    else this.port.emit({ type: "error", message });
    const owner = thread instanceof ThreadRuntime
      ? thread
      : sessionId ? this.port.threadFor(sessionId) : undefined;
    if (owner instanceof ThreadRuntime) this.logForThread(owner, "host.error", message);
    else if (sessionId) this.port.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now(), sessionId });
    else this.port.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now() });
  }

  /** Records a critical-path phase and publishes its ready event. */
  runtimePhase(
    phase: string,
    startedAt: number,
    reason: string,
    cwd: string,
    note?: string,
    thread?: ThreadRuntime,
  ): void {
    this.metrics?.phase(phase, startedAt);
    this.phaseEvent(phase, startedAt, reason, cwd, note, thread);
  }

  /** Publishes a phase that is not part of the critical-path measurement. */
  phaseEvent(
    phase: string,
    startedAt: number,
    reason: string,
    cwd: string,
    note?: string,
    thread?: ThreadRuntime,
  ): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    const detail = `${elapsed}ms · ${reason} · ${basename(cwd) || cwd}`;
    const eventDetail = note ? `${detail} · ${note}` : detail;
    if (thread) this.logForThread(thread, `runtime.${phase}.ready`, eventDetail);
    else this.log(`runtime.${phase}.ready`, eventDetail);
  }

  replacement(reason: string, startedAt: number): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    this.log("runtime.replace.ready", `${elapsed}ms · ${reason}`);
  }

  recordBackground(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
  }

  get backgroundMeasurements(): readonly { name: string; durationMs: number }[] {
    return this.backgroundLifecycle;
  }
}
