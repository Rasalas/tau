import { decodeSnoozePresets } from "./meta.js";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  HostCommandError,
  readPersistedJson,
  writePersistedJson,
  type HostExtension,
  type HostExtensionContext,
  type HostThreadStartOptions,
  type HostSessionSummary,
} from "tau/host-extension";
import { agentTools, DIRECTORY_INSTRUCTIONS, type DeferredChange } from "./agent-tools.js";
import type { DirectoryRequest } from "./directory.js";
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
  settlePatch,
  snoozePatch,
  sweepPatches,
  unsettlePatch,
  settlingRequests,
  type SweepRequest,
  type SweepThread,
} from "./meta.js";
import { followMachineState, machineThreadOwner, MACHINE_META_EVENT, MACHINE_STATE_TOPIC, MACHINE_TRASH_EVENT } from "./machine-state.js";
import {
  META_EVENT,
  ONBOARDING_EXTENSION_ID,
  REVIEW_EXTENSION_ID,
  THREAD_RAIL_EXTENSION_ID,
  TRASH_EVENT,
  type RailState,
  type ThreadMetaPatch,
} from "./protocol.js";

const STATE_VERSION = 1;
const DEFAULT_SWEEP_MS = 60_000;
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
    permissions: ["sessions", "machines", "runtime:extend"],
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const file = join(services.stateDir, "thread-meta.json");
      const cacheFile = join(services.stateDir, "machine-meta-cache.json");
      const [read, cached] = await Promise.all([readPersistedJson<StoredState>(file, {
        expectedVersion: STATE_VERSION,
        decode: (value) => ({ ...decodeState(value), ...(record(value).imported === true ? { imported: true } : {}) }),
      }), readPersistedJson<Record<string, RailState>>(cacheFile, {
        expectedVersion: 1,
        decode: (value) => Object.fromEntries(Object.entries(record(value)).map(([machine, meta]) => [machine, decodeState(meta)])),
      })]);
      let state: StoredState = read?.data ?? { ...EMPTY_STATE };
      const running = new Set<string>();
      const turnVersions = new Map<string, number>();
      let wakeTimer: ReturnType<typeof setTimeout> | undefined;
      let sweeping: Promise<void> | undefined;
      let saving: Promise<void> = Promise.resolve();
      let savingCache: Promise<void> = Promise.resolve();
      let cachedText: string | undefined = JSON.stringify(cached?.data ?? {});
      let recheckTimer: ReturnType<typeof setTimeout> | undefined;
      const rechecks = new Map<string, boolean>();
      let disposed = false;

      let sessions = new Map<string, HostSessionSummary>();
      let localTrashIds = new Set<string>();
      const parentOf = (id: string) => services.thread(id)?.parentThreadId ?? sessions.get(id)?.parentThreadId;
      const owner = (id: string) => !sessions.has(id) && localTrashIds.has(id) ? undefined : machineThreadOwner(id, sessions, services.machines?.list() ?? []);
      const callMachine = (machine: string, command: string, input: unknown) => {
        if (!services.machines) throw new HostCommandError("Machines are unavailable on this machine.");
        return services.machines.call(machine, THREAD_RAIL_EXTENSION_ID, command, input);
      };
      const readOwnership = async () => {
        const [listed, trash] = await Promise.all([services.sessions.list(), services.sessions.trash()]);
        sessions = new Map(listed.map((session) => [session.sessionId, session]));
        // Deleted local ids still have backend ownership in the host's trash.
        localTrashIds = new Set(trash.filter((entry) => entry.backendKind !== "machine").map((entry) => entry.sessionId));
      };
      await readOwnership();
      const publicationEpoch = randomUUID();
      let publicationRevision = 0;
      const homeState = (): RailState => ({ threads: Object.fromEntries(Object.entries(state.threads).filter(([id]) => !owner(id))), settings: state.settings, publication: { epoch: publicationEpoch, revision: publicationRevision } });
      // Do not await peer reads during activation: reciprocally paired hosts answer from their caches.
      let remote: ReturnType<typeof followMachineState>;
      remote = followMachineState(context, () => { if (remote) { publicationRevision++; context.emit(META_EVENT, publicState()); } }, owner, {
        states: cached?.data ?? {},
        save: (states) => {
          const text = JSON.stringify(states);
          if (text === cachedText) return;
          cachedText = text;
          savingCache = savingCache.then(() => writePersistedJson(cacheFile, 1, states))
            .catch((error: unknown) => {
              if (cachedText === text) cachedText = undefined;
              services.log("thread-rail.cache-save-failed", error instanceof Error ? error.message : String(error));
            });
        },
      });
      function publicState(): RailState { return { ...remote.merged(homeState()), publication: { epoch: publicationEpoch, revision: publicationRevision } }; }
      const persist = () => {
        saving = writePersistedJson(file, STATE_VERSION, { ...state })
          .catch((error: unknown) => services.log("thread-rail.save-failed", error instanceof Error ? error.message : String(error)));
      };
      const armWake = () => {
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeTimer = undefined;
        const next = nextWake(homeState(), clock());
        if (next === undefined) return;
        wakeTimer = setTimeout(() => change(sweepPatches([], homeState(), running, clock())), Math.min(MAX_TIMER_MS, Math.max(0, next - clock())));
        wakeTimer.unref?.();
      };
      const commit = (next: StoredState) => {
        if (next === state) return;
        const settled = Object.entries(next.threads).filter(([id, meta]) => !owner(id) && meta.settledAt && !state.threads[id]?.settledAt).map(([id]) => id);
        const restored = Object.entries(state.threads).filter(([id, meta]) => !owner(id) && meta.settledAt && !next.threads[id]?.settledAt).map(([id]) => id);
        if (settled.length || restored.length) void context.invokeHostExtension(REVIEW_EXTENSION_ID, "watch-shelf", { settled, restored }).catch(() => undefined);
        state = next;
        publicationRevision++;
        persist();
        context.emit(META_EVENT, publicState());
        context.emit(MACHINE_META_EVENT, homeState(), { topic: MACHINE_STATE_TOPIC });
        armWake();
      };
      const change = (patches: Record<string, ThreadMetaPatch | null>) => {
        const next = applyPatches(state, patches);
        if (next !== state) commit({ ...next, ...(state.imported ? { imported: true } : {}) });
      };

      const changeOwned = async (patches: Record<string, ThreadMetaPatch | null>) => {
        const local: Record<string, ThreadMetaPatch | null> = {};
        const byMachine = new Map<string, Record<string, ThreadMetaPatch | null>>();
        for (const [id, patch] of Object.entries(patches)) {
          const home = owner(id);
          if (!home) local[id] = patch;
          else {
            const group = byMachine.get(home.machine) ?? {};
            group[home.sessionId] = patch;
            byMachine.set(home.machine, group);
          }
        }
        change(local);
        await Promise.all([...byMachine].map(async ([machine, remotePatches]) => {
          const answer = await callMachine(machine, "patch", { patches: remotePatches });
          remote.confirmPatch(machine, remotePatches, answer);
          void remote.refresh(machine).catch((error: unknown) => services.log("thread-rail.machine-read-failed", error instanceof Error ? error.message : String(error)));
        }));
      };

      const sweep = (threadIds?: ReadonlySet<string>, fresh = false): Promise<void> => {
        sweeping ??= (async () => {
          try {
            await readOwnership();
            const localSessions = [...sessions.values()].filter((session) => !session.parentThreadId && !owner(session.sessionId));
            const local = homeState();
            const turnsAtRead = new Map(turnVersions);
            const allThreads: SweepThread[] = await Promise.all(localSessions.map(async (session) => {
              const at = await modifiedAt(session.path);
              return { id: session.sessionId, cwd: session.cwd, ...(at === undefined ? {} : { modifiedAt: at }) };
            }));
            const threads = threadIds ? allThreads.filter((thread) => threadIds.has(thread.id)) : allThreads;
            // Only stored thread links can settle work; discovery persists links before returning them.
            const linked = new Map<string, SweepRequest[]>();
            // Threads whose links could not be read; the quiet-spell rule leaves them be.
            const unread = new Set<string>();
            const asked = linkedRequestThreads(threads, local, running, clock());
            if (asked.length > 0) {
              try {
                const answer = record(await context.invokeHostExtension(REVIEW_EXTENSION_ID, "thread-requests", { threadIds: asked, ...(fresh ? { refresh: true } : {}) }));
                for (const [id, links] of Object.entries(answer)) {
                  const known = (Array.isArray(links) ? links : []).map(record).flatMap((link): SweepRequest[] => typeof link.url === "string"
                    ? [{
                      url: link.url,
                      ...(link.state === "open" || link.state === "closed" || link.state === "merged" ? { state: link.state } : {}),
                      ...(typeof link.baseRef === "string" && link.baseRef ? { baseRef: link.baseRef } : {}),
                      ...(typeof link.linkedAt === "number" ? { linkedAt: link.linkedAt } : {}),
                      ...(typeof link.endedAt === "number" ? { endedAt: link.endedAt } : {}),
                    }]
                    : []);
                  if (known.length > 0) linked.set(id, known);
                }
              } catch (error) {
                // No readable links means no evidence for PR-based settlement; without Review Kit there are none to wait for.
                const code = (error as { code?: string }).code;
                const absent = code === "unknown-extension" || code === "unknown-command" || (error instanceof Error && /^Host extension .+ is not active/u.test(error.message));
                if (!absent) for (const id of asked) unread.add(id);
              }
            }
            // A past PR is not proof that follow-up work in the checkout landed.
            // A checkout not known to be clean stays active; the idle rule is independent.
            const patches = sweepPatches(threads, local, running, clock(), linked, unread);
            const integration = new Map<string, Promise<boolean>>();
            const keepActive = (id: string) => {
              const until = local.threads[id]?.snoozedUntil;
              if (until !== undefined && until <= clock()) patches[id] = { snoozedUntil: null };
              else delete patches[id];
            };
            await Promise.all(Object.entries(patches).map(async ([id, patch]) => {
              if (patch.settledBy !== "pr-merged") return;
              const cwd = threads.find((thread) => thread.id === id)?.cwd;
              if (!cwd) { keepActive(id); return; }
              // The merged requests' bases, not the branch the worktree started from, say where the work landed.
              const targets = [...new Set(settlingRequests(linked.get(id) ?? []).flatMap((request) => request.state === "merged" && request.baseRef ? [request.baseRef] : []))].sort();
              const key = [cwd, ...targets].join("\n");
              let checked = integration.get(key);
              if (!checked) {
                checked = context.invokeHostExtension("tau.workspace", "thread-work-integrated", { workspace: cwd, ...(targets.length > 0 ? { targets } : {}) })
                  .then((answer) => record(answer).integrated === true, () => false);
                integration.set(key, checked);
              }
              if (!await checked) keepActive(id);
            }));
            // Provider and Git reads may outlive the snapshot: new work always wins.
            for (const [id, patch] of Object.entries(patches)) {
              if (patch.settledBy && (running.has(id) || turnVersions.get(id) !== turnsAtRead.get(id) || state.threads[id] !== local.threads[id])) {
                delete patches[id];
                continue;
              }
              if (patch.settledBy) services.log("thread-rail.settled", `${id.slice(0, 8)} · ${patch.settledBy}`);
            }
            if (!disposed) change(patches);
          } catch (error) {
            services.log("thread-rail.sweep-failed", error instanceof Error ? error.message : String(error));
          } finally {
            sweeping = undefined;
          }
        })();
        return sweeping;
      };

      // Coalesce notifications, then recheck after any read already in flight.
      // Do not hold the turn-ending callback up on provider or Git subprocesses.
      const queueRecheck = (id: string, fresh = false) => {
        if (disposed) return;
        rechecks.set(id, fresh || rechecks.get(id) === true);
        if (recheckTimer) return;
        recheckTimer = setTimeout(() => {
          void (async () => {
            try {
              for (;;) {
                const active = sweeping;
                if (!active) break;
                await active;
              }
              if (disposed) return;
              const pending = new Map(rechecks);
              rechecks.clear();
              if (pending.size > 0) await sweep(new Set(pending.keys()), [...pending.values()].some(Boolean));
            } finally {
              recheckTimer = undefined;
              const next = rechecks.entries().next().value;
              if (next) queueRecheck(next[0], next[1]);
            }
          })();
        }, 0);
        recheckTimer.unref?.();
      };
      context.registerCommand("requests-changed", (input) => {
        const id = record(input).threadId;
        if (typeof id === "string" && id) queueRecheck(id);
      }, { callers: [REVIEW_EXTENSION_ID] });

      context.registerCommand("state", (input) => record(input).homeOnly === true ? homeState() : publicState(), { access: "read" });
      // Workspace asks only about its local sessions, never a peer machine's cache.
      context.registerCommand("thread-settlements", async (input) => {
        await readOwnership();
        const update = await services.sessions.refreshIndex({ requireComplete: true });
        if (update.type !== "thread-index") throw new HostCommandError("The thread index is unavailable.");
        const { index } = update;
        const local = new Set([...sessions.keys(), ...index.sessions.filter((thread) => thread.backendKind !== "machine").map((thread) => thread.id)]);
        const settled: Record<string, number> = {};
        for (const id of idList(record(input).threadIds)) {
          const at = state.threads[id]?.settledAt;
          if (local.has(id) && !localTrashIds.has(id) && !owner(id) && at !== undefined) settled[id] = at;
        }
        return settled;
      }, { access: "read", callers: ["tau.workspace"] });
      context.registerCommand("patch", async (input) => {
        await readOwnership();
        const patches: Record<string, ThreadMetaPatch | null> = {};
        for (const [id, patch] of Object.entries(record(record(input).patches))) {
          if (!id) continue;
          patches[id] = patch === null ? null : record(patch) as ThreadMetaPatch;
        }
        await changeOwned(patches);
        return publicState();
      });
      context.registerCommand("settings", (input) => {
        const fields = record(input);
        if ("snoozePresets" in fields && fields.snoozePresets !== null && !decodeSnoozePresets(fields.snoozePresets)) {
          throw new Error("Use 1 to 8 snooze options, with durations up to 30 days and valid times.");
        }
        const inactiveDays = fields.inactiveDays === null ? undefined : fields.inactiveDays ?? state.settings.inactiveDays;
        const settings = decodeSettings({ ...state.settings, inactiveDays, ...("snoozePresets" in fields ? { snoozePresets: fields.snoozePresets } : {}), ...("workingSection" in fields ? { workingSection: fields.workingSection } : {}), ...("onMerged" in fields ? { onMerged: fields.onMerged } : {}), ...("onClosed" in fields ? { onClosed: fields.onClosed } : {}) });
        commit({ ...state, settings });
        return publicState();
      });
      // Core kept pins and the settled shelf in each client's preferences; the first client hands them over once.
      context.registerCommand("import", async (input) => {
        if (state.imported) return publicState();
        await readOwnership();
        const fields = record(input);
        const now = clock();
        let next = publicState();
        const patches: Record<string, ThreadMetaPatch> = {};
        for (const id of idList(fields.pinned)) {
          const patch = pinPatch(next, id, true, now);
          patches[id] = { ...patches[id], ...patch };
          next = applyPatches(next, { [id]: patch });
        }
        for (const id of idList(fields.settled)) patches[id] = { ...patches[id], ...settlePatch(now, "user") };
        await changeOwned(patches);
        commit({ ...state, imported: true });
        return publicState();
      });
      // Imported threads have no state of their own: they start on the shelf, found by search, not to be clicked away.
      context.registerCommand("settle-imported", async (input) => {
        await readOwnership();
        const now = clock();
        const patches: Record<string, ThreadMetaPatch> = {};
        for (const id of idList(record(input).threadIds)) {
          if (!owner(id) && !state.threads[id]) patches[id] = settlePatch(now, "import");
        }
        change(patches);
        return { settled: Object.keys(patches).length };
      }, { callers: [ONBOARDING_EXTENSION_ID] });
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
      context.registerCommand("archive", async (input) => {
        const id = threadId(input);
        await readOwnership();
        const home = owner(id);
        if (home) {
          await callMachine(home.machine, "archive", { threadId: home.sessionId });
          await remote.refresh(home.machine);
          return publicState();
        }
        if (running.has(id)) throw new HostCommandError("Cannot archive a running thread.");
        // Revoke thread-owned capabilities before announcing the archive. A
        // failed cleanup must not report a successfully archived thread.
        for (const provider of context.offering("tau.thread-rail/archive")) {
          await context.invokeHostExtension(provider.id, "thread-archived", { threadId: id });
        }
        change({ [id]: archivePatch(clock()) });
        return publicState();
      }, { callers: ["tau.handoff"] });
      // The thread's meta stays until the trash purges it, so a restored thread comes back where it was.
      const homeTrash = async () => {
        const local = (await services.sessions.trash()).filter((entry) => entry.backendKind !== "machine");
        localTrashIds = new Set(local.map((entry) => entry.sessionId));
        return local;
      };
      const publishTrash = async () => {
        const local = await homeTrash();
        context.emit(TRASH_EVENT, remote.mergedTrash(local));
        context.emit(MACHINE_TRASH_EVENT, local, { topic: MACHINE_STATE_TOPIC });
      };
      for (const command of ["remove", "restore", "purge"] as const) context.registerCommand(command, async (input) => {
        const id = threadId(input);
        await readOwnership();
        const home = owner(id);
        if (home) {
          await callMachine(home.machine, command, { threadId: home.sessionId });
          await remote.refresh(home.machine);
        } else {
          await services.sessions[command](id);
          await publishTrash();
        }
      }, { long: true });
      context.registerCommand("trash", async (input) => {
        const local = await homeTrash();
        return record(input).homeOnly === true ? local : remote.mergedTrash(local);
      }, { access: "read" });
      context.registerCommand("start", async (input) => {
        const fields = record(input);
        const cwd = typeof fields.cwd === "string" ? fields.cwd : "";
        const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : "";
        if (!prompt) throw new HostCommandError("There is no prompt to start a thread with.");
        if (!isAbsolute(cwd) || !(await stat(cwd).then((entry) => entry.isDirectory(), () => false))) {
          throw new HostCommandError(`${cwd || "The project"} is not a folder on this machine.`);
        }
        const model = record(fields.model);
        const provider = typeof model.provider === "string" ? model.provider : "";
        const modelId = typeof model.id === "string" ? model.id : "";
        const started = await services.sessions.start({ cwd, prompt,
          ...(typeof fields.backend === "string" ? { backend: fields.backend } : {}),
          ...(fields.attachments !== undefined ? { attachments: fields.attachments as HostThreadStartOptions["attachments"] } : {}),
          ...(fields.skillDraft !== undefined ? { skillDraft: fields.skillDraft as HostThreadStartOptions["skillDraft"] } : {}),
          ...(typeof fields.thinkingLevel === "string" ? { thinkingLevel: fields.thinkingLevel } : {}),
          ...(typeof fields.mode === "string" ? { mode: fields.mode } : {}), ...(provider && modelId ? { model: { provider, id: modelId } } : {}) });
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

      // A settle or snooze an agent asked for while its thread runs; it lands when the run ends well.
      const deferred = new Map<string, DeferredChange>();
      const toolPorts = {
        now: clock,
        state: homeState,
        threads: async () => {
          const update = await services.sessions.refreshIndex();
          return update.type === "thread-index" ? update.index.sessions : [];
        },
        isRunning: (id: string) => running.has(id),
        requests: async (input: { threadIds?: readonly string[]; query?: string }): Promise<Record<string, DirectoryRequest[]>> => {
          try {
            return record(await context.invokeHostExtension(REVIEW_EXTENSION_ID, "thread-request-links", input)) as Record<string, DirectoryRequest[]>;
          } catch {
            // Without Review Kit a thread links no request.
            return {};
          }
        },
        apply: async (id: string, patch: ThreadMetaPatch) => { await readOwnership(); await changeOwned({ [id]: patch }); },
        defer: (id: string, request: DeferredChange) => { deferred.set(id, request); },
        forgetDeferred: (id: string) => { deferred.delete(id); },
      };
      // A sub-agent's question is the user's to answer: its ancestors leave the shelf and any snooze.
      const wakeAncestors = (sessionId: string) => {
        const now = clock();
        const above = new Set([sessionId]);
        const patches: Record<string, ThreadMetaPatch> = {};
        for (let id = parentOf(sessionId); id && !above.has(id); id = parentOf(id)) {
          above.add(id);
          const meta = state.threads[id];
          if (owner(id) || meta?.archivedAt !== undefined) continue;
          const patch = { ...(meta?.settledAt !== undefined ? unsettlePatch(now) : {}), ...(isSnoozed(meta, now) ? WAKE_PATCH : {}) };
          if (Object.keys(patch).length > 0) patches[id] = patch;
        }
        change(patches);
      };
      const endRun = (sessionId: string, outcome: "completed" | "failed") => {
        const asked = deferred.get(sessionId);
        deferred.delete(sessionId);
        if (!asked || outcome !== "completed" || owner(sessionId)) return;
        services.log("thread-rail.agent-organized", `${sessionId.slice(0, 8)} · ${asked.action}`);
        change({ [sessionId]: asked.action === "settle" ? settlePatch(clock(), "agent") : snoozePatch(asked.until) });
      };

      const disposers = [
        services.mcp.registerTools((thread) => agentTools(toolPorts, thread)),
        services.mcp.registerInstructions?.(() => DIRECTORY_INSTRUCTIONS) ?? (() => undefined),
        services.registerRuntimeExtension("tau-thread-directory", (pi, thread) => {
          for (const tool of agentTools(toolPorts, thread)) pi.registerTool(tool);
          pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${DIRECTORY_INSTRUCTIONS}` }));
        }),
        services.registerTurnObserver({
          accepted: (sessionId, _turnId, queued) => {
            if (owner(sessionId)) return;
            // A message queued behind the run is more work than the agent settled for.
            if (queued.deferBefore) deferred.delete(sessionId);
            running.add(sessionId);
            turnVersions.set(sessionId, (turnVersions.get(sessionId) ?? 0) + 1);
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
          cancelled: async (sessionId) => { running.delete(sessionId); deferred.delete(sessionId); queueRecheck(sessionId, true); },
          ended: async (sessionId) => {
            if (owner(sessionId)) return;
            running.delete(sessionId);
            change({ [sessionId]: { activityAt: clock() } });
            queueRecheck(sessionId, true);
          },
          // The run is over, however it ended: `runEnded` already took what the agent asked for.
          runEnded: endRun,
          stopped: (sessionId) => { deferred.delete(sessionId); },
          reset: async (sessionId) => { running.delete(sessionId); deferred.delete(sessionId); queueRecheck(sessionId, true); },
          closed: async (sessionId) => { running.delete(sessionId); deferred.delete(sessionId); queueRecheck(sessionId, true); },
        }),
        services.decorateUiPrompt((prompt) => { wakeAncestors(prompt.sessionId); }),
        services.registerThreadLifecycle({
          sweep: async (snapshot) => {
            sessions = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
            await homeTrash();
            armWake();
          },
          threadDeleted: async (sessionId) => {
            if (owner(sessionId)) return;
            turnVersions.delete(sessionId);
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
        disposed = true;
        if (recheckTimer) clearTimeout(recheckTimer);
        rechecks.clear();
        clearTimeout(first);
        clearInterval(interval);
        if (wakeTimer) clearTimeout(wakeTimer);
        remote.dispose();
        for (const dispose of disposers) dispose();
        await sweeping;
        await saving;
        await savingCache;
      };
    },
  };
}

export default createThreadRailHostExtension;
