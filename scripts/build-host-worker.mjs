import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";

// The entry an isolated host extension runs in. It ships as one CommonJS file
// so the worker never depends on the ESM loader of the process that starts it.
const root = fileURLToPath(new URL("..", import.meta.url));
const options = {
  absWorkingDir: root,
  entryPoints: ["src/main/host-extension-worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  outfile: "dist-electron/main/host-extension-worker.cjs",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
  console.log("Watching the isolated host extension worker");
  await new Promise(() => undefined);
} else {
  await build(options);
}
