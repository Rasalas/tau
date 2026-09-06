// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import "./packaged-app.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult, ExtensionPackageSummary } from "../shared/contracts.js";
import { bundleDesktopExtension, type BundleOptions } from "./desktop-extensions.js";
import {
  MANIFEST_FILE,
  bundleHostExtension,
  importHostExtension,
  manifestIncompatibility,
  packageIsolation,
  parseExtensionManifest,
  requireHostExtension,
  writeHostExtensionBundle,
  type ExtensionManifest,
} from "./extension-packages.js";
import { createWorkerHostExtension } from "./host-extension-isolation.js";
import type { HostExtension } from "./host-extensions.js";
import type { ExtensionHostVersions } from "../shared/extension-compat.js";

/** Prebuilt kits, as `scripts/build-kits.mjs` writes them and the app ships them. */
export const PREBUILT_KITS_DIRECTORY = "dist-kits";
/** The kits' sources, compiled on the fly when Tau runs from a checkout. */
export const KIT_SOURCE_DIRECTORY = "kits";

/**
 * A kit Tau ships. It is an extension package in every respect — same manifest,
 * same bundlers, same registry activation, same `guardedServices` — except for
 * where it comes from and that the user is not asked to approve it: shipping a
 * kit is the approval (ADR 0014).
 */
export interface BundledKit {
  directory: string;
  manifest: ExtensionManifest;
  hostEntry?: string;
  desktopEntry?: string;
  /** True when the entries are compiled output rather than TypeScript sources. */
  prebuilt: boolean;
}

export interface BundledKitsOptions {
  /** Root of the installed or checked-out app: `app.getAppPath()` under Electron. */
  appPath: string;
  /** Where a compiled host half is cached, keyed by content hash. */
  cacheDir?: string;
  /** Versions a kit's `engines` is checked against; a stale `dist-kits` fails here. */
  versions?: ExtensionHostVersions;
}

export interface BundledKitFailure {
  path: string;
  message: string;
}

/**
 * Where the kits are: the prebuilt distribution when it exists, the sources
 * otherwise. An installed Tau only ever has the first; a checkout has both
 * once `npm run build` has run, and the prebuilt one wins so that the app and
 * its release artifact load the same bytes.
 */
export async function resolveKitsRoot(appPath: string): Promise<{ directory: string; prebuilt: boolean } | undefined> {
  for (const [name, prebuilt] of [[PREBUILT_KITS_DIRECTORY, true], [KIT_SOURCE_DIRECTORY, false]] as const) {
    const directory = join(appPath, name);
    if (await stat(directory).then((info) => info.isDirectory()).catch(() => false)) return { directory, prebuilt };
  }
  return undefined;
}

/** Every kit under a root, in id order; a folder without a manifest is not a kit. */
export async function listBundledKits(
  root: { directory: string; prebuilt: boolean },
  versions?: ExtensionHostVersions,
): Promise<{ kits: BundledKit[]; errors: BundledKitFailure[] }> {
  const kits: BundledKit[] = [];
  const errors: BundledKitFailure[] = [];
  let names: string[];
  try { names = await readdir(root.directory); } catch { return { kits, errors }; }
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
    const directory = join(root.directory, name);
    const manifestPath = join(directory, MANIFEST_FILE);
    const source = await readFile(manifestPath, "utf8").catch(() => undefined);
    if (source === undefined) continue;
    try {
      const parsed = parseExtensionManifest(directory, source);
      const incompatible = manifestIncompatibility(parsed.manifest, versions);
      if (incompatible) throw new Error(incompatible);
      kits.push({ directory, prebuilt: root.prebuilt, ...parsed });
    } catch (error) {
      errors.push({ path: manifestPath, message: message(error) });
    }
  }
  kits.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  return { kits, errors };
}

async function kitsOf(options: BundledKitsOptions): Promise<{ kits: BundledKit[]; errors: BundledKitFailure[] }> {
  const root = await resolveKitsRoot(options.appPath);
  return root ? listBundledKits(root, options.versions) : { kits: [], errors: [] };
}

