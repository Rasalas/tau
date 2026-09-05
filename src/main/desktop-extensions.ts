import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts.js";
import { MANIFEST_FILE, manifestIncompatibility, parseExtensionManifest, type ExtensionManifest } from "./extension-packages.js";
import { isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import type { ExtensionHostVersions } from "../shared/extension-compat.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

export interface DesktopEntryOptions {
  /** Versions a package's `engines` must accept; an incompatible package has no desktop half either. */
  versions?: ExtensionHostVersions;
}

/** Where desktop extensions live: one folder for the user, one per project. */
export function desktopExtensionDirectories(cwd: string, home = homedir()): Array<{ scope: "global" | "project"; directory: string }> {
  return [
    { scope: "global", directory: join(home, ".tau", "extensions") },
    { scope: "project", directory: join(cwd, ".tau", "extensions") },
  ];
}

export interface DesktopEntryDetailed {
  path: string;
  manifest?: ExtensionManifest;
}

/** Every file or `<name>/index.*` in the folder that can be an extension entry, with manifest if it's a package. */
export async function listDesktopExtensionEntriesDetailed(directory: string, options: DesktopEntryOptions = {}): Promise<DesktopEntryDetailed[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: DesktopEntryDetailed[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/u.test(name)) entries.push({ path });
      continue;
    }
    if (!info.isDirectory()) continue;
    // A package folder names its desktop entry in its manifest; without one it has no desktop half.
    const manifest = await readFile(join(path, MANIFEST_FILE), "utf8").catch(() => undefined);
    if (manifest !== undefined) {
      try {
        const parsed = parseExtensionManifest(path, manifest);
        if (parsed.desktopEntry && !manifestIncompatibility(parsed.manifest, options.versions)) {
          entries.push({ path: parsed.desktopEntry, manifest: parsed.manifest });
        }
      } catch {
        // The host reports manifest errors when it loads packages; the desktop side stays quiet.
      }
      continue;
    }
    for (const index of ["index.tsx", "index.ts", "index.jsx", "index.js", "index.mjs"]) {
      const candidate = join(path, index);
      if (await stat(candidate).then((s) => s.isFile()).catch(() => false)) {
        entries.push({ path: candidate });
        break;
      }
    }
  }
  return entries;
}

/** Every file or `<name>/index.*` in the folder that can be an extension entry. */
export async function listDesktopExtensionEntries(directory: string, options: DesktopEntryOptions = {}): Promise<string[]> {
  const detailed = await listDesktopExtensionEntriesDetailed(directory, options);
  return detailed.map((entry) => entry.path);
}

/** A loose extension file has no manifest id; its path names it instead. */
function slugForEntry(path: string): string {
  const name = basename(path).replace(/\.[cm]?[jt]sx?$/u, "");
  return `local.${name.toLowerCase().replace(/[^a-z0-9-]+/gu, "-") || "extension"}`;
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

/**
 * Shared modules the renderer only fetches on demand: it reports them with an
 * empty export list, and the host reads the names from its own copy so the
 * shim still binds every named import.
 */
const HOST_RESOLVED_SHARED = new Set(["lucide-react"]);
const hostExportNames = new Map<string, Promise<string[]>>();

function sharedExportNamesFor(specifier: string, reported: readonly string[] | undefined): Promise<string[]> {
  if (reported && reported.length > 0) return Promise.resolve([...reported]);
  if (!HOST_RESOLVED_SHARED.has(specifier)) return Promise.resolve([]);
  let names = hostExportNames.get(specifier);
  if (!names) {
    names = import(specifier).then((module: object) => Object.keys(module));
    hostExportNames.set(specifier, names);
  }
  return names;
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
    define: {
      "window.tau": "undefined",
    },
    plugins: [{
      name: "tau-shared-modules",
      setup(api) {
        api.onResolve({ filter: /.*/ }, (args) => {
          if (!shared.has(args.path)) return undefined;
          return { path: args.path, namespace: "tau-shared" };
        });
        api.onLoad({ filter: /.*/, namespace: "tau-shared" }, async (args) => ({
          contents: sharedModuleSource(args.path, await sharedExportNamesFor(args.path, options.sharedExports[args.path])),
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
  options: BundleOptions & DesktopEntryOptions & { home?: string; grantsFilePath?: string; trusted?: (cwd: string) => boolean },
): Promise<DesktopExtensionLoadResult> {
  const bundles: DesktopExtensionBundle[] = [];
  const errors: DesktopExtensionLoadResult["errors"] = [];
  const skipped: DesktopExtensionLoadResult["skipped"] = [];
  const trusted = options.trusted ?? ((path: string) => new ProjectTrustStore(agentDir).get(path) === true);
  const grantsFile = await readExtensionGrants(options.grantsFilePath);

  for (const { scope, directory } of desktopExtensionDirectories(cwd, options.home)) {
    const entries = await listDesktopExtensionEntriesDetailed(directory, { versions: options.versions });
    if (entries.length === 0) continue;
    if (scope === "project" && !trusted(cwd)) {
      skipped.push({ directory, reason: "The project is not trusted in Pi, so its desktop extensions stay off." });
      continue;
    }
    for (const entry of entries) {
      try {
        const code = await bundleDesktopExtension(entry.path, options);
        const permissions = entry.manifest?.permissions ?? [];
        const granted = entry.manifest ? isPackageGranted(entry.manifest, grantsFile.grants) : true;
        bundles.push({
          id: entry.manifest?.id ?? slugForEntry(entry.path),
          path: entry.path,
          scope,
          projectPath: scope === "project" ? cwd : undefined,
          code,
          permissions,
          granted,
          ...(entry.manifest?.source ? { source: entry.manifest.source } : {}),
        });
      } catch (error) {
        errors.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) });
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
