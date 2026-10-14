import { build, context } from "esbuild";
import { persistedTranscriptWorkerBuildOptions } from "./persisted-transcript-worker-build.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The entry an isolated host extension runs in. It ships as one CommonJS file
// so the worker never depends on the ESM loader of the process that starts it.
const root = fileURLToPath(new URL("..", import.meta.url));
const options = {
  absWorkingDir: root,
  entryPoints: ["src/main/host-extension-worker.ts", "src/main/host-extension-process-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  outdir: "dist-electron/main",
  outExtension: { ".js": ".cjs" },
};

if (process.argv.includes("--watch")) {
  const watchers = await Promise.all([context(options), context(persistedTranscriptWorkerBuildOptions(root, join(root, "dist-electron/main/persisted-transcript-worker.mjs")))]);
  await Promise.all(watchers.map((watcher) => watcher.watch()));
  console.log("Watching host extension and persisted transcript workers");
  await new Promise(() => undefined);
} else {
  await Promise.all([build(options), build(persistedTranscriptWorkerBuildOptions(root, join(root, "dist-electron/main/persisted-transcript-worker.mjs")))]);
}