/**
 * The host halves of the shipped kits, ready for the registry. A prebuilt kit
 * is required straight from the file it ships; a source kit goes through the
 * package bundler and its content-hash cache, so an unchanged kit reuses the
 * compiled file it wrote last time.
 */
export async function loadBundledKitHostHalves(
  options: BundledKitsOptions,
): Promise<{ extensions: HostExtension[]; errors: BundledKitFailure[] }> {
  const { kits, errors } = await kitsOf(options);
  const extensions: HostExtension[] = [];
  for (const kit of kits) {
    if (!kit.hostEntry) continue;
    try {
      extensions.push(await hostHalf(kit, kit.hostEntry, options.cacheDir));
    } catch (error) {
      errors.push({ path: kit.hostEntry, message: message(error) });
    }
  }
  return { extensions, errors };
}

async function hostHalf(kit: BundledKit, entry: string, cacheDir?: string): Promise<HostExtension> {
  const isolated = packageIsolation(kit.manifest) === "worker";
  if (kit.prebuilt && !isolated) return requireHostExtension(entry, kit.manifest);
  const code = kit.prebuilt ? await readFile(entry, "utf8") : await bundleHostExtension(entry);
  if (!isolated) return importHostExtension(code, kit.manifest, cacheDir);
  // A worker starts from a real path, which a file inside the app archive is not.
  return createWorkerHostExtension({
    id: kit.manifest.id,
    name: kit.manifest.name,
    permissions: kit.manifest.permissions ?? [],
    file: await writeHostExtensionBundle(code, kit.manifest, cacheDir),
  });
}

/**
 * The shipped kits as Settings reads them, beside the installed packages. They
 * carry `scope: "bundled"` and are granted by construction, so the Packages page
 * can show what Tau brought apart from what the user installed.
 */
export async function inspectBundledKits(options: BundledKitsOptions): Promise<ExtensionPackageSummary[]> {
  const { kits } = await kitsOf(options);
  return kits.map((kit) => ({
    id: kit.manifest.id,
    name: kit.manifest.name,
    ...(kit.manifest.version ? { version: kit.manifest.version } : {}),
    ...(kit.manifest.engines ? { engines: { ...kit.manifest.engines } } : {}),
    permissions: kit.manifest.permissions ?? [],
    isolation: packageIsolation(kit.manifest),
    granted: true,
    ...(kit.manifest.source ? { source: { ...kit.manifest.source } } : {}),
    scope: "bundled" as const,
    directory: kit.directory,
    desktop: Boolean(kit.desktopEntry),
    host: Boolean(kit.hostEntry),
  }));
}

/** Compiled desktop halves, cached per file so a workspace switch recompiles nothing. */
const desktopCache = new Map<string, { key: string; code: string }>();

/**
 * The desktop halves of the shipped kits, as the bundles the renderer imports.
 * They carry `scope: "bundled"` and are granted by construction; everything
 * else about them travels the way a package's desktop half does.
 */
export async function loadBundledKitDesktopHalves(
  options: BundledKitsOptions & BundleOptions,
): Promise<DesktopExtensionLoadResult> {
  const { kits, errors } = await kitsOf(options);
  const bundles: DesktopExtensionBundle[] = [];
  for (const kit of kits) {
    if (!kit.desktopEntry) continue;
    try {
      bundles.push({
        id: kit.manifest.id,
        path: kit.desktopEntry,
        scope: "bundled",
        code: await desktopHalf(kit, kit.desktopEntry, options),
        permissions: kit.manifest.permissions ?? [],
        granted: true,
      });
    } catch (error) {
      errors.push({ path: kit.desktopEntry, message: message(error) });
    }
  }
  return { bundles, errors, skipped: [] };
}

async function desktopHalf(kit: BundledKit, entry: string, options: BundleOptions): Promise<string> {
  if (kit.prebuilt) return readFile(entry, "utf8");
  const info = await stat(entry);
  const key = `${info.mtimeMs}:${info.size}:${JSON.stringify(options.sharedExports)}`;
  const cached = desktopCache.get(entry);
  if (cached?.key === key) return cached.code;
  const code = await bundleDesktopExtension(entry, options);
  desktopCache.set(entry, { key, code });
  return code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
