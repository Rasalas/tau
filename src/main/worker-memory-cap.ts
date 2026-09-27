import { totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";

/**
 * Bounds the memory worker packages can make the host process hold.
 *
 * Per worker: its buffer memory (`external_memory`), which `resourceLimits`
 * leave out. Per process: what no V8 statistic counts for a worker — WebAssembly
 * memory under Electron's Node, SharedArrayBuffer, a native library's malloc —
 * still shows in the resident size. Each tick's change is attributed to the
 * threads that ran code in it, by their share of the tick; past the process
 * limit, the worker that grew it most is stopped.
 *
 * One timer serves every worker. `getHeapStatistics` interrupts the worker's
 * isolate, so it answers inside a synchronous loop too; it is asked only when
 * the worker ran since the last tick, or once a second.
 */

const TICK_MS = 50;
const FLOOR_MS = 1_000;
/** Below this the activity is the previous sample's own interrupt. */
const ACTIVE_MS = 1;
const MB = 1024 * 1024;
/** Share of the machine's (or container's) memory the host process may reach. */
const LIMIT_SHARE = 0.5;
/** Growth below this is noise, not a reason to stop a package. */
const DEFAULT_MIN_GROWTH = 128 * MB;
/** After a stop, the time the process gets to give the memory back. */
const SETTLE_MS = 1_000;
const RELEASE_MS = 2_000;

export type MemoryOverrun =
  | { kind: "buffers"; bytes: number }
  | { kind: "process"; grownBytes: number; rssBytes: number; limitBytes: number };

interface Watch {
  worker: Worker;
  capBytes: number;
  exceeded(overrun: MemoryOverrun): void;
  elu: ReturnType<Worker["performance"]["eventLoopUtilization"]>;
  sampledAt: number;
  sampling: boolean;
  done: boolean;
  /** Resident memory attributed to this worker since it started. */
  grown: number;
}

const watches = new Set<Watch>();
let timer: NodeJS.Timeout | undefined;
let lastRss = 0;
let lastTickAt = 0;
let mainElu = performance.eventLoopUtilization();
let settledAt = 0;
/** What stopped workers grew; the drop when they give it back is theirs, not the running threads'. */
let releasing = 0;
let releasingUntil = 0;
let limit: { limitBytes: number; minGrowthBytes: number } | undefined;

/** A container's limit when it is below the machine's memory. */
function systemMemory(): number {
  const total = totalmem();
  const constrained = process.constrainedMemory();
  return constrained > 0 && constrained < total ? constrained : total;
}

function processLimit(): { limitBytes: number; minGrowthBytes: number } {
  limit ??= { limitBytes: Math.floor(systemMemory() * LIMIT_SHARE), minGrowthBytes: DEFAULT_MIN_GROWTH };
  return limit;
}

/** Overrides the process limit (tests); without options, back to the one derived from system memory. */
export function setProcessMemoryLimit(options?: { limitBytes?: number; minGrowthBytes?: number }): void {
  limit = undefined;
  settledAt = 0;
  if (options) limit = { ...processLimit(), ...options };
}

function sample(watch: Watch): void {
  watch.sampling = true;
  watch.sampledAt = Date.now();
  watch.worker.getHeapStatistics().then((stats) => {
    watch.sampling = false;
    if (watch.done || !(stats.external_memory > watch.capBytes)) return;
    stop(watch);
    watch.exceeded({ kind: "buffers", bytes: stats.external_memory });
  }, () => {
    // Not running yet, or gone: the owner's exit path stops the watch.
    watch.sampling = false;
  });
}

function tick(): void {
  const now = Date.now();
  const span = now - lastTickAt;
  lastTickAt = now;
  const rss = process.memoryUsage.rss();
  const main = performance.eventLoopUtilization();
  // The host's own threads share the tick, so a package idle while the host grows gets none of it.
  let total = performance.eventLoopUtilization(main, mainElu).active;
  mainElu = main;
  const active = new Map<Watch, number>();
  for (const watch of watches) {
    const elu = watch.worker.performance.eventLoopUtilization();
    // Before its event loop starts a worker reports no time at all, while it builds its isolate and loads the package.
    const ran = elu.idle === 0 && elu.active === 0 ? span : watch.worker.performance.eventLoopUtilization(elu, watch.elu).active;
    watch.elu = elu;
    active.set(watch, ran);
    total += ran;
    if (!watch.sampling && (ran >= ACTIVE_MS || now - watch.sampledAt >= FLOOR_MS)) sample(watch);
  }
  let delta = rss - lastRss;
  if (now > releasingUntil) releasing = 0;
  if (delta < 0 && releasing > 0) {
    const freed = Math.min(-delta, releasing);
    releasing -= freed;
    delta += freed;
  }
  lastRss = rss;
  if (delta !== 0 && total > 0) {
    // Shrinking counts too, unfloored: noise in the resident size then cancels out instead of piling up.
    for (const [watch, ran] of active) watch.grown += delta * ran / total;
  }
  const { limitBytes, minGrowthBytes } = processLimit();
  if (rss < limitBytes || now - settledAt < SETTLE_MS) return;
  let culprit: Watch | undefined;
  for (const watch of watches) {
    if (!watch.done && watch.grown >= minGrowthBytes && watch.grown > (culprit?.grown ?? 0)) culprit = watch;
  }
  if (!culprit) return;
  settledAt = now;
  stop(culprit);
  culprit.exceeded({ kind: "process", grownBytes: culprit.grown, rssBytes: rss, limitBytes });
}

function stop(watch: Watch): void {
  if (watch.done) return;
  watch.done = true;
  watches.delete(watch);
  if (watch.grown > 0) {
    releasing += watch.grown;
    releasingUntil = Date.now() + RELEASE_MS;
  }
  if (watches.size === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Calls `exceeded` once, when the worker's buffer memory passes `capBytes` or
 * the process passes its limit with this worker as the one that grew it most.
 * The caller terminates the worker, and calls the returned stop when it ends.
 */
export function watchWorkerMemory(worker: Worker, capBytes: number, exceeded: (overrun: MemoryOverrun) => void): () => void {
  const watch: Watch = {
    worker,
    capBytes,
    exceeded,
    elu: worker.performance.eventLoopUtilization(),
    sampledAt: 0,
    sampling: false,
    done: false,
    grown: 0,
  };
  watches.add(watch);
  if (!timer) {
    lastRss = process.memoryUsage.rss();
    lastTickAt = Date.now();
    mainElu = performance.eventLoopUtilization();
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }
  return () => { stop(watch); };
}
