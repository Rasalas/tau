import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { HostExtension } from "./host-extensions.js";

export const MANIFEST_FILE = "tau-extension.json";
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

/**
 * `tau-extension.json` in a package folder under `~/.tau/extensions` or
 * `<project>/.tau/extensions`. The desktop entry is loaded by the renderer,
 * the host entry by the Electron main process; both halves share the id.
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  /** Relative path of the desktop entry (a module default-exporting a DesktopExtension). */
  desktop?: string;
  /** Relative path of the host entry (a module default-exporting a HostExtension or `activate`). */
  host?: string;
}

export interface ExtensionPackage {
  scope: "global" | "project";
  directory: string;
  manifest: ExtensionManifest;
  desktopEntry?: string;
  hostEntry?: string;
}

export function extensionPackageDirectories(cwd: string, home = homedir()): Array<{ scope: "global" | "project"; directory: string }> {
  return [
    { scope: "global", directory: join(home, ".tau", "extensions") },
    { scope: "project", directory: join(cwd, ".tau", "extensions") },
  ];
}

function relativeEntry(directory: string, value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${key}" must be a relative path`);
  if (isAbsolute(value)) throw new Error(`"${key}" must be relative to the package folder`);
  const path = resolve(directory, value);
  if (!path.startsWith(resolve(directory) + "/")) throw new Error(`"${key}" must stay inside the package folder`);
  return path;
}

/** Parses and validates one manifest; entries are resolved but not read. */
export function parseExtensionManifest(directory: string, source: string): { manifest: ExtensionManifest; desktopEntry?: string; hostEntry?: string } {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error(`${MANIFEST_FILE} is not valid JSON`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MANIFEST_FILE} must be an object`);
  const { id, name, desktop, host } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !EXTENSION_ID.test(id)) throw new Error(`"id" must look like "vendor.name" (lowercase letters, digits, dashes, dots)`);
  if (typeof name !== "string" || !name.trim()) throw new Error(`"name" must be a non-empty string`);
  const desktopEntry = relativeEntry(directory, desktop, "desktop");
  const hostEntry = relativeEntry(directory, host, "host");
  if (!desktopEntry && !hostEntry) throw new Error(`${MANIFEST_FILE} names neither a "desktop" nor a "host" entry`);
  return {
    manifest: { id, name: name.trim(), ...(typeof desktop === "string" ? { desktop } : {}), ...(typeof host === "string" ? { host } : {}) },
    ...(desktopEntry ? { desktopEntry } : {}),
    ...(hostEntry ? { hostEntry } : {}),
  };
}

export interface PackageScanResult {
  packages: ExtensionPackage[];
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

/** Every package folder with a manifest; project folders only where Pi trusts the project. */
export async function listExtensionPackages(
  cwd: string,
  agentDir: string,
  options: { home?: string; trusted?: (cwd: string) => boolean } = {},
): Promise<PackageScanResult> {
  const trusted = options.trusted ?? ((path: string) => new ProjectTrustStore(agentDir).get(path) === true);
  const result: PackageScanResult = { packages: [], errors: [], skipped: [] };
  for (const { scope, directory } of extensionPackageDirectories(cwd, options.home)) {
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    const found: ExtensionPackage[] = [];
    for (const name of names.sort()) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
      const packageDir = join(directory, name);
      const manifestPath = join(packageDir, MANIFEST_FILE);
      const info = await stat(manifestPath).catch(() => undefined);
      if (!info?.isFile()) continue;
      try {
        const parsed = parseExtensionManifest(packageDir, await readFile(manifestPath, "utf8"));
        for (const entry of [parsed.desktopEntry, parsed.hostEntry]) {
          if (entry && !await stat(entry).then((s) => s.isFile()).catch(() => false)) throw new Error(`entry ${entry} does not exist`);
        }
        found.push({ scope, directory: packageDir, ...parsed });
      } catch (error) {
        result.errors.push({ path: manifestPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (found.length === 0) continue;
    if (scope === "project" && !trusted(cwd)) {
      result.skipped.push({ directory, reason: "The project is not trusted in Pi, so its extension packages stay off." });
      continue;
    }
    result.packages.push(...found);
  }
  return result;
}

/**
 * Compiles a host entry to one CommonJS module the main process can load.
 * Node builtins and Electron stay external; everything else is bundled, so a
 * package brings its own dependencies.
 */
export async function bundleHostExtension(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    external: ["electron", "node:*"],
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

const requireModule = createRequire(import.meta.url);

function isHostExtension(value: unknown): value is HostExtension {
  const candidate = value as Partial<HostExtension> | null;
  return Boolean(candidate && typeof candidate.activate === "function");
}

/**
 * Imports a compiled host entry. The module default-exports a HostExtension,
 * a factory returning one, or just `activate`; id and name fall back to the
 * manifest and must match it when given.
 */
export async function importHostExtension(code: string, manifest: ExtensionManifest, cacheDir = join(tmpdir(), "tau-host-extensions")): Promise<HostExtension> {
  await mkdir(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
  const file = join(cacheDir, `${manifest.id}-${hash}.cjs`);
  await writeFile(file, code, "utf8");
  // The content hash in the file name keys Node's module cache, so an edited package loads fresh.
  const module = requireModule(file) as { default?: unknown; activate?: unknown };
  let candidate: unknown = module.default ?? (typeof module.activate === "function" ? module : undefined);
  if (typeof candidate === "function") candidate = (candidate as () => unknown)();
  if (!isHostExtension(candidate)) throw new Error("the module must default-export a host extension ({ id?, name?, activate })");
  const id = (candidate as { id?: unknown }).id;
  if (id !== undefined && id !== manifest.id) throw new Error(`the module's id "${String(id)}" differs from the manifest id "${manifest.id}"`);
  const name = (candidate as { name?: unknown }).name;
  return { id: manifest.id, name: typeof name === "string" && name.trim() ? name : manifest.name, activate: (context) => candidate.activate(context) };
}

export interface HostPackageLoadResult {
  extensions: Array<{ extension: HostExtension; package: ExtensionPackage }>;
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

/** Finds, compiles and imports the host halves of the packages a workspace sees. */
export async function loadHostExtensionPackages(
  cwd: string,
  agentDir: string,
  options: { home?: string; trusted?: (cwd: string) => boolean; cacheDir?: string } = {},
): Promise<HostPackageLoadResult> {
  const scan = await listExtensionPackages(cwd, agentDir, options);
  const result: HostPackageLoadResult = { extensions: [], errors: [...scan.errors], skipped: scan.skipped };
  for (const pkg of scan.packages) {
    if (!pkg.hostEntry) continue;
    try {
      const extension = await importHostExtension(await bundleHostExtension(pkg.hostEntry), pkg.manifest, options.cacheDir);
      result.extensions.push({ extension, package: pkg });
    } catch (error) {
      result.errors.push({ path: pkg.hostEntry, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
