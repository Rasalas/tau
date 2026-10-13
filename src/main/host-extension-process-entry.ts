import { Worker } from "node:worker_threads";
import type { WorkerHostExtensionOptions } from "./host-extension-isolation.js";
import type { HostToWorkerMessage, WorkerBootstrap } from "./host-extension-worker-protocol.js";
import { serializeError } from "./host-extension-worker-protocol.js";
import { watchWorkerMemory } from "./worker-memory-cap.js";

/** Trusted supervisor; only the package worker loses the ability to create workers. */
process.once("message", (input: { entry: string; boot: WorkerBootstrap; resourceLimits?: WorkerHostExtensionOptions["resourceLimits"] }) => {
  const { maxExternalMb = 512, ...heapLimits } = input.resourceLimits ?? {};
  const worker = new Worker(input.entry, {
    workerData: input.boot,
    execArgv: process.execArgv.filter((flag) => flag !== "--allow-worker" && !flag.startsWith("--max-") && !flag.startsWith("--stack-size=")),
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, ...heapLimits },
  });
  const send = process.send!.bind(process);
  const unwatch = watchWorkerMemory(worker, maxExternalMb * 1024 * 1024, (overrun) => {
    const reason = overrun.kind === "buffers"
      ? `${input.boot.name} exceeded its memory cap: ${Math.round(overrun.bytes / 1024 / 1024)} MB of buffers, cap ${maxExternalMb} MB`
      : `${input.boot.name} exceeded its process memory limit`;
    send({ t: "fatal", error: serializeError(new Error(reason)) });
    void worker.terminate();
  });
  process.on("message", (message: HostToWorkerMessage) => worker.postMessage(message));
  process.on("disconnect", () => { unwatch(); void worker.terminate(); });
  worker.on("message", (message) => send(message));
  worker.on("error", (error) => send({ t: "fatal", error: serializeError(error) }));
  worker.on("exit", (code) => { unwatch(); process.exit(code); });
});
