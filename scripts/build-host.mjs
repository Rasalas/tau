import { build } from "esbuild";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// The host's sources as Node runs them: one JavaScript file per TypeScript file in
// dist-electron/, as `tsc -p tooling/tsconfig.electron.json` emits them, in a second
// instead of half a minute. `npm run typecheck` checks the same project.
const root = fileURLToPath(new URL("..", import.meta.url));
const TSCONFIG = "tooling/tsconfig.electron-build.json";

export function hostEntryPoints() {
  // Read only the file list, without constructing or checking a TypeScript program.
  const config = ts.getParsedCommandLineOfConfigFile(join(root, TSCONFIG), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (error) => { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n")); },
  });
  if (config.errors.length) throw new Error(config.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  return config.fileNames.filter(path => !path.endsWith(".d.ts")).map(path => relative(root, path).split(sep).join("/"));
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

async function main() {
  const included = hostEntryPoints();
  const files = [...new Set([...included, ...await reachable(included)])];
  const common = { absWorkingDir: root, bundle: false, platform: "node", target: "es2022", tsconfig: TSCONFIG, outbase: "src", outdir: "dist-electron", logLevel: "error" };
  await Promise.all([
    build({ ...common, entryPoints: files.filter((path) => path.endsWith(".ts")), format: "esm" }),
    build({ ...common, entryPoints: files.filter((path) => path.endsWith(".cts")), format: "cjs", outExtension: { ".js": ".cjs" } }),
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
