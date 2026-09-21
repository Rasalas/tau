import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, sep } from "node:path";

/** `fs.watch`, injectable so a test can drive events without touching a disk. */
export type WatchFn = (
  path: string,
  options: { recursive?: boolean },
  listener: (event: string, filename: string | null) => void,
) => FSWatcher;

/** One path the host watches, under the name a consumer keys its changes on. */
export interface WatchTarget {
  /** Stable name of the group this path belongs to, e.g. "packages" or "themes". */
  root: string;
  path: string;
  /** A folder whose whole subtree matters; without it `path` is a single file. */
  directory?: boolean;
}

export interface ConfigChange {
  root: string;
  /** Absolute paths the platform named, or the watched path when it named none. */
  paths: string[];
}

export interface ConfigWatcherOptions {
  onChange(change: ConfigChange): void;
  /** Quiet period a burst of events is collected over. */
  debounceMs?: number;
  log?(label: string, detail?: string): void;
  /** Overrides a test supplies instead of a real disk. */
  watch?: WatchFn;
  /** Whether `fs.watch` can follow a whole tree here; without it folders are watched one level deep. */
  recursive?: boolean;
  exists?(path: string): boolean;
  /** Immediate subfolder names of a directory, for the flat fallback. */
  readDirectories?(path: string): string[];
  /** Paths that never count as a change; build output and VCS noise by default. */
  ignore?(path: string): boolean;
}

/** Whether `fs.watch` follows a whole tree on this platform (Node documents macOS and Windows). */
export function supportsRecursiveWatch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/**
 * Watching is on unless the user turned it off or `TAU_NO_WATCH=1` is set —
 * which is what a headless run, a CI job or a bisect wants.
 */
export function watchingEnabled(
  config: { extensions?: { watch?: boolean } } = {},
  env: { TAU_NO_WATCH?: string } = process.env,
): boolean {
  if (env.TAU_NO_WATCH === "1") return false;
  return config.extensions?.watch !== false;
}

const NOISE = [`${sep}node_modules${sep}`, `${sep}.git${sep}`, `${sep}dist-kits${sep}`, `${sep}.DS_Store`];

function defaultIgnore(path: string): boolean {
  return NOISE.some((fragment) => path.includes(fragment)) || path.endsWith("~") || /\.swp$/u.test(path);
}

function defaultReadDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface Attachment {
  target: WatchTarget;
  /** What this attachment really watches; a derived one is a subfolder, a waiting one an ancestor. */
  path: string;
  recursive: boolean;
  /** Set while the attachment only exists to notice `path`'s missing descendant appearing. */
  waitingFor?: string;
  watcher: FSWatcher;
}

/**
 * Watches a set of files and folders and reports what changed, once per quiet
 * period and grouped by root. It survives the two things an editor does that a
 * plain `fs.watch` does not: replacing a file by renaming another one over it
 * (the old watch goes deaf, so a changed file is re-attached), and writing into
 * a folder that does not exist yet (the nearest existing ancestor is watched
 * until it does).
 */
export class ConfigWatcher {
  private readonly attachments = new Map<string, Attachment>();
  private readonly changed = new Map<string, Set<string>>();
  private targets: WatchTarget[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly debounceMs: number;
  private readonly watchFn: WatchFn;
  private readonly recursive: boolean;
  private readonly exists: (path: string) => boolean;
  private readonly readDirectories: (path: string) => string[];
  private readonly ignore: (path: string) => boolean;

  constructor(private readonly options: ConfigWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 300;
    this.watchFn = options.watch ?? ((path, watchOptions, listener) => watch(path, watchOptions, listener));
    this.recursive = options.recursive ?? supportsRecursiveWatch();
    this.exists = options.exists ?? existsSync;
    this.readDirectories = options.readDirectories ?? defaultReadDirectories;
    this.ignore = options.ignore ?? defaultIgnore;
  }

  /** Replaces the watched set; paths that stay keep their watch. */
  setTargets(targets: readonly WatchTarget[]): void {
    if (this.closed) return;
    this.targets = [...targets];
    this.reconcile();
  }

  /** Every path a watch is attached to, for tests and diagnostics. */
  watching(): string[] {
    return [...this.attachments.values()].map((attachment) => attachment.path).sort();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of [...this.attachments.keys()]) this.detach(key);
    this.changed.clear();
  }

