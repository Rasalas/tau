import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The host's sources as Node runs them: one JavaScript file per TypeScript file in
// dist-electron/, as `tsc -p tooling/tsconfig.electron.json` emits them, in a second
// instead of half a minute. `npm run typecheck` checks the same project.
const root = fileURLToPath(new URL("..", import.meta.url));
const TSCONFIG = "tooling/tsconfig.electron.json";
const INCLUDE = [["src/main", ".ts"], ["src/shared", ".ts"], ["src/preload", ".cts"]];

async function sources() {
  const found = [];
  for (const [directory, extension] of INCLUDE) {
    for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts")) {
        found.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
      }
    }
  }
  return found;
}

/**
 * The included files and every source they import, as tsc's program has them
 * (main reaches a few modules of src/workbench). Split chunks keep this one pass.
 */
async function reachable(entryPoints) {
  const { metafile } = await build({
    absWorkingDir: root, entryPoints, bundle: true, splitting: true, format: "esm", platform: "node",
    packages: "external", external: ["electron"], tsconfig: TSCONFIG, outdir: "dist-electron", write: false, metafile: true, logLevel: "error",
  });
  return Object.keys(metafile.inputs).filter((path) => path.startsWith("src/") && /\.c?ts$/u.test(path) && !path.endsWith(".d.ts"));
}

const included = await sources();
const files = [...new Set([...included, ...await reachable(included)])];
const common = { absWorkingDir: root, bundle: false, platform: "node", target: "es2022", tsconfig: TSCONFIG, outbase: "src", outdir: "dist-electron", logLevel: "error" };
await Promise.all([
  build({ ...common, entryPoints: files.filter((path) => path.endsWith(".ts")), format: "esm" }),
  build({ ...common, entryPoints: files.filter((path) => path.endsWith(".cts")), format: "cjs", outExtension: { ".js": ".cjs" } }),
]);
