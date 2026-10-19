// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import "./packaged-app.js";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import type { ExtensionPackageSummary, PackageBuildError } from "../shared/contracts.js";
import { SHARED_MODULE_SPECIFIERS } from "../shared/shared-modules.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { MANIFEST_FILE, bundleHostExtension, globalExtensionsDirectory, isThemeManifest, listExtensionPackages, packageIsolation, packageSummary, type ExtensionPackage } from "./extension-packages.js";
import { packagesHome } from "./extension-sources.js";
import { HostCommandError } from "./host-extension-errors.js";
import { describeBuildError, packageBuilds } from "./package-builds.js";

/** What `services.reviewPackage` answers (API 1.75.0). */
export interface PackageReview {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** The package folder, directly inside the global extension folder. */
  directory: string;
  permissions: string[];
  isolation: "worker" | "in-process";
  /** Whether the package has a window half, and a host half. */
  desktop: boolean;
  host: boolean;
  /** The user already allowed exactly this folder, so it runs and nothing is left to ask. */
  granted: boolean;
  /** Names the folder's files, permissions and isolation as reviewed; `approvePackage` refuses a folder that changed since. */
  fingerprint: string;
  /** Entries that do not compile; empty when the package builds. */
  buildErrors: PackageBuildError[];
}

export interface PackageFolderOptions {
  cwd: string;
  agentDir: string;
  home?: string;
  grantsFilePath?: string;
}

async function locate(input: string, options: PackageFolderOptions): Promise<{ pkg: ExtensionPackage; grants: Awaited<ReturnType<typeof readExtensionGrants>>["grants"] }> {
  const home = options.home ?? packagesHome();
  const root = globalExtensionsDirectory(home);
  const refusal = () => new HostCommandError(`Only a package folder directly inside ${root} can be installed. Create one with tau_new_package.`);
  if (!input.trim()) throw refusal();
  const wanted = resolve(root, input.trim());
  const [real, realRoot] = await Promise.all([realpath(wanted).catch(() => undefined), realpath(root).catch(() => undefined)]);
  if (!real || !realRoot) throw new HostCommandError(`${wanted} does not exist. Create a package with tau_new_package.`);
  const inside = relative(realRoot, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.includes(sep)) throw refusal();
  if (!(await stat(real)).isDirectory()) throw refusal();
  const directory = join(root, inside);
  const [scan, grantsFile] = await Promise.all([
    listExtensionPackages(options.cwd, options.agentDir, { home, trusted: () => false }),
    readExtensionGrants(options.grantsFilePath),
  ]);
  const pkg = scan.packages.find((entry) => entry.scope === "global" && entry.directory === directory);
  if (!pkg) {
    const failure = scan.errors.find((entry) => entry.path === join(directory, MANIFEST_FILE) || entry.path.startsWith(`${directory}${sep}`));
    throw new HostCommandError(failure ? `${failure.message} (${failure.path})` : `${directory} has no ${MANIFEST_FILE}. Create a package with tau_new_package.`);
  }
  return { pkg, grants: grantsFile.grants };
}

/** Compiles the window half without running it; the workbench's own modules are left out, they only exist there. */
async function checkDesktopEntry(entry: string): Promise<void> {
  await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    logLevel: "silent",
    external: [...SHARED_MODULE_SPECIFIERS],
  });
}

async function buildErrorsOf(pkg: ExtensionPackage): Promise<PackageBuildError[]> {
  const errors: PackageBuildError[] = [];
  const halves = [
    ...(pkg.hostEntry ? [{ half: "host" as const, entry: pkg.hostEntry, compile: async () => { await bundleHostExtension(pkg.hostEntry!); } }] : []),
    ...(pkg.desktopEntry ? [{ half: "desktop" as const, entry: pkg.desktopEntry, compile: () => checkDesktopEntry(pkg.desktopEntry!) }] : []),
  ];
  for (const { half, entry, compile } of halves) {
    const attempt = { id: pkg.manifest.id, directory: pkg.directory, half, entry };
    try {
      // oxlint-disable-next-line no-await-in-loop -- at most two halves, one esbuild run each
      await compile();
      packageBuilds.record({ ...attempt, at: Date.now(), ok: true });
    } catch (error) {
      const failure = describeBuildError(error, pkg.directory);
      packageBuilds.record({ ...attempt, at: Date.now(), ok: false, ...failure });
      errors.push({ path: entry, ...failure });
    }
  }
  return errors;
}

function fingerprintOf(pkg: ExtensionPackage): string {
  return createHash("sha256").update(JSON.stringify([
    pkg.manifest.id,
    pkg.grantIdentity?.contentHash ?? "",
    pkg.grantIdentity?.signer ?? "",
    [...(pkg.manifest.permissions ?? [])].sort(),
    packageIsolation(pkg.manifest),
  ])).digest("hex");
}

/**
 * Reads a package folder below the global extension folder and compiles each
 * half without running it, so the author sees build errors before the user is
 * asked anything. Grants nothing.
 */
export async function reviewPackageFolder(input: string, options: PackageFolderOptions): Promise<PackageReview> {
  const { pkg, grants } = await locate(input, options);
  const summary = packageSummary(pkg, grants);
  return {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    ...(pkg.manifest.version ? { version: pkg.manifest.version } : {}),
    ...(pkg.manifest.description ? { description: pkg.manifest.description } : {}),
    directory: pkg.directory,
    permissions: [...(pkg.manifest.permissions ?? [])],
    isolation: packageIsolation(pkg.manifest),
    desktop: summary.desktop,
    host: summary.host,
    granted: summary.granted === true,
    fingerprint: fingerprintOf(pkg),
    buildErrors: isThemeManifest(pkg.manifest) ? [] : await buildErrorsOf(pkg),
  };
}

export interface PackageApprovalOptions extends PackageFolderOptions {
  /** Whether the connection that asked is the host's owner. */
  owner: boolean;
  /** The native consent dialog (ADR 0036): true or false is its answer, undefined means no native window is available. */
  confirm?(pkg: ExtensionPackageSummary): Promise<boolean | undefined>;
}

/**
 * Records the owner's yes for exactly the folder `fingerprint` names. Only an
 * owner connection counts, never a paired device. The grant goes through the
 * same native dialog as Settings → Extensions; without a native window the
 * owner's click stands (ADR 0036), but a cancelled, failed or timed-out dialog
 * refuses. A folder that changed since the card, or while the dialog was open,
 * is refused.
 */
export async function approvePackageFolder(input: string, fingerprint: string, options: PackageApprovalOptions): Promise<string> {
  if (!options.owner) throw new HostCommandError("Only the host's owner can allow a package.");
  const unchanged = async () => {
    const found = await locate(input, options);
    if (fingerprintOf(found.pkg) !== fingerprint) throw new HostCommandError("The package changed after it was shown to you. Ask the agent to install it again.");
    return found;
  };
  const { pkg, grants } = await unchanged();
  if (isPackageGranted(pkg.manifest, grants, pkg.grantIdentity)) return pkg.manifest.id;
  const confirmed = await options.confirm?.(packageSummary(pkg, grants)).catch(() => false);
  if (confirmed === false) throw new HostCommandError("The package was not allowed in the confirmation dialog, so it stays off.");
  const latest = await unchanged();
  await grantPackage(latest.pkg.manifest, true, options.grantsFilePath, latest.pkg.grantIdentity);
  return latest.pkg.manifest.id;
}
