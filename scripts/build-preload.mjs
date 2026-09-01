import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = {
  absWorkingDir: root,
  entryPoints: ["src/preload/index.cts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outfile: "dist-electron/preload/bundle.cjs",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
  console.log("Watching sandboxed preload bundle");
  await new Promise(() => undefined);
} else {
  await build(options);
}
