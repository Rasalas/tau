import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  HostCommandError,
  readPersistedJson,
  writePersistedJson,
  type HostExtension,
  type HostExtensionContext,
} from "tau/host-extension";
import {
  EMPTY_STATE,
  UNARCHIVE_PATCH,
  WAKE_PATCH,
  applyPatches,
  archivePatch,
  decodeSettings,
  decodeState,
  isSnoozed,
  linkedRequestThreads,
  nextWake,
  pinPatch,
  requestCheckouts,
  settlePatch,
  sweepPatches,
  unsettlePatch,
  type SweepRequest,
  type SweepThread,
} from "./meta.js";
import {
  META_EVENT,
  REVIEW_EXTENSION_ID,
  THREAD_RAIL_EXTENSION_ID,
  TRASH_EVENT,
  type RailState,
  type ThreadMetaPatch,
} from "./protocol.js";

const STATE_VERSION = 1;
const DEFAULT_SWEEP_MS = 5 * 60_000;
/** The first sweep waits for the index and Review Kit, but not a whole period. */
const FIRST_SWEEP_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ThreadRailHostOptions {
  now?: () => number;
  /** How often the rules run; `TAU_THREAD_RAIL_SWEEP_MS` overrides the default for a test instance. */
  sweepMs?: number;
  /** When a session file last changed; the file's mtime by default. */
  modifiedAt?: (path: string) => Promise<number | undefined>;
}

/** What the file holds beside the state: whether core's old pin and settle lists were taken over. */
interface StoredState extends RailState {
  imported?: boolean;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const idList = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];

async function fileModifiedAt(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mtimeMs; } catch { return undefined; }
}

function sweepInterval(options: ThreadRailHostOptions): number {
  const fromEnv = Number(process.env.TAU_THREAD_RAIL_SWEEP_MS);
  return options.sweepMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SWEEP_MS);
}

/**
 * Thread Rail's host half: the meta it keeps per thread (pin, order, snooze,
 * settle, siblings) in `<stateDir>/thread-meta.json`, pushed to every client
 * on each change, and the sweep that wakes snoozes and applies the auto-settle
 * rules while no window is open.
 */
