import { sep } from "node:path";
import type { GlobalHostEvent, HostExtensionSummary, PackageBuildError } from "../shared/contracts.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { listExtensionPackages, packageIsolation, type ExtensionPackage, type HostPackageLoadResult, type LoadedHostPackage } from "./extension-packages.js";
import type { HostExtension, HostExtensionRegistry } from "./host-extensions.js";

export interface ExtensionPackageActivatorOptions {
  registry: HostExtensionRegistry;
  /** Scans, compiles and imports the host halves a workspace sees; ungranted ones stop before the import. */
  load(cwd: string): Promise<HostPackageLoadResult>;
  cwd(): string;
  agentDir: string;
  /** A bundled kit owns its id; a package may not take it over. */
  bundled(id: string): boolean;
  log(label: string, detail?: string): void;
  publish(event: GlobalHostEvent): void;
  grantsFilePath?: string;
}

/**
 * Owns the host halves of extension packages: which ones are imported, which
 * wait for a grant, and when the two sides of the app have to hear that the set
 * changed. Installing, updating, removing and approving a package all end here,
 * so none of them needs a restart of the workbench.
 */
export class ExtensionPackageActivator {
  private activeIds = new Set<string>();
  private entries = new Map<string, { extension: HostExtension; package: ExtensionPackage }>();
  /** What is running per package, so an unrelated scan leaves it alone. */
  private activeKeys = new Map<string, string>();
  /** Packages found on disk but never imported, because the user has not approved them. */
  private ungranted = new Map<string, ExtensionPackage>();
  private running?: Promise<void>;
  private queued?: Promise<void>;

  constructor(private readonly options: ExtensionPackageActivatorOptions) {}

  /** The first scan of a workspace. Nothing is announced: the client is still bootstrapping. */
  start(): Promise<void> {
    return this.enqueue(false, false);
  }

  /**
   * Re-reads the packages and tells the client to re-read its desktop halves.
   * `force` restarts every package the way `/reload` always has; without it a
   * package whose code, permissions, isolation and folder are unchanged keeps
   * running, so installing one package never resets another one's worker.
   * `only` narrows the whole pass to the named ids: nothing else is started,
   * stopped or announced, which is what a watched file edit asks for.
   */
  refresh(options: { force?: boolean; only?: readonly string[] } = {}): Promise<void> {
    if (options.only) return this.enqueue(true, false, new Set(options.only));
    if (options.force) return this.enqueue(true, true);
    return this.queued ?? this.enqueue(true, false);
  }

  /** One scan at a time; refreshes arriving during one share the next instead of queueing up. */
  private enqueue(announce: boolean, force: boolean, only?: ReadonlySet<string>): Promise<void> {
    const next = (this.running ?? Promise.resolve()).then(async () => {
      if (this.queued === next) this.queued = undefined;
      const buildErrors = await this.sync(force, only);
      if (announce) {
        this.options.publish({
          type: "extension-packages-changed",
          ...(only ? { extensionIds: [...only] } : {}),
          ...(buildErrors.length > 0 ? { buildErrors } : {}),
        });
      }
    });
    if (announce && !force && !only) this.queued = next;
    this.running = next.catch(() => undefined);
    return next;
  }

  /**
   * Records the user's answer for a package and applies it at once: an approved
   * package is imported and started here, a revoked one loses both its halves.
   */
  async grant(id: string, granted: boolean): Promise<void> {
    const manifest = this.entries.get(id)?.package.manifest
      ?? this.ungranted.get(id)?.manifest
      ?? (await listExtensionPackages(this.options.cwd(), this.options.agentDir)).packages.find((pkg) => pkg.manifest.id === id)?.manifest;
    if (!manifest) return;
    await grantPackage(manifest, granted, this.options.grantsFilePath);
    this.options.log(granted ? "host-extension.granted" : "host-extension.revoked", id);
    await this.refresh();
  }

  /** Rows for packages the registry cannot know about, because their code was never loaded. */
  waitingSummaries(known: ReadonlySet<string>): HostExtensionSummary[] {
    return [...this.ungranted.values()]
      .filter((pkg) => !known.has(pkg.manifest.id))
      .map((pkg) => ({
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        active: false,
        commands: [],
        isolation: packageIsolation(pkg.manifest),
      }));
  }

