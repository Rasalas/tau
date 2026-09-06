// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import "./packaged-app.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts.js";
import { MANIFEST_FILE, manifestIncompatibility, parseExtensionManifest, type ExtensionManifest } from "./extension-packages.js";
import { isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { listInstalledSources } from "./extension-sources.js";
import type { ExtensionHostVersions } from "../shared/extension-compat.js";
import { DEFERRED_SHARED_MODULES } from "../shared/shared-modules.js";

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
  /** Absolute path of the stylesheet the manifest names, if it names one. */
  styles?: string;
}

/** A desktop entry that came from a source in `packages.json` rather than from a folder scan. */
interface SourceEntry {
  scope: "global" | "project";
  entry: DesktopEntryDetailed;
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
          entries.push({ path: parsed.desktopEntry, manifest: parsed.manifest, ...(parsed.stylesEntry ? { styles: parsed.stylesEntry } : {}) });
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
    // A binding esbuild cannot prove pure is a binding it must keep, and a
    // property read is never provably pure. Routing every name through an
    // annotated picker lets it drop the ones the package never imports —
    // `lucide-react` reports some 3000, and a status icon needs one.
    `/* @__NO_SIDE_EFFECTS__ */ const pick = (name) => m[name];`,
  ];
  for (const name of exportNames) {
    if (isIdentifier(name)) lines.push(`export const ${name} = /* @__PURE__ */ pick(${JSON.stringify(name)});`);
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
const HOST_RESOLVED_SHARED = new Set<string>(DEFERRED_SHARED_MODULES);
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
  return withoutGeneratedSources(result.outputFiles.map((file) => file.text).join("\n"));
}

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/u;

/**
 * Drops the shim sources from the inline map. They are generated bindings, not
 * anybody's code, and `lucide-react` alone carries some 3000 lines of them —
 * which the map would ship even though tree shaking already dropped all but
 * the names the package imports. The author's own sources stay.
 */
function withoutGeneratedSources(code: string): string {
  const match = INLINE_MAP.exec(code);
  if (!match) return code;
  try {
    const map = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as { sources?: string[]; sourcesContent?: (string | null)[] };
    if (!map.sources || !map.sourcesContent) return code;
    map.sourcesContent = map.sourcesContent.map((content, index) => map.sources![index]?.startsWith("tau-shared:") ? null : content);
    return code.replace(match[0], `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map), "utf8").toString("base64")}`);
  } catch {
    // A map we cannot read is a map we leave alone; the bundle is what matters.
    return code;
  }
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

  const roots = desktopExtensionDirectories(cwd, options.home);
  const fromSources = await listInstalledSources(cwd, options.home ?? homedir());
  const resolved = await Promise.all(fromSources.map(async (installed): Promise<SourceEntry[]> => {
    if (installed.error) return [];
    const manifest = await readFile(join(installed.directory, MANIFEST_FILE), "utf8").catch(() => undefined);
    if (manifest === undefined) return [];
    try {
      const parsed = parseExtensionManifest(installed.directory, manifest);
      if (!parsed.desktopEntry || manifestIncompatibility(parsed.manifest, options.versions)) return [];
      return [{ scope: installed.scope, entry: { path: parsed.desktopEntry, manifest: parsed.manifest, ...(parsed.stylesEntry ? { styles: parsed.stylesEntry } : {}) } }];
    } catch {
      // The host reports manifest errors when it loads packages; the desktop side stays quiet.
      return [];
    }
  }));
  const sourceEntries = resolved.flat();

  for (const { scope, directory } of roots) {
    const own = await listDesktopExtensionEntriesDetailed(directory, { versions: options.versions });
    const installed = sourceEntries.filter((found) => found.scope === scope).map((found) => found.entry);
    const entries = [...own, ...installed.filter((entry) => !own.some((candidate) => candidate.path === entry.path))];
    if (entries.length === 0) continue;
    if (scope === "project" && !trusted(cwd)) {
      skipped.push({ directory, reason: "The project is not trusted in Pi, so its desktop extensions stay off." });
      continue;
    }
    for (const entry of entries) {
      try {
        const code = await bundleDesktopExtension(entry.path, options);
        const styles = entry.styles ? await readFile(entry.styles, "utf8") : undefined;
        const permissions = entry.manifest?.permissions ?? [];
        const granted = entry.manifest ? isPackageGranted(entry.manifest, grantsFile.grants) : true;
        bundles.push({
          id: entry.manifest?.id ?? slugForEntry(entry.path),
          path: entry.path,
          scope,
          projectPath: scope === "project" ? cwd : undefined,
          code,
          ...(styles ? { styles } : {}),
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
