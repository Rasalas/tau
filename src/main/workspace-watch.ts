import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { ConfigWatcher, type ConfigChange, type ConfigWatcherOptions, type WatchTarget } from "./config-watcher.js";
import { KIT_SOURCE_DIRECTORY } from "./bundled-kits.js";
import { looseExtensionId } from "./desktop-extensions.js";
import { MANIFEST_FILE, extensionPackageDirectories, parseExtensionManifest } from "./extension-packages.js";
import { listInstalledSources } from "./extension-sources.js";
import { defaultGlobalConfigPath, defaultProjectConfigPath } from "./host-config.js";
import {
  defaultGlobalThemesDir,
  defaultPiGlobalThemesDir,
  defaultPiProjectThemesDir,
  defaultProjectThemesDir,
} from "./user-themes.js";

/** The groups of files the host watches, in the host's own vocabulary. */
export type ConfigChangeKind = "packages" | "themes" | "keybindings" | "config";

export interface WorkspaceWatchOptions {
  cwd(): string;
  agentDir: string;
  home?: string;
  /** Root of the checkout whose `kits/` is edited; a packaged app runs prebuilt kits and passes none. */
  appPath?: string;
  /** Re-reads exactly these extension packages, both halves. */
  refreshPackages(ids: readonly string[]): Promise<void>;
  /** Everything else that moved; kits and clients decide what to re-read. */
  configChanged(change: { kind: ConfigChangeKind; paths: readonly string[] }): void;
  /** `extensions.watch`, asked at every retarget; off, nothing is watched. */
  enabled?(): boolean;
  log?(label: string, detail?: string): void;
  debounceMs?: number;
  /** Test seam: builds the watcher this wiring drives. */
  createWatcher?(options: ConfigWatcherOptions): ConfigWatcher;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const INDEX_FILES = ["index.tsx", "index.ts", "index.jsx", "index.js", "index.mjs"] as const;

/**
 * What the host watches and what it does when it changes: the package folders,
 * the theme folders, Pi's keybindings and Tau's own config files. It resolves a
 * changed path back to the extension that owns it, so a save reloads one
 * package rather than the workspace.
 */
export class WorkspaceWatch {
  private readonly watcher: ConfigWatcher;
  /** Extension ids by folder root and top-level entry name, kept so a deleted one is still known. */
  private readonly ids = new Map<string, Map<string, string>>();
  /** Package folders `packages.json` points at, with the id each one holds. */
  private readonly sources = new Map<string, string | undefined>();
  /** Package roots in the order they are searched, longest first, for path lookups. */
  private roots: string[] = [];

  constructor(private readonly options: WorkspaceWatchOptions) {
    const watcherOptions: ConfigWatcherOptions = {
      onChange: (change) => this.apply(change),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.log ? { log: options.log } : {}),
    };
    this.watcher = options.createWatcher?.(watcherOptions) ?? new ConfigWatcher(watcherOptions);
  }

  /** Attaches the watches for the open workspace; also called after a project switch and when `extensions.watch` changes. */
  async retarget(): Promise<void> {
    if (this.options.enabled?.() === false) {
      this.watcher.setTargets([]);
      return;
    }
    const cwd = this.options.cwd();
    const home = this.options.home ?? homedir();
    const folders = await listInstalledSources(cwd, home).catch(() => []);
    this.sources.clear();
    for (const entry of folders) {
      if (entry.source.kind !== "path" || entry.error) continue;
      this.sources.set(entry.directory, await packageId(entry.directory));
    }
    const packageRoots = [
      ...extensionPackageDirectories(cwd, home).map((entry) => entry.directory),
      ...(this.options.appPath ? [join(this.options.appPath, KIT_SOURCE_DIRECTORY)] : []),
    ];
    this.roots = [...packageRoots, ...this.sources.keys()].sort((left, right) => right.length - left.length);
    const targets: WatchTarget[] = [
      ...packageRoots.map((path) => ({ root: "packages", path, directory: true })),
      ...[...this.sources.keys()].map((path) => ({ root: "packages", path, directory: true })),
      ...this.themeDirectories(cwd, home).map((path) => ({ root: "themes", path, directory: true })),
      { root: "keybindings", path: join(this.options.agentDir, "keybindings.json") },
      { root: "config", path: defaultGlobalConfigPath(home) },
      { root: "config", path: defaultProjectConfigPath(cwd) },
    ];
    this.watcher.setTargets(targets);
  }

