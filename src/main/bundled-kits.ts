// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import "./packaged-app.js";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult, ExtensionPackageSummary } from "../shared/contracts.js";
import { bundleDesktopExtension, themeExtensionModule, type BundleOptions } from "./desktop-extensions.js";
import {
  MANIFEST_FILE,
  absoluteSourceMapLink,
  bundleHostExtension,
  importHostExtension,
  isThemeManifest,
  manifestIncompatibility,
  packageIsolation,
  parseExtensionManifest,
  requireHostExtension,
  writeHostExtensionBundle,
  type ExtensionManifest,
} from "./extension-packages.js";
import { createWorkerHostExtension } from "./host-extension-isolation.js";
import type { HostExtension } from "./host-extensions.js";
import type { ExtensionEngines, ExtensionHostVersions } from "../shared/extension-compat.js";

/** Prebuilt kits, as `scripts/build-kits.mjs` writes them and the app ships them. */
export const PREBUILT_KITS_DIRECTORY = "dist-kits";
/** The kits' sources, compiled on the fly when Tau runs from a checkout. */
export const KIT_SOURCE_DIRECTORY = "kits";

/**
 * The distribution the shipped kits arrive as: `@tau/kits` and its own version,
 * which moves as a set while each kit keeps the `version` in its own manifest.
 * `kits/package.json` declares it; `scripts/build-kits.mjs` copies it into
 * `dist-kits/manifest.json` so the installed app, which has no `kits/`, reads
 * the same two fields.
 */
export interface KitDistribution {
  name: string;
  version: string;
  engines?: ExtensionEngines;
}

/** Index of a prebuilt distribution; the sources answer with their `package.json`. */
const DISTRIBUTION_FILE = { prebuilt: "manifest.json", sources: "package.json" } as const;

/** What safe mode reports: no distribution, no kits. */
export const NO_BUNDLED_KITS: { distribution?: KitDistribution; packages: ExtensionPackageSummary[] } = { packages: [] };

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
  windowEntry?: string;
  desktopEntry?: string;
  stylesEntry?: string;
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
  /** Read `kits/` even when a prebuilt `dist-kits/` exists: a test wants the sources it sits beside, not last build's output. */
  sources?: boolean;
  /** Build only these kit ids; the rest keep the halves the client already has. */
  only?: readonly string[];
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
export async function resolveKitsRoot(appPath: string, sources = false): Promise<{ directory: string; prebuilt: boolean } | undefined> {
  const candidates = sources ? [[KIT_SOURCE_DIRECTORY, false]] as const : [[PREBUILT_KITS_DIRECTORY, true], [KIT_SOURCE_DIRECTORY, false]] as const;
  for (const [name, prebuilt] of candidates) {
    const directory = join(appPath, name);
    if (await stat(directory).then((info) => info.isDirectory()).catch(() => false)) return { directory, prebuilt };
  }
  return undefined;
}

/**
 * Which distribution a root of kits belongs to, or nothing when the file is
 * missing or unreadable — a checkout that never built its kits still runs them.
 */
