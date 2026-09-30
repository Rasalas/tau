#!/usr/bin/env node
// Bundles src/index.ts with the kit's APNs client into lib/index.js; Firebase's SDKs stay packages.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
});
