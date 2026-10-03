import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HostCommandError, tryProcessLock, writePersistedJson, type HostExtension } from "tau/host-extension";
import { SCHEDULING_ID, type Job, type JobConfig, type SchedulingState } from "./protocol.js";
import { decodeConfig, object, text } from "./validation.js";
import { assertStateBudget, readState } from "./store.js";

function nextAt(config: JobConfig, now: number): string {
  if (config.schedule.kind === "once") return config.schedule.at;
  const date = new Date(now);
  const [hours, minutes] = config.schedule.time.split(":").map(Number);
  date.setUTCHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function createSchedulingHostExtension(): HostExtension {
  return {
    id: SCHEDULING_ID, name: "Scheduling", permissions: ["sessions", "workspace:read"], isolation: "in-process",
    async activate(context) {
      const { services } = context;
      const file = join(services.stateDir, "jobs.json");
      const lock = await tryProcessLock(join(services.stateDir, "scheduler.lock"), { pid: process.pid, startedAt: new Date().toISOString(), app: "Tau Scheduling" });
      if (!lock) throw new HostCommandError("Another scheduler owns this host state.");
      try {
        const restored = await readState(file);
        let state: SchedulingState = structuredClone(restored);
        for (const job of state.jobs) {
          if (["starting", "running"].includes(job.status)) {
            job.status = "uncertain";
            if (job.lastRun) job.lastRun.outcome = "uncertain";
          } else if (job.nextAt && Date.parse(job.nextAt) <= Date.now() && ["ready", "completed"].includes(job.status)) job.status = "held";
        }
        if (JSON.stringify(state) !== JSON.stringify(restored)) await writePersistedJson(file, 1, { ...state });
        let stopped = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const snapshot = () => structuredClone(state);
        const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
        const arm = () => {
          clearTimers();
          if (stopped || !state.enabled) return;
          for (const job of state.jobs) {
            if (!job.enabled || !job.nextAt || !["ready", "completed"].includes(job.status)) continue;
            const delay = Math.max(0, Date.parse(job.nextAt) - Date.now());
            const timer = setTimeout(() => {
              timers.delete(timer);
              if (delay > 2_147_483_647) { arm(); return; }
              void run(job.id, true).catch((error: unknown) => services.log("scheduling.run", String(error)));
            }, Math.min(delay, 2_147_483_647));
            timers.add(timer);
          }
        };
        let pendingWrite: Promise<void> | undefined;
        const save = async (next: SchedulingState) => {
          if (stopped) throw new HostCommandError("Scheduling stopped.");
          assertStateBudget(next);
          const write = writePersistedJson(file, 1, { ...next }, { logger: { warn: (message) => services.log("scheduling.storage", message) } });
          pendingWrite = write;
          try { await write; }
          catch (error) {
            stopped = true; clearTimers(); context.fail("Scheduling could not persist state. No automatic retry will run.");
            throw new HostCommandError(String(error).slice(0, 500));
          } finally { if (pendingWrite === write) pendingWrite = undefined; }
          state = next; if (!stopped) context.emit("state", snapshot()); arm();
        };
        context.registerCommand("list", snapshot, { access: "read" });
        let busy = false;
        const outcomes = new Map<string, "completed" | "failed">();
        const flushOutcomes = async () => {
          const next = snapshot();
          let changed = false;
          for (const job of next.jobs) {
            const outcome = job.lastRun?.threadId ? outcomes.get(job.lastRun.threadId) : undefined;
            if (job.status === "running" && outcome) {
              job.status = outcome; job.lastRun!.outcome = outcome; changed = true;
              if (job.nextAt && Date.parse(job.nextAt) <= Date.now()) job.status = "held";
            }
          }
          outcomes.clear();
          if (changed && !stopped) await save(next);
        };
        const mutate = async <T>(work: () => Promise<T>): Promise<T> => {
          if (busy) throw new HostCommandError("Scheduling is busy. Try again after this operation finishes.");
          busy = true;
          try { return await work(); }
          finally { try { await flushOutcomes(); } finally { busy = false; arm(); } }
        };
        const lookup = (input: unknown, keys = ["id"]): Job => {
          const v = object(input, keys);
          const id = text(v.id, "Job ID", 36);
          const job = state.jobs.find((j) => j.id === id);
          if (!job) throw new HostCommandError("Unknown job.");
          return job;
        };
        const validate = async (input: unknown) => {
          const config = decodeConfig(input);
          config.workspace = await services.knownWorkspacePath(config.workspace);
          return config;
        };
        context.registerCommand("create", (input) => mutate(async () => {
          if (state.jobs.length >= 100) throw new HostCommandError("At most 100 scheduling jobs are allowed.");
          const config = await validate(input);
          const job: Job = { id: randomUUID(), config, workspaceId: services.workspaceRef(config.workspace).workspaceId, enabled: false, status: "ready", nextAt: nextAt(config, Date.now()) };
          await save({ ...state, jobs: [...state.jobs, job] });
          return structuredClone(job);
        }), { access: "owner" });
        for (const command of ["enable", "disable", "delete", "update"] as const) {
          context.registerCommand(command, (input) => mutate(async () => {
            const job = lookup(input, command === "update" ? ["id", "config"] : ["id"]);
            const copy = structuredClone(job);
            if (["starting", "running"].includes(job.status) && command !== "disable") throw new HostCommandError("This job is already running.");
            if (["held", "uncertain", "failed"].includes(job.status) && ["enable", "update"].includes(command)) throw new HostCommandError("Resolve this job explicitly first.");
            if (command === "update") {
              copy.config = await validate((input as { config: unknown }).config);
              copy.workspaceId = services.workspaceRef(copy.config.workspace).workspaceId;
              copy.status = "ready"; copy.detail = undefined;
              copy.enabled = false;
              copy.nextAt = nextAt(copy.config, Date.now());
            } else copy.enabled = command === "enable";
            if (command === "enable" && copy.nextAt && Date.parse(copy.nextAt) <= Date.now()) copy.status = "held";
            await save({ ...state, jobs: command === "delete" ? state.jobs.filter((j) => j.id !== job.id) : state.jobs.map((j) => j.id === job.id ? copy : j) });
            return structuredClone(copy);
          }), { access: "owner" });
        }
        const replace = async (job: Job) => save({ ...state, jobs: state.jobs.map((j) => j.id === job.id ? job : j) });
        const run = (id: string, scheduled = false) => mutate(async () => {
          const job = structuredClone(lookup({ id }));
          if (["starting", "running"].includes(job.status)) throw new HostCommandError("This job is already running.");
          if (["held", "uncertain", "failed"].includes(job.status)) throw new HostCommandError("Resolve this job explicitly first.");
          if (!state.enabled) throw new HostCommandError("Scheduling is off. Explicitly enable it first.");
          if (scheduled && (!job.enabled || stopped)) return job;
          if (scheduled && job.nextAt && Date.now() < Date.parse(job.nextAt)) return job;
          if (job.lastRun?.threadId) {
            const previous = services.thread(job.lastRun.threadId);
            if (previous && !previous.isIdle()) {
              job.status = "held"; job.detail = "The previous thread is still running or waiting.";
              await replace(job); throw new HostCommandError(job.detail);
            }
          }
          if (scheduled && job.nextAt && Date.now() - Date.parse(job.nextAt) > 60_000) {
            job.status = "held"; await replace(job); return job;
          }
          try {
            const path = await services.knownWorkspacePath(job.workspaceId);
            if (path !== job.config.workspace) throw new HostCommandError("The job's local workspace changed. Recreate the job explicitly.");
          } catch (error) {
            job.status = "held"; job.detail = String(error).slice(0, 500);
            await replace(job);
            throw new HostCommandError(job.detail);
          }
          job.status = "starting"; job.detail = undefined;
          job.lastRun = { intentId: randomUUID(), at: new Date().toISOString(), outcome: "starting" };
          job.nextAt = job.config.schedule.kind === "daily" ? nextAt(job.config, Date.now()) : undefined;
          if (job.config.schedule.kind === "once") job.enabled = false;
          // Await the atomic intent write before the host can create a thread.
          await replace(job);
          if (stopped) throw new HostCommandError("Scheduling stopped before admission.");
          try {
            const thread = await services.sessions.start({ cwd: job.config.workspace, backend: job.config.backend, title: `Scheduled: ${job.config.name}`, prompt: job.config.prompt });
            job.status = "running"; job.lastRun.threadId = thread.sessionId; job.lastRun.outcome = "running";
          } catch (error) {
            job.status = "failed"; job.lastRun.outcome = "failed"; job.lastRun.detail = String(error).slice(0, 500);
          }
          if (!stopped) await replace(job);
          return structuredClone(job);
        });
        context.registerCommand("run", (input) => run(lookup(input).id), { access: "owner" });
        context.registerCommand("resolve", async (input) => {
          const v = object(input, ["id", "decision", "acknowledgeDuplicateRisk"]);
          const job = structuredClone(lookup(v, ["id", "decision", "acknowledgeDuplicateRisk"]));
          if (!["held", "uncertain", "failed"].includes(job.status)) throw new HostCommandError("This job does not need a recovery decision.");
          if (v.decision !== "skip" && v.decision !== "run") throw new HostCommandError("decision must be skip or run.");
          if (job.lastRun?.threadId) {
            const thread = services.thread(job.lastRun.threadId);
            if (thread && !thread.isIdle()) throw new HostCommandError("The previous thread is still running or waiting. Finish or abort it first.");
          }
          if (job.status === "uncertain" && v.decision === "run" && v.acknowledgeDuplicateRisk !== true) throw new HostCommandError("Inspect existing threads first, then set acknowledgeDuplicateRisk: true to deliberately retry.");
          if (v.decision === "run" && !state.enabled) throw new HostCommandError("Scheduling is off. Explicitly enable it first.");
          await mutate(async () => {
            if (job.status === "uncertain") job.enabled = false;
            job.status = "ready"; job.detail = undefined;
            job.nextAt = job.config.schedule.kind === "daily" ? nextAt(job.config, Date.now()) : undefined;
            if (job.config.schedule.kind === "once") job.enabled = false;
            await replace(job);
          });
          return v.decision === "run" ? run(job.id) : structuredClone(job);
        }, { access: "owner" });
        context.registerCommand("set-enabled", (input) => mutate(async () => {
          const v = object(input, ["enabled"]);
          if (typeof v.enabled !== "boolean") throw new HostCommandError("enabled must be a boolean.");
          const next = snapshot(); next.enabled = v.enabled;
          if (v.enabled) for (const job of next.jobs) {
            if (job.nextAt && Date.parse(job.nextAt) <= Date.now() && ["ready", "completed"].includes(job.status)) job.status = "held";
          }
          await save(next); return snapshot();
        }), { access: "owner" });
        const stopObserver = services.registerTurnObserver({
          ended: async (threadId, _turnId, outcome) => {
            if (stopped) return;
            const current = state.jobs.find((j) => j.lastRun?.threadId === threadId && j.status === "running");
            // A fast turn can finish before start returns its thread id. Do not
            // wait here: a backend may be awaiting this observer itself.
            if (busy) { if (outcomes.size < 100) outcomes.set(threadId, outcome); return; }
            if (!current) return;
            outcomes.set(threadId, outcome);
            await mutate(async () => { await flushOutcomes(); });
          },
        });
        arm();
        return async () => {
          stopped = true; clearTimers(); stopObserver();
          await pendingWrite?.catch(() => undefined);
          lock.release();
        };
      } catch (error) { lock.release(); throw error; }
    },
  };
}
export default createSchedulingHostExtension;
