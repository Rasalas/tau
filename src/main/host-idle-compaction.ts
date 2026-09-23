import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import type { HostMethodTable } from "./host-methods.js";

export interface IdleHeapCompactionOptions {
  /** Quiet time after the last call or push before a compaction may run. */
  quietMs?: number;
  /** How often the quiet is checked. */
  checkMs?: number;
  /** Heap growth since the last compaction below which nothing runs. */
  minGrowthBytes?: number;
  heapBytes?: () => number;
  collect?: () => void;
  now?: () => number;
  onCompacted?(result: { beforeBytes: number; afterBytes: number; ms: number }): void;
}

type GcFunction = (options?: { type?: "major" | "minor"; execution?: "sync" | "async"; flavor?: "regular" | "last-resort" }) => void;

let gcFunction: GcFunction | undefined;

/**
 * One memory-reducing collection with V8's own `gc`, exposed at run time when
 * the process was not started with `--expose-gc`.
 */
export function compactHeap(): void {
  if (!gcFunction) {
    const exposed = (globalThis as { gc?: GcFunction }).gc;
    if (typeof exposed === "function") gcFunction = exposed;
    else {
      setFlagsFromString("--expose-gc");
      gcFunction = runInNewContext("gc") as GcFunction;
    }
  }
  // "last-resort" also shrinks the young generation and releases freed pages.
  gcFunction({ type: "major", execution: "sync", flavor: "last-resort" });
}

/**
 * Node runs no GC while it is idle, so a host that went quiet keeps the
 * garbage and the grown young generation of its last burst of work. Once the
 * host has been quiet for a while, and only if the heap grew since the last
 * time, one memory-reducing collection hands that memory back.
 */
export class IdleHeapCompactor {
  private readonly quietMs: number;
  private readonly minGrowthBytes: number;
  private readonly heapBytes: () => number;
  private readonly collect: () => void;
  private readonly now: () => number;
  private lastActivityAt: number;
  private baselineBytes: number;
  private inFlight = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: IdleHeapCompactionOptions = {}) {
    // Short enough that a client polling every two seconds leaves gaps to use.
    this.quietMs = options.quietMs ?? 1_000;
    this.minGrowthBytes = options.minGrowthBytes ?? 32 * 1024 * 1024;
    this.heapBytes = options.heapBytes ?? (() => getHeapStatistics().total_heap_size);
    this.collect = options.collect ?? compactHeap;
    this.now = options.now ?? Date.now;
    this.lastActivityAt = this.now();
    this.baselineBytes = this.heapBytes();
  }

  noteActivity(): void {
    this.lastActivityAt = this.now();
  }

  /** Brackets a call, so a long one is never taken for quiet. */
  async during<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.noteActivity();
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.noteActivity();
    }
  }

  /** Runs a compaction if the host is quiet and grew; true when it ran. */
  tick(): boolean {
    if (this.inFlight > 0 || this.now() - this.lastActivityAt < this.quietMs) return false;
    const beforeBytes = this.heapBytes();
    if (beforeBytes - this.baselineBytes < this.minGrowthBytes) return false;
    const startedAt = performance.now();
    this.collect();
    this.baselineBytes = this.heapBytes();
    this.options.onCompacted?.({ beforeBytes, afterBytes: this.baselineBytes, ms: performance.now() - startedAt });
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.checkMs ?? 500);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The same table, with every call bracketed as activity. */
  observe(methods: HostMethodTable): HostMethodTable {
    return Object.fromEntries(Object.entries(methods).map(([name, method]) => [
      name,
      (params, context) => this.during(() => method(params, context)),
    ])) as HostMethodTable;
  }
}