  /**
   * Replaces the host halves of extension packages with what the workspace's
   * folders hold now, and answers the compile errors of the packages it was
   * asked about, for the client to show.
   */
  private async sync(force: boolean, only?: ReadonlySet<string>): Promise<PackageBuildError[]> {
    let loaded: HostPackageLoadResult;
    try {
      loaded = await this.options.load(this.options.cwd());
    } catch (error) {
      this.options.log("host-extension.packages.failed", message(error));
      return [];
    }
    for (const failure of loaded.errors) this.options.log("host-extension.package.failed", `${failure.path}: ${failure.message}`);
    for (const skip of loaded.skipped) this.options.log("host-extension.package.skipped", `${skip.directory}: ${skip.reason}`);
    // A package whose folder produced an error — a manifest that stopped
    // parsing, an entry that stopped compiling — is missing from the loaded set
    // without having left the disk. Its running half is its last good version,
    // so it keeps running until the files are readable again.
    const broken = new Set([...this.entries]
      .filter(([, entry]) => loaded.errors.some((failure) => inside(failure.path, entry.package.directory)))
      .map(([id]) => id));
    const wanted = (id: string): boolean => !only || only.has(id);
    this.ungranted = new Map([
      ...(only ? [...this.ungranted].filter(([id]) => !only.has(id)) : []),
      ...loaded.ungranted.filter((pkg) => wanted(pkg.manifest.id)).map((pkg) => [pkg.manifest.id, pkg] as const),
    ]);
    for (const pkg of loaded.ungranted) {
      if (!wanted(pkg.manifest.id)) continue;
      this.options.log("host-extension.package.ungranted", `${pkg.manifest.name} · ${pkg.scope} · awaiting approval`);
    }
    const found = new Set(loaded.extensions.map((entry) => entry.extension.id));
    // A package that left the disk, lost its grant or changed what it asks for
    // is no longer in the loaded set, so its half stops here.
    for (const id of this.activeIds) {
      if (found.has(id) || !wanted(id)) continue;
      if (broken.has(id)) {
        this.options.log("host-extension.package.kept", `${id} · reload failed, the running version stays`);
        continue;
      }
      this.entries.delete(id);
      this.activeKeys.delete(id);
      await this.options.registry.remove(id).catch((error: unknown) => this.options.log("host-extension.remove.failed", `${id}: ${message(error)}`));
    }
    const next = only ? new Set([...this.activeIds].filter((id) => !only.has(id))) : new Set<string>();
    for (const id of this.activeIds) if (broken.has(id)) next.add(id);
    for (const id of found) if (wanted(id)) next.add(id);
    const grantsFile = await readExtensionGrants(this.options.grantsFilePath).catch(() => ({ grants: [] }));
    const keys = only ? new Map(this.activeKeys) : new Map<string, string>();
    for (const entry of loaded.extensions) {
      const { extension, package: pkg } = entry;
      if (!wanted(extension.id)) continue;
      if (this.options.bundled(extension.id)) {
        this.options.log("host-extension.package.failed", `${pkg.directory}: id ${extension.id} belongs to a bundled kit`);
        continue;
      }
      const key = packageIdentity(entry);
      if (!force && this.activeKeys.get(extension.id) === key && this.options.registry.isActive(extension.id)) {
        // Same code, same grant, same folder: the half already running is the
        // one this scan would build, so its worker and its state stay.
        keys.set(extension.id, key);
        continue;
      }
      this.entries.set(extension.id, entry);
      this.options.registry.addKnown(extension);
      if (!isPackageGranted(pkg.manifest, grantsFile.grants)) {
        this.options.log("host-extension.package.ungranted", `${extension.name} · awaiting permission grant`);
        continue;
      }
      if (await this.options.registry.activate(extension)) keys.set(extension.id, key);
      this.options.log("host-extension.package.loaded", `${extension.name} · ${pkg.scope} · ${pkg.directory}`);
    }
    this.activeIds = next;
    this.activeKeys = keys;
    return loaded.errors
      .filter((failure) => failure.diagnostics && (!only || (failure.id !== undefined && only.has(failure.id))))
      .map(({ path, message: text, diagnostics }) => ({ path, message: text, ...(diagnostics ? { diagnostics } : {}) }));
  }
}

/**
 * Everything that decides what a package's host half is: the compiled code, the
 * grant it runs under, and where it came from. Two scans agreeing on this key
 * would build the same extension, so the older one may keep running.
 */
function packageIdentity(entry: LoadedHostPackage): string {
  const { manifest } = entry.package;
  return [
    entry.extension.id,
    entry.bundleHash,
    packageIsolation(manifest),
    [...(manifest.permissions ?? [])].sort().join(","),
    entry.package.scope,
    entry.package.directory,
  ].join("|");
}

/** Whether a reported path belongs to a package folder. */
function inside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
