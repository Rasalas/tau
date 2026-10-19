import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { GitRunner } from "./git-command.js";
import { SESSION_DATABASE_COMMAND, SESSION_DATABASE_RECLAIM_COMMAND, type SessionDatabaseStatus } from "../_shared/session-database-protocol.js";
import { SESSION_DATABASE_SOURCES, STORAGE_CHANGED_EVENT, type UiSessionDatabase } from "./storage-protocol.js";
import { WorktreeStorage, storageGit, type WorktreeStorageOptions, type WorktreeStorageThread } from "./worktree-storage.js";
import { rulesFor } from "./worktree-cleanup.js";

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
  options: { removed(repository: string): void; runGit?: GitRunner; request?: WorktreeStorageOptions["request"] },
): { storage: WorktreeStorage; dispose(): void } {
  const { services } = context;
  const runGit: GitRunner = options.runGit ?? (async (cwd, args, maxBuffer) => {
    services.noteSubprocess();
    return storageGit(cwd, args, maxBuffer);
  });
  const storage: WorktreeStorage = new WorktreeStorage({
    stateDir: services.stateDir,
    runGit,
    sessions: async () => {
      const [live, trashed] = await Promise.all([services.sessions.list(), services.sessions.trash?.() ?? []]);
      const policy = await storage.getPolicy();
      const readSettled = [policy.host, ...Object.keys(policy.projects).map((project) => rulesFor(policy, project))]
        .some((rules) => rules.afterSettledDays != null);
      const threads = new Map<string, WorktreeStorageThread>(live.map(({ sessionId, path, cwd }) => [sessionId, { sessionId, path, cwd }]));
      if (readSettled) {
        // Header reads cover Pi only. The index also knows every backend's
        // persisted threads, including an active one sharing this checkout.
        const update = await services.sessions.refreshIndex({ requireComplete: true });
        if (update.type !== "thread-index") throw new HostCommandError("The thread index is unavailable; worktrees are kept.");
        const { index } = update;
        for (const thread of index.sessions) {
          if (thread.backendKind === "machine" || !thread.projectPath) continue;
          const held = threads.get(thread.id);
          threads.set(thread.id, { sessionId: thread.id, path: held?.path ?? thread.path, cwd: held?.cwd ?? thread.projectPath, modifiedAt: thread.modifiedAt });
        }
      }
      const settled = readSettled && threads.size > 0
        ? fields(await context.invokeHostExtension("tau.thread-rail", "thread-settlements", { threadIds: [...threads.keys()] }).catch(() => undefined)) : {};
      // A thread in the host's trash may come back; its worktree waits for the purge.
      return [...[...threads.values()].map((thread) => {
        const at = settled[thread.sessionId];
        return { ...thread, ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { settledAt: at } : {}) };
      }), ...trashed.map(({ sessionId, cwd }) => ({ sessionId, path: "", cwd }))];
    },
    threadOpen: (sessionId) => services.thread(sessionId)?.sessionId === sessionId,
    hostCwd: () => services.cwd(),
    log: (label, detail) => services.log(label, detail),
    removed: options.removed,
    ...(options.request ? { request: options.request } : {}),
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

  // A runtime kit that is off, or has no database yet, simply does not show.
  const databases = async (command: string): Promise<{ databases: UiSessionDatabase[] }> => ({
    databases: (await Promise.all(SESSION_DATABASE_SOURCES.map(async ({ extensionId, backend, label }) => {
      const status = await context.invokeHostExtension(extensionId, command).catch(() => undefined) as SessionDatabaseStatus | undefined;
      return status && status.sizeBytes > 0 ? [{ ...status, backend, label }] : [];
    }))).flat(),
  });
  context.registerCommand("database-report", () => databases(SESSION_DATABASE_COMMAND), { access: "read" });
  context.registerCommand("database-reclaim", () => databases(SESSION_DATABASE_RECLAIM_COMMAND), { long: true });
  context.registerCommand("storage-report", (input) => storage.report({ sizes: fields(input).sizes !== false }), { access: "read", long: true });
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
