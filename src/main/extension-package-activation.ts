import type { GlobalHostEvent, HostExtensionSummary } from "../shared/contracts.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { listExtensionPackages, packageIsolation, type ExtensionPackage, type HostPackageLoadResult } from "./extension-packages.js";
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
  /** Packages found on disk but never imported, because the user has not approved them. */
  private ungranted = new Map<string, ExtensionPackage>();
  private running?: Promise<void>;
  private queued?: Promise<void>;

  constructor(private readonly options: ExtensionPackageActivatorOptions) {}

  /** The first scan of a workspace. Nothing is announced: the client is still bootstrapping. */
  start(): Promise<void> {
    return this.enqueue(false);
  }

  /** Re-reads the packages and tells the client to re-read its desktop halves. */
  refresh(): Promise<void> {
    return this.queued ?? this.enqueue(true);
  }

  /** One scan at a time; refreshes arriving during one share the next instead of queueing up. */
  private enqueue(announce: boolean): Promise<void> {
    const next = (this.running ?? Promise.resolve()).then(async () => {
      if (this.queued === next) this.queued = undefined;
      await this.sync();
      if (announce) this.options.publish({ type: "extension-packages-changed" });
    });
    if (announce) this.queued = next;
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

  /** Replaces the host halves of extension packages with what the workspace's folders hold now. */
  private async sync(): Promise<void> {
    let loaded: HostPackageLoadResult;
    try {
      loaded = await this.options.load(this.options.cwd());
    } catch (error) {
      this.options.log("host-extension.packages.failed", message(error));
      return;
    }
    for (const failure of loaded.errors) this.options.log("host-extension.package.failed", `${failure.path}: ${failure.message}`);
    for (const skip of loaded.skipped) this.options.log("host-extension.package.skipped", `${skip.directory}: ${skip.reason}`);
    this.ungranted = new Map(loaded.ungranted.map((pkg) => [pkg.manifest.id, pkg]));
    for (const pkg of loaded.ungranted) {
      this.options.log("host-extension.package.ungranted", `${pkg.manifest.name} · ${pkg.scope} · awaiting approval`);
    }
    const next = new Set(loaded.extensions.map((entry) => entry.extension.id));
    // A package that left the disk, lost its grant or changed what it asks for
    // is no longer in the loaded set, so its half stops here.
    for (const id of this.activeIds) {
      if (next.has(id)) continue;
      this.entries.delete(id);
      await this.options.registry.remove(id).catch((error: unknown) => this.options.log("host-extension.remove.failed", `${id}: ${message(error)}`));
    }
    const grantsFile = await readExtensionGrants(this.options.grantsFilePath).catch(() => ({ grants: [] }));
    for (const entry of loaded.extensions) {
      const { extension, package: pkg } = entry;
      this.entries.set(extension.id, entry);
      if (this.options.bundled(extension.id)) {
        this.options.log("host-extension.package.failed", `${pkg.directory}: id ${extension.id} belongs to a bundled kit`);
        continue;
      }
      this.options.registry.addKnown(extension);
      if (!isPackageGranted(pkg.manifest, grantsFile.grants)) {
        this.options.log("host-extension.package.ungranted", `${extension.name} · awaiting permission grant`);
        continue;
      }
      await this.options.registry.activate(extension);
      this.options.log("host-extension.package.loaded", `${extension.name} · ${pkg.scope} · ${pkg.directory}`);
    }
    this.activeIds = next;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
