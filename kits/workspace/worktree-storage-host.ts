import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { GitRunner } from "./workspace-git.js";
import { STORAGE_CHANGED_EVENT } from "./storage-protocol.js";
import { WorktreeStorage, storageGit } from "./worktree-storage.js";

const HOUR_MS = 60 * 60_000;
const FIRST_SWEEP_MS = 60_000;
/** A deletion that a rule answers is swept soon, not at the next hour. */
const AFTER_DELETE_MS = 1_500;

const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

function sweepInterval(): number {
  const fromEnv = Number(process.env.TAU_WORKTREE_SWEEP_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : HOUR_MS;
}

/**
 * The storage half of Workspace Kit's host entry: the record of the worktrees
 * Tau made, the commands of Settings → Storage and the kit's own sweep timer,
 * which runs while no window is open too.
 */
export function registerWorktreeStorage(
  context: HostExtensionContext,
  options: { removed(repository: string): void; runGit?: GitRunner },
): { storage: WorktreeStorage; dispose(): void } {
  const { services } = context;
  const runGit: GitRunner = options.runGit ?? (async (cwd, args, maxBuffer) => {
    services.noteSubprocess();
    return storageGit(cwd, args, maxBuffer);
  });
  const storage = new WorktreeStorage({
    stateDir: services.stateDir,
    runGit,
    sessions: async () => (await services.sessions.list()).map(({ sessionId, path, cwd }) => ({ sessionId, path, cwd })),
    threadOpen: (sessionId) => services.thread(sessionId)?.sessionId === sessionId,
    hostCwd: () => services.cwd(),
    log: (label, detail) => services.log(label, detail),
    removed: options.removed,
  });
  const announce = (removed: readonly string[]) => {
    if (removed.length > 0) context.emit(STORAGE_CHANGED_EVENT, { removed });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = (delayMs: number) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void sweep(), delayMs);
    timer.unref?.();
  };
  const sweep = async () => {
    try {
      if (await storage.active()) announce((await storage.sweep()).removed);
    } catch (error) {
      services.log("git.worktree.cleanup-failed", error instanceof Error ? error.message : String(error));
    } finally {
      schedule(sweepInterval());
    }
  };
  schedule(Math.min(FIRST_SWEEP_MS, sweepInterval()));

  const unhook = services.registerThreadLifecycle({
    threadDeleted: async (sessionId, cwd) => {
      if (await storage.threadDeleted(sessionId, cwd)) schedule(AFTER_DELETE_MS);
    },
  });

  context.registerCommand("storage-report", (input) => storage.report({ sizes: fields(input).sizes !== false }), { long: true });
  context.registerCommand("cleanup-policy", (input) => input === undefined ? storage.getPolicy() : storage.setPolicy(input));
  context.registerCommand("cleanup-run", async (input) => {
    const paths = fields(input).paths;
    const result = await storage.sweep(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : undefined);
    announce(result.removed);
    return result;
  }, { long: true });
  context.registerCommand("storage-remove", async (input) => {
    const path = fields(input).path;
    if (typeof path !== "string" || !path) throw new HostCommandError('storage-remove needs "path".');
    const result = await storage.removeByHand(path, fields(input).confirm === true);
    if (result.removed) announce([path]);
    return result;
  }, { long: true });

  return {
    storage,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unhook();
    },
  };
}