export async function readKitDistribution(root: { directory: string; prebuilt: boolean }): Promise<KitDistribution | undefined> {
  const file = join(root.directory, root.prebuilt ? DISTRIBUTION_FILE.prebuilt : DISTRIBUTION_FILE.sources);
  const source = await readFile(file, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  try {
    const parsed = JSON.parse(source) as Partial<KitDistribution>;
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return undefined;
    return { name: parsed.name, version: parsed.version, ...(parsed.engines ? { engines: { ...parsed.engines } } : {}) };
  } catch {
    return undefined;
  }
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
  const root = await resolveKitsRoot(options.appPath, options.sources);
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

/**
 * The window halves of the shipped kits: the part of a kit that needs the
 * process the user's window runs in, compiled the same way a host half is
 * (ADR 0021). A kit without a `window` entry has none.
 */
export async function loadBundledKitWindowHalves(
  options: BundledKitsOptions,
): Promise<{ halves: Array<{ id: string; name: string; file: string }>; errors: BundledKitFailure[] }> {
  const { kits, errors } = await kitsOf(options);
  const halves: Array<{ id: string; name: string; file: string }> = [];
  for (const kit of kits) {
    if (!kit.windowEntry) continue;
    try {
      const code = kit.prebuilt ? await readFile(kit.windowEntry, "utf8") : await bundleHostExtension(kit.windowEntry);
      halves.push({
        id: kit.manifest.id,
        name: kit.manifest.name,
        // A real path, so the module loads like any other file of the app.
        file: kit.prebuilt ? kit.windowEntry : await writeHostExtensionBundle(code, kit.manifest, options.cacheDir, "window"),
      });
    } catch (error) {
      errors.push({ path: kit.windowEntry, message: message(error) });
    }
  }
  return { halves, errors };
}

async function hostHalf(kit: BundledKit, entry: string, cacheDir?: string): Promise<HostExtension> {
  const isolated = packageIsolation(kit.manifest) === "worker";
  if (kit.prebuilt && !isolated) return requireHostExtension(entry, kit.manifest);
  // The worker runs a copy, so its map link has to name the shipped map.
  const code = kit.prebuilt ? absoluteSourceMapLink(await readFile(entry, "utf8"), entry) : await bundleHostExtension(entry);
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
 * Every host half Tau ships, as the host activates them: a thunk, so the kits
 * compile with the host rather than with the module that configured it. Safe
 * mode never calls it.
 */
export function shippedHostExtensions(
  options: BundledKitsOptions,
  log: (label: string, detail: string) => void,
): () => Promise<HostExtension[]> {
  return async () => {
    const loaded = await loadBundledKitHostHalves(options);
    for (const failure of loaded.errors) log("host-extension.kit.failed", `${failure.path}: ${failure.message}`);
    // Detached: a checkout's staleness must not delay the kits it describes.
    void warnAboutStaleKits(options.appPath, log);
    return loaded.extensions;
  };
}

let staleKitsReported = false;

/**
 * `dist-kits/` wins over `kits/`, so an edited kit that was not rebuilt runs
 * as last build's code and the app silently disagrees with the checkout. Say
 * so once. An installed Tau has no `kits/` and never reaches the comparison.
 */
export async function warnAboutStaleKits(
  appPath: string,
  log: (label: string, detail: string) => void,
): Promise<void> {
  if (staleKitsReported) return;
  const [sources, prebuilt] = await Promise.all([
    newestModification(join(appPath, KIT_SOURCE_DIRECTORY)),
    newestModification(join(appPath, PREBUILT_KITS_DIRECTORY)),
  ]);
  if (sources === undefined || prebuilt === undefined || sources <= prebuilt) return;
  staleKitsReported = true;
  log("host-extension.kits.stale", `${KIT_SOURCE_DIRECTORY}/ changed after ${PREBUILT_KITS_DIRECTORY}/ was written; Tau is running the prebuilt kits. Run "npm run build:kits".`);
}

async function newestModification(directory: string): Promise<number | undefined> {
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true, recursive: true }); } catch { return undefined; }
  let newest = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = await stat(join(entry.parentPath, entry.name)).catch(() => undefined);
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest;
}

/**
 * The shipped kits as Settings reads them, beside the installed packages, and
 * the distribution they came in. They carry `scope: "bundled"` and are granted
 * by construction, so the Packages page can show what Tau brought apart from
 * what the user installed.
 */
export async function inspectBundledKits(
  options: BundledKitsOptions,
): Promise<{ distribution?: KitDistribution; packages: ExtensionPackageSummary[] }> {
  const root = await resolveKitsRoot(options.appPath, options.sources);
  if (!root) return { packages: [] };
  const [{ kits }, distribution] = await Promise.all([listBundledKits(root, options.versions), readKitDistribution(root)]);
  const packages = kits.map((kit) => ({
    id: kit.manifest.id,
    name: kit.manifest.name,
    ...(kit.manifest.version ? { version: kit.manifest.version } : {}),
    ...(kit.manifest.description ? { description: kit.manifest.description } : {}),
    ...(kit.manifest.engines ? { engines: { ...kit.manifest.engines } } : {}),
    permissions: kit.manifest.permissions ?? [],
    isolation: packageIsolation(kit.manifest),
    granted: true,
    ...(kit.manifest.source ? { source: { ...kit.manifest.source } } : {}),
    scope: "bundled" as const,
    directory: kit.directory,
    desktop: Boolean(kit.desktopEntry),
    host: Boolean(kit.hostEntry),
    ...(isThemeManifest(kit.manifest) ? { theme: true } : {}),
  }));
  return { ...(distribution ? { distribution } : {}), packages };
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
  const only = options.only ? new Set(options.only) : undefined;
  const bundles: DesktopExtensionBundle[] = [];
  for (const kit of kits) {
    if (only && !only.has(kit.manifest.id)) continue;
    // A shipped theme is a kit that is only a stylesheet; it travels as a
    // desktop half whose whole behaviour is having one.
    const theme = isThemeManifest(kit.manifest);
    const entry = kit.desktopEntry ?? (theme ? kit.stylesEntry : undefined);
    if (!entry) continue;
    try {
      bundles.push({
        id: kit.manifest.id,
        path: entry,
        scope: "bundled",
        code: theme ? themeExtensionModule(kit.manifest) : await desktopHalf(kit, entry, options),
        ...(kit.stylesEntry ? { styles: await readFile(kit.stylesEntry, "utf8") } : {}),
        permissions: kit.manifest.permissions ?? [],
        granted: true,
        ...(theme ? { theme: true } : {}),
      });
    } catch (error) {
      errors.push({ path: entry, message: message(error) });
    }
  }
  return { bundles, errors, skipped: [] };
}

async function desktopHalf(kit: BundledKit, entry: string, options: BundleOptions): Promise<string> {
  // The page imports a copy from `tau-ext:`, so the link has to name the shipped map.
  if (kit.prebuilt) return absoluteSourceMapLink(await readFile(entry, "utf8"), entry);
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
