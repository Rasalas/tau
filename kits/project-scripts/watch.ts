import { existsSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";

/** The part of `fs.watch` this module uses, so a test can fire events itself. */
export interface Watcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export type WatchFn = (path: string, listener: (event: string, filename: string | null) => void) => Watcher;

const defaultWatch: WatchFn = (path, listener) => fsWatch(path, { persistent: false }, (event, filename) => listener(event, filename ? String(filename) : null));

export interface ProjectFileWatchOptions {
  onChange(directory: string): void;
  watch?: WatchFn;
  exists?(path: string): boolean;
  debounceMs?: number;
  /** Checkouts watched at once; the one looked at longest ago is let go first. */
  limit?: number;
}

interface Followed {
  root: Watcher;
  folder?: Watcher;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Follows `.tau/project.json` in the checkouts the workbench looked at. Core
 * watches only the files the host itself reads, so this kit watches its own:
 * the checkout folder for `.tau` appearing or going, and `.tau` for the file.
 */
export class ProjectFileWatch {
  private readonly followed = new Map<string, Followed>();
  private readonly watch: WatchFn;
  private readonly exists: (path: string) => boolean;

  constructor(private readonly options: ProjectFileWatchOptions) {
    this.watch = options.watch ?? defaultWatch;
    this.exists = options.exists ?? existsSync;
  }

  follow(directory: string): void {
    const known = this.followed.get(directory);
    if (known) {
      // Most recently looked at goes to the end of the eviction order.
      this.followed.delete(directory);
      this.followed.set(directory, known);
      return;
    }
    let root: Watcher;
    try {
      root = this.watch(directory, (_event, filename) => {
        if (filename !== null && filename !== ".tau") return;
        this.attachFolder(directory);
        this.changed(directory);
      });
    } catch {
      return;
    }
    root.on("error", () => this.unfollow(directory));
    const entry: Followed = { root };
    this.followed.set(directory, entry);
    this.attachFolder(directory);
    const limit = this.options.limit ?? 16;
    while (this.followed.size > limit) this.unfollow(this.followed.keys().next().value as string);
  }

  unfollow(directory: string): void {
    const entry = this.followed.get(directory);
    if (!entry) return;
    this.followed.delete(directory);
    if (entry.timer) clearTimeout(entry.timer);
    entry.folder?.close();
    entry.root.close();
  }

  watching(): string[] {
    return [...this.followed.keys()];
  }

  dispose(): void {
    for (const directory of [...this.followed.keys()]) this.unfollow(directory);
  }

  private attachFolder(directory: string): void {
    const entry = this.followed.get(directory);
    if (!entry) return;
    const folder = join(directory, ".tau");
    if (!this.exists(folder)) {
      entry.folder?.close();
      entry.folder = undefined;
      return;
    }
    if (entry.folder) return;
    try {
      const watcher = this.watch(folder, (_event, filename) => {
        if (filename === null || filename === "project.json") this.changed(directory);
      });
      watcher.on("error", () => {
        if (entry.folder === watcher) entry.folder = undefined;
        watcher.close();
      });
      entry.folder = watcher;
    } catch {
      entry.folder = undefined;
    }
  }

  /** A save is a burst of events; the file is read once after it. */
  private changed(directory: string): void {
    const entry = this.followed.get(directory);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.options.onChange(directory);
    }, this.options.debounceMs ?? 150);
  }
}