export function createThreadRailHostExtension(options: ThreadRailHostOptions = {}): HostExtension {
  const clock = options.now ?? Date.now;
  const modifiedAt = options.modifiedAt ?? fileModifiedAt;
  return {
    id: THREAD_RAIL_EXTENSION_ID,
    name: "Thread Rail",
    permissions: ["sessions"],
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const file = join(services.stateDir, "thread-meta.json");
      const read = await readPersistedJson<StoredState>(file, {
        expectedVersion: STATE_VERSION,
        decode: (value) => ({ ...decodeState(value), ...(record(value).imported === true ? { imported: true } : {}) }),
      });
      let state: StoredState = read?.data ?? { ...EMPTY_STATE };
      const running = new Set<string>();
      let wakeTimer: ReturnType<typeof setTimeout> | undefined;
      let sweeping: Promise<void> | undefined;
      let saving: Promise<void> = Promise.resolve();

      const publicState = (): RailState => ({ threads: state.threads, settings: state.settings });
      const persist = () => {
        saving = writePersistedJson(file, STATE_VERSION, { ...state })
          .catch((error: unknown) => services.log("thread-rail.save-failed", error instanceof Error ? error.message : String(error)));
      };
      const armWake = () => {
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeTimer = undefined;
        const next = nextWake(state, clock());
        if (next === undefined) return;
        wakeTimer = setTimeout(() => change(sweepPatches([], state, running, new Map(), clock())), Math.min(MAX_TIMER_MS, Math.max(0, next - clock())));
        wakeTimer.unref?.();
      };
      const commit = (next: StoredState) => {
        if (next === state) return;
        state = next;
        persist();
        context.emit(META_EVENT, publicState());
        armWake();
      };
      const change = (patches: Record<string, ThreadMetaPatch | null>) => {
        const next = applyPatches(state, patches);
        if (next !== state) commit({ ...next, ...(state.imported ? { imported: true } : {}) });
      };

      const sweep = (): Promise<void> => {
        sweeping ??= (async () => {
          try {
            const sessions = (await services.sessions.list()).filter((session) => !session.parentThreadId);
            const threads: SweepThread[] = await Promise.all(sessions.map(async (session) => {
              const at = await modifiedAt(session.path);
              return { id: session.sessionId, cwd: session.cwd, ...(at === undefined ? {} : { modifiedAt: at }) };
            }));
            const requests = new Map<string, SweepRequest>();
            for (const cwd of requestCheckouts(threads, state, running, clock())) {
              try {
                // Sequential on purpose: each answer may run `gh` or `glab`.
                // oxlint-disable-next-line no-await-in-loop
                const answer = record(await context.invokeHostExtension(REVIEW_EXTENSION_ID, "pr-status", { workspace: cwd }));
                const request = record(answer.request);
                if (typeof request.url === "string") requests.set(cwd, { url: request.url, ...(typeof request.state === "string" ? { state: request.state as SweepRequest["state"] } : {}) });
              } catch {
                // No Review Kit, no CLI, no remote: that checkout has no request to go by.
              }
            }
            // Every thread's linked requests too; one still open keeps its thread active.
            const linked = new Map<string, SweepRequest[]>();
            const asked = linkedRequestThreads(threads, state, running, clock());
            if (asked.length > 0) {
              try {
                const answer = record(await context.invokeHostExtension(REVIEW_EXTENSION_ID, "thread-requests", { threadIds: asked }));
                for (const [id, links] of Object.entries(answer)) {
                  const known = (Array.isArray(links) ? links : []).map(record).flatMap((link): SweepRequest[] => typeof link.url === "string"
                    ? [{ url: link.url, ...(link.state === "open" || link.state === "closed" || link.state === "merged" ? { state: link.state } : {}) }]
                    : []);
                  if (known.length > 0) linked.set(id, known);
                }
              } catch {
                // An older Review Kit, or none: the branch's request is all there is to go by.
              }
            }
            const patches = sweepPatches(threads, state, running, requests, clock(), linked);
            for (const [id, patch] of Object.entries(patches)) {
              if (patch.settledBy) services.log("thread-rail.settled", `${id.slice(0, 8)} · ${patch.settledBy}`);
            }
            change(patches);
          } catch (error) {
            services.log("thread-rail.sweep-failed", error instanceof Error ? error.message : String(error));
          } finally {
            sweeping = undefined;
          }
        })();
        return sweeping;
      };

      context.registerCommand("state", () => publicState(), { access: "read" });
      context.registerCommand("patch", (input) => {
        const patches: Record<string, ThreadMetaPatch | null> = {};
        for (const [id, patch] of Object.entries(record(record(input).patches))) {
          if (!id) continue;
          patches[id] = patch === null ? null : record(patch) as ThreadMetaPatch;
        }
        change(patches);
        return publicState();
      });
      context.registerCommand("settings", (input) => {
        const fields = record(input);
        const inactiveDays = fields.inactiveDays === null ? undefined : fields.inactiveDays ?? state.settings.inactiveDays;
        const settings = decodeSettings({ ...state.settings, inactiveDays, ...("onMerged" in fields ? { onMerged: fields.onMerged } : {}), ...("onClosed" in fields ? { onClosed: fields.onClosed } : {}) });
        commit({ ...state, settings });
        return publicState();
      });
      // Core kept pins and the settled shelf in each client's preferences; the first client hands them over once.
      context.registerCommand("import", (input) => {
        if (state.imported) return publicState();
        const fields = record(input);
        const now = clock();
        let next: StoredState = state;
        for (const id of idList(fields.pinned)) next = applyPatches(next, { [id]: pinPatch(next, id, true, now) });
        for (const id of idList(fields.settled)) next = applyPatches(next, { [id]: settlePatch(now, "user") });
        commit({ ...next, imported: true });
        return publicState();
      });
      context.registerCommand("sweep", async () => {
        await sweep();
        return publicState();
      });
      const threadId = (input: unknown): string => {
        const id = record(input).threadId;
        if (typeof id !== "string" || !id) throw new HostCommandError("Name the thread with \"threadId\".");
        return id;
      };
      // Archive rejects a thread with a turn in flight.
      context.registerCommand("archive", (input) => {
        const id = threadId(input);
        if (running.has(id)) throw new HostCommandError("Cannot archive a running thread.");
        change({ [id]: archivePatch(clock()) });
        return publicState();
      });
      // The thread's meta stays until the trash purges it, so a restored thread comes back where it was.
      const publishTrash = async () => { context.emit(TRASH_EVENT, await services.sessions.trash()); };
      context.registerCommand("remove", async (input) => {
        await services.sessions.remove(threadId(input));
        await publishTrash();
      }, { long: true });
      context.registerCommand("restore", async (input) => {
        await services.sessions.restore(threadId(input));
        await publishTrash();
      }, { long: true });
      context.registerCommand("purge", async (input) => {
        await services.sessions.purge(threadId(input));
        await publishTrash();
      }, { long: true });
      context.registerCommand("trash", () => services.sessions.trash(), { access: "read" });
      context.registerCommand("start", async (input) => {
        const fields = record(input);
        const cwd = typeof fields.cwd === "string" ? fields.cwd : "";
        const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : "";
        if (!prompt) throw new HostCommandError("There is no prompt to start a thread with.");
        if (!isAbsolute(cwd) || !(await stat(cwd).then((entry) => entry.isDirectory(), () => false))) {
          throw new HostCommandError(`${cwd || "The project"} is not a folder on this host.`);
        }
        const model = record(fields.model);
        const provider = typeof model.provider === "string" ? model.provider : "";
        const modelId = typeof model.id === "string" ? model.id : "";
        const started = await services.sessions.start({ cwd, prompt, ...(provider && modelId ? { model: { provider, id: modelId } } : {}) });
        const group = typeof fields.siblingGroupId === "string" && fields.siblingGroupId ? fields.siblingGroupId : undefined;
        change({
          [started.sessionId]: {
            activityAt: clock(),
            ...(group ? { siblingGroupId: group } : {}),
            ...(group && provider && modelId ? { model: `${provider}/${modelId}` } : {}),
          },
        });
        services.log("thread-rail.started", `${started.sessionId.slice(0, 8)}${group ? ` · group ${group.slice(0, 8)}` : ""}`);
        return started;
      }, { long: true });

      const disposers = [
        services.registerTurnObserver({
          accepted: (sessionId) => {
            running.add(sessionId);
            const meta = state.threads[sessionId];
            const now = clock();
            // New work takes a thread off the shelf, out of a snooze and out of the archive.
            change({
              [sessionId]: {
                activityAt: now,
                ...(meta?.settledAt !== undefined ? unsettlePatch(now) : {}),
                ...(isSnoozed(meta, now) ? WAKE_PATCH : {}),
                ...(meta?.archivedAt !== undefined ? UNARCHIVE_PATCH : {}),
              },
            });
          },
          cancelled: async (sessionId) => { running.delete(sessionId); },
          ended: async (sessionId) => {
            running.delete(sessionId);
            change({ [sessionId]: { activityAt: clock() } });
          },
          reset: async (sessionId) => { running.delete(sessionId); },
          closed: async (sessionId) => { running.delete(sessionId); },
        }),
        services.registerThreadLifecycle({
          threadDeleted: async (sessionId) => {
            change({ [sessionId]: null });
            // A purge by the host's own timer: the Archived page's list moved too.
            await publishTrash().catch(() => undefined);
          },
        }),
      ];

      armWake();
      const every = sweepInterval(options);
      const first = setTimeout(() => void sweep(), Math.min(every, FIRST_SWEEP_MS));
      const interval = setInterval(() => void sweep(), every);
      first.unref?.();
      interval.unref?.();

      return async () => {
        clearTimeout(first);
        clearInterval(interval);
        if (wakeTimer) clearTimeout(wakeTimer);
        for (const dispose of disposers) dispose();
        await sweeping;
        await saving;
      };
    },
  };
}

export default createThreadRailHostExtension;
