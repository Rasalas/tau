import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HostCommandError, tryProcessLock, writePersistedJson, type HostExtension, type SecretStore } from "tau/host-extension";
import { SCHEDULING_ID, type Job, type JobConfig, type SchedulingState } from "./protocol.js";
import { decodeConfig, object, text } from "./validation.js";
import { assertStateBudget, readState } from "./store.js";
import { DELIVERY_WINDOW_MS, SECRET_SERVICE, WebhookListener, verifyDelivery, webhookSecretStore, type WebhookDelivery } from "./webhooks.js";
import { WebhookSecrets } from "./secrets.js";

function nextAt(config: JobConfig, now: number): string | undefined {
  if (config.schedule.kind === "webhook") return undefined;
  if (config.schedule.kind === "once") return config.schedule.at;
  const date = new Date(now);
  const [hours, minutes] = config.schedule.time.split(":").map(Number);
  date.setUTCHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function createSchedulingHostExtension(options: { secretStore?: SecretStore } = {}): HostExtension {
  return {
    id: SCHEDULING_ID, name: "Scheduling", permissions: ["sessions", "workspace:read", "network", "process", "runtime:extend"], isolation: "in-process",
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
        const secretStore = options.secretStore ?? webhookSecretStore((name) => services.findCommand(name));
        let webhookProblem: string | undefined;
        const webhook = new WebhookListener(services.stateDir, async (id, delivery) => {
          const job = state.jobs.find((j) => j.id === id);
          if (!state.enabled || !job?.enabled || job.config.schedule.kind !== "webhook" || !job.secretRef || !secretStore) return 404;
          const key = await secretStore.get({ service: SECRET_SERVICE, account: job.secretRef });
          if (!key || !verifyDelivery(delivery, key)) return 401;
          const current = state.jobs.find((entry) => entry.id === id);
          if (!state.enabled || !current?.enabled || current.secretRef !== job.secretRef) return 404;
          if (current.deliveries?.some((entry) => entry.slice(14) === delivery.id)) return 200;
          try { const result = await run(id, true, delivery); return result.status === "running" || result.status === "completed" ? 202 : 409; }
          catch { return 409; }
        }, () => { webhookProblem = undefined; context.emit("webhook-endpoint", { url: webhook.url }); });
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const snapshot = () => structuredClone(state);
        const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
        const arm = () => {
          clearTimers();
          void webhook.reconcile(!stopped && state.enabled && state.jobs.some((j) => j.enabled && j.config.schedule.kind === "webhook" && j.secretRef)).catch(() => { webhookProblem = "The webhook endpoint could not open. Check its saved port or restart Tau."; services.log("scheduling.webhook", webhookProblem); context.emit("webhook-endpoint", { problem: webhookProblem }); });
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
              if (copy.workspaceId !== job.workspaceId || copy.config.schedule.kind !== "webhook") { copy.secretRef = undefined; copy.deliveries = undefined; }
              copy.status = "ready"; copy.detail = undefined;
              copy.enabled = false;
              copy.nextAt = nextAt(copy.config, Date.now());
            } else copy.enabled = command === "enable";
            if (command === "enable" && copy.config.schedule.kind === "webhook" && !copy.secretRef) throw new HostCommandError("Save a private signature key before enabling this webhook.");
            if (command === "enable" && copy.nextAt && Date.parse(copy.nextAt) <= Date.now()) copy.status = "held";
            await save({ ...state, jobs: command === "delete" ? state.jobs.filter((j) => j.id !== job.id) : state.jobs.map((j) => j.id === job.id ? copy : j) });
            if (job.secretRef && (command === "delete" || copy.secretRef !== job.secretRef)) await secretStore?.delete({ service: SECRET_SERVICE, account: job.secretRef }).catch(() => services.log("scheduling.secrets", "An unused signature key could not be removed from the operating-system store."));
            return structuredClone(copy);
          }), { access: "owner" });
        }
        const replace = async (job: Job) => save({ ...state, jobs: state.jobs.map((j) => j.id === job.id ? job : j) });
        const run = (id: string, scheduled = false, delivery?: WebhookDelivery) => mutate(async () => {
          const job = structuredClone(lookup({ id }));
          if (delivery && job.deliveries?.some((entry) => entry.slice(14) === delivery.id)) return job;
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
          if (delivery) {
            const recent = (job.deliveries ?? []).filter((entry) => Date.now() - Number(entry.split(":")[0]) <= DELIVERY_WINDOW_MS);
            if (recent.length >= 100) throw new HostCommandError("This webhook has received 100 deliveries in five minutes. Try later with a new delivery.");
            job.deliveries = [...recent, `${delivery.timestamp}:${delivery.id}`];
          }
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
        context.registerCommand("thread-path", async (input) => {
          const job = lookup(input);
          return job.lastRun?.threadId ? (await services.sessions.list()).find((thread) => thread.sessionId === job.lastRun!.threadId)?.path : undefined;
        }, { access: "read" });
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
        const bindSecret = (id: string, reference: string, valid?: () => boolean) => mutate(async () => {
          const job = structuredClone(lookup({ id }));
          if (job.config.schedule.kind !== "webhook" || ["starting", "running"].includes(job.status)) throw new HostCommandError("Only an idle webhook can change its signature key.");
          if (valid && !valid()) throw new HostCommandError("This secret request ended or its target changed.");
          const original = structuredClone(job);
          const previous = job.secretRef;
          job.secretRef = reference;
          job.enabled = false;
          await replace(job);
          if (valid && !valid()) { await replace(original); throw new HostCommandError("This secret request ended."); }
          if (previous && previous !== reference) await secretStore?.delete({ service: SECRET_SERVICE, account: previous }).catch(() => undefined);
        });
        const secrets = new WebhookSecrets(context, secretStore, (id) => lookup({ id }), bindSecret);
        secrets.register();
        context.registerCommand("manage", (_input, call) => ({ ...snapshot(), canManage: call.owner, secretRequests: secrets.list(), secretStore: secretStore?.name, webhookUrl: webhook.url, webhookProblem }), { access: "read" });
        context.registerCommand("set-webhook-secret", async (input) => {
          const v = object(input, ["id", "value"]);
          const id = text(v.id, "Automation ID", 36);
          const value = text(v.value, "Secret", 8192);
          if (!secretStore) throw new HostCommandError("No operating-system secret store is available on this host.");
          const reference = randomUUID();
          const item = { service: SECRET_SERVICE, account: reference, label: `Webhook signature: ${lookup({ id }).config.name}` };
          try { await secretStore.set(item, value); await bindSecret(id, reference); }
          catch { await secretStore.delete(item).catch(() => undefined); throw new HostCommandError("Couldn't save the signature key. Try again."); }
          return { saved: true };
        }, { access: "owner" });
        const stopObserver = services.registerTurnObserver({
          stopped: (threadId) => {
            const pending = secrets.list().some((request) => request.threadId === threadId && request.status === "pending");
            secrets.end(threadId);
            return pending ? ["ended the private secret request"] : [];
          },
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
          secrets.close(); await webhook.close();
          await pendingWrite?.catch(() => undefined);
          lock.release();
        };
      } catch (error) { lock.release(); throw error; }
    },
  };
}
export default createSchedulingHostExtension;
