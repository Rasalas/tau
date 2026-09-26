import type { Worker } from "node:worker_threads";

/**
 * Caps a worker's buffer memory. `resourceLimits` bound the JS heap only;
 * ArrayBuffer, typed array and Buffer memory lies outside it and could grow
 * until the OS ended the whole host process.
 *
 * One timer serves every watched worker. A tick reads the worker's event-loop
 * utilization (a local read, no round trip) and asks for heap statistics only
 * when the worker ran code since the last tick, or once a second regardless.
 * `getHeapStatistics` interrupts the worker's isolate, so it answers inside a
 * synchronous allocation loop too.
 */

const TICK_MS = 50;
const FLOOR_MS = 1_000;
/** Below this the activity is the previous sample's own interrupt. */
const ACTIVE_MS = 1;

interface Watch {
  worker: Worker;
  capBytes: number;
  exceeded(bytes: number): void;
  elu: ReturnType<Worker["performance"]["eventLoopUtilization"]>;
  sampledAt: number;
  sampling: boolean;
  done: boolean;
}

const watches = new Set<Watch>();
let timer: NodeJS.Timeout | undefined;

function sample(watch: Watch): void {
  watch.sampling = true;
  watch.sampledAt = Date.now();
  watch.worker.getHeapStatistics().then((stats) => {
    watch.sampling = false;
    if (watch.done || !(stats.external_memory > watch.capBytes)) return;
    stop(watch);
    watch.exceeded(stats.external_memory);
  }, () => {
    // Not running yet, or gone: the owner's exit path stops the watch.
    watch.sampling = false;
  });
}

function tick(): void {
  const now = Date.now();
  for (const watch of watches) {
    if (watch.sampling) continue;
    const elu = watch.worker.performance.eventLoopUtilization();
    const active = watch.worker.performance.eventLoopUtilization(elu, watch.elu).active;
    watch.elu = elu;
    if (active >= ACTIVE_MS || now - watch.sampledAt >= FLOOR_MS) sample(watch);
  }
}

function stop(watch: Watch): void {
  watch.done = true;
  watches.delete(watch);
  if (watches.size === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Calls `exceeded` once when the worker's buffer memory passes `capBytes`.
 * The caller terminates the worker, and calls the returned stop when it ends.
 */
export function watchWorkerMemory(worker: Worker, capBytes: number, exceeded: (bytes: number) => void): () => void {
  const watch: Watch = {
    worker,
    capBytes,
    exceeded,
    elu: worker.performance.eventLoopUtilization(),
    sampledAt: 0,
    sampling: false,
    done: false,
  };
  watches.add(watch);
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }
  return () => { stop(watch); };
}