  /** Attaches what the targets ask for and drops what they no longer do. */
  private reconcile(): void {
    const wanted = new Map<string, { target: WatchTarget; path: string; recursive: boolean; waitingFor?: string }>();
    const want = (target: WatchTarget, path: string, recursive: boolean, waitingFor?: string): void => {
      wanted.set(keyOf(target.root, path, waitingFor), { target, path, recursive, ...(waitingFor ? { waitingFor } : {}) });
    };
    for (const target of this.targets) {
      if (!this.exists(target.path)) {
        // The folder or file may be created later; the nearest ancestor that
        // does exist is what tells us when it is.
        const ancestor = this.nearestExisting(target.path);
        if (ancestor) want(target, ancestor, false, target.path);
        continue;
      }
      if (!target.directory) {
        want(target, target.path, false);
        continue;
      }
      want(target, target.path, this.recursive);
      // Without a recursive watch the platform reports the folder itself only,
      // so every package folder under it gets a watch of its own.
      if (!this.recursive) {
        for (const name of this.readDirectories(target.path)) want(target, join(target.path, name), false);
      }
    }
    for (const key of [...this.attachments.keys()]) {
      if (!wanted.has(key)) this.detach(key);
    }
    for (const [key, entry] of wanted) {
      if (this.attachments.has(key)) continue;
      this.attach(key, entry.target, entry.path, entry.recursive, entry.waitingFor);
    }
  }

  private nearestExisting(path: string): string | undefined {
    let current = dirname(path);
    while (!this.exists(current)) {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return current;
  }

  private attach(key: string, target: WatchTarget, path: string, recursive: boolean, waitingFor?: string): void {
    let watcher: FSWatcher;
    try {
      watcher = this.watchFn(path, { recursive }, (_event, filename) => {
        this.record(key, filename);
      });
    } catch (error) {
      // A path that vanished between the check and the call, or one the
      // platform refuses: the next flush tries again.
      this.options.log?.("config-watcher.attach.failed", `${path}: ${message(error)}`);
      return;
    }
    watcher.on("error", (error) => {
      this.options.log?.("config-watcher.failed", `${path}: ${message(error)}`);
      this.detach(key);
    });
    this.attachments.set(key, { target, path, recursive, ...(waitingFor ? { waitingFor } : {}), watcher });
  }

  private detach(key: string): void {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    this.attachments.delete(key);
    try { attachment.watcher.close(); } catch { /* a watcher that is already gone needs no closing */ }
  }

  private record(key: string, filename: string | null): void {
    const attachment = this.attachments.get(key);
    if (!attachment || this.closed) return;
    const path = attachment.waitingFor
      ? attachment.waitingFor
      : attachment.target.directory && filename ? join(attachment.path, filename) : attachment.path;
    if (this.ignore(path)) return;
    const paths = this.changed.get(attachment.target.root) ?? new Set<string>();
    this.changed.set(attachment.target.root, paths);
    paths.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    // A host that is otherwise idle should still be allowed to exit.
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = undefined;
    if (this.closed) return;
    const batches = [...this.changed.entries()].map(([root, paths]) => ({ root, paths: [...paths].sort() }));
    this.changed.clear();
    // A file the editor replaced left this watch pointing at the old inode, and
    // a folder that appeared needs its own watch now: re-derive before reporting,
    // so whoever re-reads the file gets the new one and the next edit still arrives.
    for (const batch of batches) {
      for (const [key, attachment] of [...this.attachments]) {
        if (attachment.target.root !== batch.root) continue;
        if (attachment.target.directory && !attachment.waitingFor) continue;
        this.detach(key);
      }
    }
    this.reconcile();
    for (const batch of batches) {
      try {
        this.options.onChange(batch);
      } catch (error) {
        this.options.log?.("config-watcher.listener.failed", `${batch.root}: ${message(error)}`);
      }
    }
  }
}

function keyOf(root: string, path: string, waitingFor?: string): string {
  return `${root}\u0000${path}\u0000${waitingFor ?? ""}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
