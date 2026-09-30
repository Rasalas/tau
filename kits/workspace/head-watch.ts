import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Checkouts watched at once; the least recently asked about goes first. */
export const HEAD_WATCHES = 16;
const DEBOUNCE_MS = 150;

type WatchFn = (path: string, listener: (event: string, filename: string | null) => void) => FSWatcher;

/** The git dir of a checkout without spawning git: `.git` itself, or where a worktree's `.git` file points. */
export function gitDirOf(root: string): string | undefined {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    return pointer ? (isAbsolute(pointer) ? pointer : resolve(root, pointer)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Watches the `HEAD` of the checkouts clients show, so a `git checkout` in a
 * terminal reaches the branch label without polling. One watch per checkout,
 * whatever number of clients follow it.
 */
export class HeadWatch {
  private readonly watches = new Map<string, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: {
    changed(root: string): void;
    watch?: WatchFn;
    gitDir?(root: string): string | undefined;
    limit?: number;
  }) {}

  follow(root: string): void {
    const known = this.watches.get(root);
    if (known) {
      // Re-inserted, so eviction takes the checkout asked about longest ago.
      this.watches.delete(root);
      this.watches.set(root, known);
      return;
    }
    const gitDir = (this.options.gitDir ?? gitDirOf)(root);
    if (!gitDir) return;
    const debounce: { timer?: ReturnType<typeof setTimeout> } = {};
    let watcher: FSWatcher;
    try {
      // The folder, not the file: git replaces HEAD by renaming HEAD.lock over it.
      watcher = (this.options.watch ?? ((path, listener) => watch(path, listener)))(gitDir, (_event, filename) => {
        if (filename !== "HEAD") return;
        if (debounce.timer) clearTimeout(debounce.timer);
        debounce.timer = setTimeout(() => { debounce.timer = undefined; this.options.changed(root); }, DEBOUNCE_MS);
        debounce.timer.unref?.();
      });
    } catch {
      return;
    }
    watcher.on?.("error", () => this.forget(root));
    const entry = Object.assign(debounce, { watcher });
    this.watches.set(root, entry);
    const limit = this.options.limit ?? HEAD_WATCHES;
    while (this.watches.size > limit) this.forget(this.watches.keys().next().value!);
  }

  close(): void {
    for (const root of [...this.watches.keys()]) this.forget(root);
  }

  private forget(root: string): void {
    const entry = this.watches.get(root);
    if (!entry) return;
    this.watches.delete(root);
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
  }
}