  close(): void {
    this.watcher.close();
  }

  private themeDirectories(cwd: string, home: string): string[] {
    return [
      defaultGlobalThemesDir(home),
      defaultProjectThemesDir(cwd),
      defaultPiGlobalThemesDir(home),
      defaultPiProjectThemesDir(cwd),
    ];
  }

  private apply(change: ConfigChange): void {
    if (change.root !== "packages") {
      this.options.log?.(`watch.${change.root}.changed`, change.paths.join(", "));
      this.options.configChanged({ kind: change.root as ConfigChangeKind, paths: change.paths });
      return;
    }
    void this.reloadPackages(change.paths).catch((error: unknown) => {
      this.options.log?.("watch.packages.failed", error instanceof Error ? error.message : String(error));
    });
  }

  private async reloadPackages(paths: readonly string[]): Promise<void> {
    const ids = new Set<string>();
    const touched = new Set(paths.map((path) => this.rootOf(path)).filter((entry): entry is string => Boolean(entry)));
    for (const folder of touched) {
      if (this.sources.has(folder)) continue;
      this.ids.set(folder, await entryIds(folder, this.ids.get(folder)));
    }
    for (const path of paths) {
      const id = this.idFor(path);
      if (id) ids.add(id);
    }
    if (ids.size === 0) return;
    this.options.log?.("watch.packages.changed", [...ids].join(", "));
    await this.options.refreshPackages([...ids]);
  }

  /** The watched package root a changed path lies in, if any. */
  private rootOf(path: string): string | undefined {
    return this.roots.find((root) => path === root || path.startsWith(`${root}${sep}`));
  }

  /** The extension a changed path belongs to: a folder's package, or a loose file. */
  private idFor(path: string): string | undefined {
    const root = this.rootOf(path);
    if (!root) return undefined;
    // A folder `packages.json` points at is one package, not a folder of them.
    if (this.sources.has(root)) return this.sources.get(root);
    const [name] = relative(root, path).split(sep);
    return name ? this.ids.get(root)?.get(name) : undefined;
  }
}

/** The id of the package in a folder, or nothing when there is no readable manifest. */
async function packageId(directory: string): Promise<string | undefined> {
  const source = await readFile(join(directory, MANIFEST_FILE), "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  try {
    return parseExtensionManifest(directory, source).manifest.id;
  } catch {
    return undefined;
  }
}

/**
 * Which extension id each top-level entry of a folder of packages carries: the
 * manifest's id for a package, the path-derived one for a loose file or an
 * `index.*` folder — the same answer the loaders give them. Ids already known
 * survive, so a folder that was just deleted can still be named.
 */
async function entryIds(root: string, known?: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const ids = new Map(known ?? []);
  let names: string[];
  try { names = await readdir(root); } catch { return ids; }
  for (const name of names) {
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isFile()) {
      if (SOURCE_FILE.test(name)) ids.set(name, looseExtensionId(path));
      continue;
    }
    if (!info.isDirectory()) continue;
    const id = await packageId(path);
    if (id) {
      ids.set(name, id);
      continue;
    }
    for (const index of INDEX_FILES) {
      const candidate = join(path, index);
      if (await stat(candidate).then((entry) => entry.isFile()).catch(() => false)) {
        ids.set(name, looseExtensionId(candidate));
        break;
      }
    }
  }
  return ids;
}
