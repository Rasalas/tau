import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/** Where desktop extensions live: one folder for the user, one per project. */
export function desktopExtensionDirectories(cwd: string, home = homedir()): Array<{ scope: "global" | "project"; directory: string }> {
  return [
    { scope: "global", directory: join(home, ".tau", "extensions") },
    { scope: "project", directory: join(cwd, ".tau", "extensions") },
  ];
}

/** Every file or `<name>/index.*` in the folder that can be an extension entry. */
export async function listDesktopExtensionEntries(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/u.test(name)) entries.push(path);
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const index of ["index.tsx", "index.ts", "index.jsx", "index.js", "index.mjs"]) {
      const candidate = join(path, index);
      if (await stat(candidate).then((s) => s.isFile()).catch(() => false)) {
        entries.push(candidate);
        break;
      }
    }
  }
  return entries;
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(name) && name !== "default";
}

/**
 * Bare imports of the workbench's own libraries resolve to the copies the
 * renderer already runs, published on `globalThis.__tauShared`. Bundling a
 * second React would break hooks; bundling a second icon set would waste
 * megabytes per extension.
 */
function sharedModuleSource(specifier: string, exportNames: readonly string[]): string {
  const lines = [
    `const m = globalThis.__tauShared?.[${JSON.stringify(specifier)}];`,
    `if (!m) throw new Error(${JSON.stringify(`Shared module ${specifier} is not available in this workbench`)});`,
    `export default (m && typeof m === "object" && "default" in m ? m.default : m);`,
  ];
  for (const name of exportNames) {
    if (isIdentifier(name)) lines.push(`export const ${name} = m[${JSON.stringify(name)}];`);
  }
  return lines.join("\n");
}

export interface BundleOptions {
  /** Export names per shared specifier, as seen by the renderer that will run the code. */
  sharedExports: Record<string, string[]>;
}

/** Compiles one extension entry to a self-contained ES module. */
export async function bundleDesktopExtension(entry: string, options: BundleOptions): Promise<string> {
  const shared = new Set(Object.keys(options.sharedExports));
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    sourcemap: "inline",
    logLevel: "silent",
    plugins: [{
      name: "tau-shared-modules",
      setup(api) {
        api.onResolve({ filter: /.*/ }, (args) => {
          if (!shared.has(args.path)) return undefined;
          return { path: args.path, namespace: "tau-shared" };
        });
        api.onLoad({ filter: /.*/, namespace: "tau-shared" }, (args) => ({
          contents: sharedModuleSource(args.path, options.sharedExports[args.path] ?? []),
          loader: "js",
        }));
      },
    }],
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

/**
 * Finds and compiles the desktop extensions for a workspace. Project-level
 * extensions are code from the repository, so they load only where Pi already
 * trusts the project; the user's own folder always loads.
 */
export async function loadDesktopExtensions(
  cwd: string,
  agentDir: string,
  options: BundleOptions & { home?: string; trusted?: (cwd: string) => boolean },
): Promise<DesktopExtensionLoadResult> {
  const bundles: DesktopExtensionBundle[] = [];
  const errors: DesktopExtensionLoadResult["errors"] = [];
  const skipped: DesktopExtensionLoadResult["skipped"] = [];
  const trusted = options.trusted ?? ((path: string) => new ProjectTrustStore(agentDir).get(path) === true);
  for (const { scope, directory } of desktopExtensionDirectories(cwd, options.home)) {
    const entries = await listDesktopExtensionEntries(directory);
    if (entries.length === 0) continue;
    if (scope === "project" && !trusted(cwd)) {
      skipped.push({ directory, reason: "The project is not trusted in Pi, so its desktop extensions stay off." });
      continue;
    }
    for (const entry of entries) {
      try {
        const code = await bundleDesktopExtension(entry, options);
        bundles.push({ path: entry, scope, projectPath: scope === "project" ? cwd : undefined, code });
      } catch (error) {
        errors.push({ path: entry, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { bundles, errors, skipped };
}

/** Human-readable name for a bundle, used before its module has told us its own. */
export function desktopExtensionLabel(path: string): string {
  const name = basename(path);
  return /^index\./u.test(name) ? basename(dirname(path)) : name.replace(/\.[^.]+$/u, "");
}

/** Reads a source file back for diagnostics; never throws. */
export async function readExtensionSource(path: string): Promise<string | undefined> {
  try {
    return await readFile(await realpath(path), "utf8");
  } catch {
    return undefined;
  }
}
