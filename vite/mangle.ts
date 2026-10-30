import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Plugin } from "vite";
import { minify, type MinifyOptions } from "terser";

const terserOptions = (sourceMap: boolean): MinifyOptions =>
  ({ module: true, ecma: 2020, compress: { passes: 3 }, mangle: true, format: { wrap_func_args: false }, sourceMap });

/** terser's compress and rename passes over esbuild's output, legal comments kept. */
export async function mangleChunk(code: string, sourceMap: boolean): Promise<{ code: string; map: string | null }> {
  const result = await minify(code, terserOptions(sourceMap));
  return { code: result.code ?? code, map: typeof result.map === "string" ? result.map : null };
}

// The same call as mangleChunk, in a worker thread; the options cross as data.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { minify } = require(workerData.terser);
parentPort.on("message", async ({ code, options }) => {
  try {
    const result = await minify(code, options);
    parentPort.postMessage({ code: result.code ?? code, map: typeof result.map === "string" ? result.map : null });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});`;

interface Job { code: string; sourceMap: boolean; resolve(result: { code: string; map: string | null }): void; reject(error: Error): void }

/**
 * terser blocks the thread it runs on, so chunks Rollup renders at once would still
 * take turns. Workers take them side by side: the build waits for the largest chunk
 * instead of the sum of all. A worker holds the process open only while it works.
 */
export function terserPool(size = Math.max(1, availableParallelism() - 1)) {
  const terser = createRequire(import.meta.url).resolve("terser");
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const queue: Job[] = [];
  const spawn = () => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { terser } });
    workers.push(worker);
    return worker;
  };
  const drain = () => {
    while (queue.length) {
      const worker = idle.pop() ?? (workers.length < size ? spawn() : undefined);
      if (!worker) return;
      const job = queue.shift()!;
      const settle = (reply: { code: string; map: string | null } | { error: string }) => {
        worker.off("error", fail);
        worker.unref();
        if ("error" in reply) job.reject(new Error(reply.error));
        else job.resolve(reply);
        idle.push(worker);
        drain();
      };
      const fail = (error: Error) => {
        worker.off("message", settle);
        workers.splice(workers.indexOf(worker), 1);
        job.reject(error);
        drain();
      };
      worker.once("message", settle);
      worker.once("error", fail);
      worker.ref();
      worker.postMessage({ code: job.code, options: terserOptions(job.sourceMap) });
    }
  };
  return {
    mangle: (code: string, sourceMap: boolean) => new Promise<{ code: string; map: string | null }>((resolve, reject) => {
      queue.push({ code, sourceMap, resolve, reject });
      drain();
    }),
    async close() {
      idle.length = 0;
      await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    },
  };
}

/**
 * Compresses and renames once more after esbuild has minified a chunk. terser
 * finds code esbuild keeps. Three compression passes fold expressions exposed
 * by earlier passes, keeping the desktop and browser builds within their gzip budgets.
 * It picks short names by character frequency, which gzip rewards.
 */
export function mangleForGzip(): Plugin {
  let enabled = false;
  let pool: ReturnType<typeof terserPool> | undefined;
  const close = async () => {
    await pool?.close();
    pool = undefined;
  };
  return {
    name: "tau-mangle-for-gzip",
    apply: "build",
    configResolved(config) {
      enabled = config.build.minify === "esbuild";
    },
    renderChunk: {
      // After Vite's minifier, whose renderChunk is unordered.
      order: "post",
      async handler(code, _chunk, options) {
        if (!enabled) return null;
        pool ??= terserPool();
        return pool.mangle(code, Boolean(options.sourcemap));
      },
    },
    generateBundle: close,
    renderError: close,
  };
}
