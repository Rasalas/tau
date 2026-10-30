import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HostCommandError, tryProcessLock, writePersistedJson, type HostExtension, type SecretStore } from "tau/host-extension";
import { nextRuns } from "./cron.js";
import { SCHEDULING_ID, repeats, type AccessLevel, type Job, type JobConfig, type SchedulingState } from "./protocol.js";
import { decodeAccessLevel, decodeConfig, object, text } from "./validation.js";
import { assertStateBudget, readState } from "./store.js";
import { DELIVERY_WINDOW_MS, REMEMBERED_DELIVERIES, SECRET_SERVICE, WEBHOOK_ROUTE, WebhookListener, matchesWebhookBody, deliveryPrompt, deliveryRetention, rememberedAs, remembers, verifyWebhook, webhookSecretProblem, webhookSecretStore, type WebhookDelivery } from "./webhooks.js";
import { WebhookSecrets } from "./secrets.js";
import { ScheduleRequests, strictest } from "./agent-tools.js";
import { combineWebhook, publicJob, type StoredJob, type StoredSchedulingState } from "./webhook-pending.js";
import { httpsOrigins } from "../_shared/https-origins.js";

/**
 * Statuses during which an automation's run owns its continued thread, and its
 * access ceiling holds. A failed run keeps it until the owner resolves the job:
 * whatever it started may still wake the thread with the run's input in context.
 */
const OWNS_THREAD = ["starting", "running", "uncertain", "failed"];
const IN_RUN = ["starting", "running"];

const formatOf = (job: Job) => job.config.schedule.kind === "webhook" ? job.config.schedule.format ?? "tau" : undefined;

/** The same replay and rate limits apply to immediate and combined deliveries. */
function rememberDelivery(job: StoredJob, delivery: WebhookDelivery): void {
  // Untimed signatures rely on this history, so refuse rather than evict a live replay record.
  const now = Date.now(), retention = deliveryRetention(delivery.format);
  const age = (entry: string) => now - Number(entry.split(":")[0]);
  const kept = (job.deliveries ?? []).filter((entry) => age(entry) <= retention);
  if (kept.filter((entry) => age(entry) <= DELIVERY_WINDOW_MS).length >= 100) throw new HostCommandError("This webhook has received 100 deliveries in five minutes. Try later with a new delivery.");
  if (kept.length >= REMEMBERED_DELIVERIES) throw new HostCommandError(`This webhook remembers ${REMEMBERED_DELIVERIES} recent deliveries to refuse replays and is full. New deliveries start again when the oldest age out.`);
  job.deliveries = [...kept, `${delivery.timestamp}:${rememberedAs(delivery)}`];
}

function nextAt(config: JobConfig, now: number): string | undefined {
  if (config.schedule.kind === "webhook") return undefined;
  if (config.schedule.kind === "once") return config.schedule.at;
  if (config.schedule.kind === "cron") {
    const [next] = nextRuns(config.schedule.expression, config.schedule.timezone, now, 1);
    return next === undefined ? undefined : new Date(next).toISOString();
  }
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
      if (!lock) throw new HostCommandError("Another scheduler owns this machine's state.");
      try {
        const restored = await readState(file);
        let state: StoredSchedulingState = structuredClone(restored);
        for (const job of state.jobs) {
          if (["starting", "running"].includes(job.status)) {
            job.status = "uncertain";
            if (job.lastRun) job.lastRun.outcome = "uncertain";
          } else if (state.enabled && job.enabled && job.nextAt && Date.parse(job.nextAt) <= Date.now() && ["ready", "completed"].includes(job.status)) job.status = "held";
        }
        if (JSON.stringify(state) !== JSON.stringify(restored)) await writePersistedJson(file, 1, { ...state }, { compact: true });
        let stopped = false;
        const secretStore = options.secretStore ?? webhookSecretStore((name) => services.findCommand(name));
        let webhookProblem: string | undefined;
        const webhook = new WebhookListener(services.stateDir, async (id, request) => {
          const job = state.jobs.find((j) => j.id === id);
          if (stopped || !state.enabled || !job?.enabled || job.config.schedule.kind !== "webhook" || !job.secretRef || !secretStore) return 404;
          const key = await secretStore.get({ service: SECRET_SERVICE, account: job.secretRef });
          if (!key) return 401;
          const verdict = verifyWebhook(job.config.schedule.format, request, key);
          if (!("delivery" in verdict)) return verdict.status;
          const { delivery } = verdict;
          const current = state.jobs.find((entry) => entry.id === id);
          if (stopped || !state.enabled || !current?.enabled || current.config.schedule.kind !== "webhook" || current.secretRef !== job.secretRef) return 404;
          if (current.deliveries?.some((entry) => remembers(entry, delivery))) return 200;
          if (!matchesWebhookBody(current.config.schedule.filters, delivery.body)) return 204;
          try { const result = await run(id, { firedAt: Date.now(), delivery, secretRef: job.secretRef }); return result === "filtered" ? 204 : result === "accepted" || result.status === "running" || result.status === "completed" ? 202 : 409; }
          catch { return 409; }
        }, () => { webhookProblem = undefined; context.emit("webhook-endpoint", { url: webhookUrl() }); });
        let stopWebhookRoute: (() => void) | undefined;
        const webhookUrl = () => {
          if (!webhook.url) return undefined;
          const origin = stopWebhookRoute && httpsOrigins(services.network)[0];
          return origin ? new URL(WEBHOOK_ROUTE, origin).toString() : webhook.url;
        };
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const copyState = () => structuredClone(state);
        const snapshot = (): SchedulingState => ({ enabled: state.enabled, jobs: state.jobs.map(publicJob) });
        const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
        const expiring = new Set<string>();
        const due = new Set<string>();
        const expireAt = (id: string, threadId: string, at: number) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (Date.now() < at) { expireAt(id, threadId, at); return; }
            void expire(id, threadId).catch((error: unknown) => services.log("scheduling.timeout", String(error)));
          }, Math.max(0, Math.min(at - Date.now(), 30_000)));
          timer.unref();
          timers.add(timer);
        };
        // Timers stop while the computer sleeps, so a long wait re-reads the wall clock every 30 seconds.
        const wake = (id: string, at: number, burstId?: string) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (Date.now() < at) { wake(id, at, burstId); return; }
            if (due.has(id)) return;
            due.add(id);
            void run(id, { firedAt: Date.now(), burstId }).catch((error: unknown) => services.log("scheduling.run", String(error))).finally(() => { due.delete(id); arm(); });
          }, Math.max(0, Math.min(at - Date.now(), 30_000)));
          timer.unref();
          timers.add(timer);
        };
        const arm = () => {
          clearTimers();
          void webhook.reconcile(!stopped && state.enabled && state.jobs.some((j) => j.enabled && j.config.schedule.kind === "webhook" && j.secretRef)).catch(() => { webhookProblem = "The webhook endpoint could not open. Check its saved port or restart Tau."; services.log("scheduling.webhook", webhookProblem); context.emit("webhook-endpoint", { problem: webhookProblem }); });
          if (stopped) return;
          for (const job of state.jobs) {
            if (job.status === "running" && job.lastRun?.threadId && !expiring.has(job.lastRun.threadId)) {
              expireAt(job.id, job.lastRun.threadId, Date.parse(job.lastRun.at) + job.config.maxDurationMinutes * 60_000);
            }
            if (state.enabled && job.enabled && job.webhookPending?.length && ["ready", "completed"].includes(job.status)) {
              const first = [...job.webhookPending].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]!;
              // due is held until the queued dispatch ends. Its finally re-arms after releasing it.
              if (!due.has(job.id)) wake(job.id, Math.max(Date.parse(first.dueAt), queued >= 100 ? Date.now() + 1000 : 0), first.id);
            }
            if (!state.enabled || !job.enabled || !job.nextAt || !["ready", "completed"].includes(job.status)) continue;
            wake(job.id, Date.parse(job.nextAt));
          }
        };
        /** Continued threads whose ceiling this host set, and the level it set. */
        const continued = new Map<string, AccessLevel>();
        /** A continued thread's own turn for the current run: `null` until the host admits the sent message. */
        const ownTurns = new Map<string, string | null>();
        /** The job whose run is in a continued thread now. */
        const continuing = (threadId: string) => state.jobs.find((job) => job.config.target?.threadId === threadId && job.lastRun?.threadId === threadId && IN_RUN.includes(job.status));
        const scheduledLevel = (threadId: string): AccessLevel | undefined => {
          const entry = services.thread(threadId)?.entries().find((candidate) => {
            const value = candidate as { type?: string; customType?: string };
            return value.type === "custom" && value.customType === "tau.scheduling/access";
          }) as { data: { level: unknown } } | undefined;
          try { return entry ? decodeAccessLevel(entry.data.level) : undefined; } catch { return undefined; }
        };
        /** The strictest of a scheduled thread's own level and every run that owns it as a continued thread. */
        const ceilingFor = (threadId: string): AccessLevel | undefined => {
          let level = scheduledLevel(threadId);
          for (const job of state.jobs) {
            if (job.config.target?.threadId !== threadId || job.lastRun?.threadId !== threadId || !OWNS_THREAD.includes(job.status) || !job.config.accessLevel) continue;
            level = level ? strictest(level, job.config.accessLevel) : job.config.accessLevel;
          }
          return level;
        };
        /** Lifts a continued thread's ceiling once its run is over, and sets it where a run owns one. */
        const reconcileCeilings = async () => {
          const threads = new Set(continued.keys());
          for (const job of state.jobs) if (job.config.target && OWNS_THREAD.includes(job.status)) threads.add(job.config.target.threadId);
          for (const threadId of threads) {
            const level = ceilingFor(threadId);
            if (continued.get(threadId) === level) continue;
            try {
              await context.invokeHostExtension("tau.access", "thread-level", { threadId, level: level ?? null });
              if (level) continued.set(threadId, level); else continued.delete(threadId);
            } catch (error) { services.log("scheduling.access", String(error).slice(0, 300)); }
          }
        };
        let pendingWrite: Promise<void> | undefined;
        const save = async (next: StoredSchedulingState) => {
          if (stopped) throw new HostCommandError("Scheduling stopped.");
          assertStateBudget(next);
          const write = writePersistedJson(file, 1, { ...next }, { compact: true, logger: { warn: (message) => services.log("scheduling.storage", message) } });
          pendingWrite = write;
          try { await write; }
          catch (error) {
            stopped = true; clearTimers(); context.fail("Scheduling could not persist state. No automatic retry will run.");
            throw new HostCommandError(String(error).slice(0, 500));
          } finally { if (pendingWrite === write) pendingWrite = undefined; }
          state = next; if (!stopped) context.emit("state", snapshot()); arm();
        };
        context.registerCommand("list", snapshot, { access: "read" });
        let queue: Promise<unknown> = Promise.resolve();
        let queued = 0;
        const busy = () => queued > 0;
        const outcomes = new Map<string, { status: "completed" | "failed"; detail?: string }>();
        const flushOutcomes = async () => {
          const next = copyState();
          let changed = false;
          for (const job of next.jobs) {
            const outcome = job.lastRun?.threadId ? outcomes.get(job.lastRun.threadId) : undefined;
            if (job.status === "running" && outcome) {
              expiring.delete(job.lastRun!.threadId!);
              job.status = outcome.status; job.lastRun!.outcome = outcome.status; job.lastRun!.detail = outcome.detail; changed = true;
              if (next.enabled && job.enabled && job.nextAt && Date.parse(job.nextAt) <= Date.now()) job.status = "held";
            }
          }
          outcomes.clear();
          if (changed && !stopped) await save(next);
        };
        const mutate = async <T>(work: () => Promise<T>): Promise<T> => {
          if (queued >= 100) throw new HostCommandError("Scheduling is busy. Try again after the queued operations finish.");
          queued++;
          const turn = queue.then(async () => {
            try { if (stopped) throw new HostCommandError("Scheduling stopped."); return await work(); }
            finally { try { await flushOutcomes(); await reconcileCeilings(); } finally { queued--; arm(); } }
          });
          queue = turn.catch(() => undefined);
          return turn;
        };
        const expire = async (id: string, threadId: string) => {
          if (stopped || state.jobs.find((job) => job.id === id)?.status !== "running" || expiring.has(threadId)) return;
          expiring.add(threadId);
          const outcome = { status: "failed" as const, detail: "Maximum duration exceeded. The scheduled turn was stopped." };
          outcomes.set(threadId, outcome);
          try {
            if (!services.sessions.abort) throw new HostCommandError("This machine cannot stop threads.");
            await services.sessions.abort(threadId);
          }
          catch { outcome.detail = "Maximum duration exceeded, but the thread could not be stopped. Inspect it before retrying."; }
          if (!busy() && !stopped) await mutate(async () => { await flushOutcomes(); });
        };
        const lookup = (input: unknown, keys = ["id"]): StoredJob => {
          const v = object(input, keys);
          const id = text(v.id, "Job ID", 36);
          const job = state.jobs.find((j) => j.id === id);
          if (!job) throw new HostCommandError("Unknown job.");
          return job;
        };
        const defaultAccessLevel = async () => decodeAccessLevel(await context.invokeHostExtension("tau.access", "level"));
        const threadLevelOf = async (threadId: string) => decodeAccessLevel(await context.invokeHostExtension("tau.access", "thread-level-of", { threadId }));
        /** The index's row for a thread on this host, freshly scanned; undefined when there is none. */
        const indexedThread = async (threadId: string) => {
          const update = await services.sessions.refreshIndex({ requireComplete: true });
          if (update.type !== "thread-index") throw new HostCommandError("The thread list is unavailable. Try again.");
          return update.index.sessions.find((session) => session.id === threadId);
        };
        const remoteThread = "The thread lives on another machine. An automation continues only threads on this machine.";
        /** Why an automation cannot continue this thread now: gone or elsewhere (`failed`), or busy (`held`). */
        const targetProblem = async (threadId: string): Promise<{ status: "held" | "failed"; detail: string } | undefined> => {
          let session: Awaited<ReturnType<typeof indexedThread>>;
          try { session = await indexedThread(threadId); }
          catch (error) { return { status: "held", detail: `The thread list could not be read. ${String(error).slice(0, 300)}` }; }
          if (!session) {
            const trashed = await services.sessions.trash().then((entries) => entries.some((entry) => entry.sessionId === threadId), () => false);
            return { status: "failed", detail: trashed
              ? "The thread this automation continues is in the trash. Restore it, or edit the automation to start a new thread."
              : "The thread this automation continues was deleted. Edit the automation to continue another thread or start a new one." };
          }
          if (session.backendKind === "machine" || session.machine) return { status: "failed", detail: remoteThread };
          if (services.thread(threadId)?.isIdle() === false || session.queued?.length || session.queueHeld) return { status: "held", detail: "The thread is still running or has queued messages." };
          return undefined;
        };
        const validate = async (input: unknown) => {
          const config = decodeConfig(input);
          config.workspace = await services.knownWorkspacePath(config.workspace);
          config.accessLevel ??= await defaultAccessLevel();
          if (config.target) {
            const session = await indexedThread(config.target.threadId);
            if (!session) throw new HostCommandError("Unknown thread. Choose a thread on this machine.");
            if (session.backendKind === "machine" || session.machine) throw new HostCommandError(remoteThread);
          }
          return config;
        };
        /** Overdue enabled jobs wait for a decision instead of starting when automations turn on. */
        const holdOverdue = (next: SchedulingState) => {
          for (const job of next.jobs) if (job.enabled && job.nextAt && Date.parse(job.nextAt) <= Date.now() && ["ready", "completed"].includes(job.status)) job.status = "held";
        };
        const createJob = (input: unknown, approved?: { threadId: string; turnOn: boolean }) => mutate(async () => {
          if (state.jobs.length >= 100) throw new HostCommandError("At most 100 scheduling jobs are allowed.");
          const config = await validate(input);
          const job: StoredJob = { id: randomUUID(), config, workspaceId: services.workspaceRef(config.workspace).workspaceId, enabled: false, status: "ready", nextAt: nextAt(config, Date.now()) };
          const next = copyState(); next.jobs.push(job);
          if (approved) {
            if (config.schedule.kind === "webhook") throw new HostCommandError("An agent cannot create a webhook automation.");
            // Read again at approval: the thread may run lower now than when it asked.
            config.accessLevel = strictest(config.accessLevel!, await threadLevelOf(approved.threadId));
            job.origin = { threadId: approved.threadId };
            job.enabled = true;
            if (approved.turnOn && !next.enabled) { next.enabled = true; holdOverdue(next); }
            if (next.enabled && job.nextAt && Date.parse(job.nextAt) <= Date.now()) job.status = "held";
          }
          await save(next);
          return publicJob(job);
        });
        context.registerCommand("create", (input) => createJob(input), { access: "owner" });
        for (const command of ["enable", "disable", "delete", "update"] as const) {
          context.registerCommand(command, (input) => mutate(async () => {
            const job = lookup(input, command === "update" ? ["id", "config"] : ["id"]);
            const copy = structuredClone(job);
            if (["starting", "running"].includes(job.status) && command !== "disable") throw new HostCommandError("This job is already running.");
            if (["held", "uncertain", "failed"].includes(job.status) && ["enable", "update"].includes(command)) throw new HostCommandError("Resolve this job explicitly first.");
            if (command === "update") {
              copy.config = await validate((input as { config: unknown }).config);
              // Older clients omit filters when saving. Only an explicit [] clears them.
              if (copy.config.schedule.kind === "webhook" && job.config.schedule.kind === "webhook" && copy.config.schedule.filters === undefined && job.config.schedule.filters !== undefined) copy.config.schedule.filters = structuredClone(job.config.schedule.filters);
              if (copy.config.schedule.kind === "webhook" && job.config.schedule.kind === "webhook" && copy.config.schedule.coalescing === undefined && job.config.schedule.coalescing !== undefined) copy.config.schedule.coalescing = structuredClone(job.config.schedule.coalescing);
              if (job.webhookPending?.length) {
                const execution = (config: JobConfig) => ({ ...config, name: "", schedule: config.schedule.kind === "webhook" ? { kind: "webhook", format: config.schedule.format ?? "tau", includePayload: config.schedule.includePayload === true, filters: config.schedule.filters ?? [] } : config.schedule });
                if (JSON.stringify(execution(copy.config)) !== JSON.stringify(execution(job.config))) throw new HostCommandError("Waiting webhook deliveries must finish first. Disable this automation to discard them before changing filters or execution settings.");
              }
              copy.workspaceId = services.workspaceRef(copy.config.workspace).workspaceId;
              // Another provider signs with another secret; a key never moves between formats or projects.
              if (copy.workspaceId !== job.workspaceId || copy.config.schedule.kind !== "webhook" || formatOf(copy) !== formatOf(job)) { copy.secretRef = undefined; copy.deliveries = undefined; }
              copy.status = "ready"; copy.detail = undefined;
              copy.enabled = job.webhookPending?.length ? job.enabled : false;
              copy.nextAt = nextAt(copy.config, Date.now());
            } else {
              copy.enabled = command === "enable";
              if (command === "disable") copy.webhookPending = undefined;
            }
            if (command === "enable" && copy.config.schedule.kind === "webhook" && !copy.secretRef) throw new HostCommandError("Save a private signature key before enabling this webhook.");
            if (command === "enable" && repeats(copy.config.schedule)) copy.nextAt = nextAt(copy.config, Date.now());
            if (command === "enable" && state.enabled && copy.nextAt && Date.parse(copy.nextAt) <= Date.now()) copy.status = "held";
            await save({ ...state, jobs: command === "delete" ? state.jobs.filter((j) => j.id !== job.id) : state.jobs.map((j) => j.id === job.id ? copy : j) });
            if (job.secretRef && (command === "delete" || copy.secretRef !== job.secretRef)) await secretStore?.delete({ service: SECRET_SERVICE, account: job.secretRef }).catch(() => services.log("scheduling.secrets", "An unused signature key could not be removed from the operating-system store."));
            return publicJob(copy);
          }), { access: "owner" });
        }
        const replace = async (job: StoredJob) => save({ ...state, jobs: state.jobs.map((j) => j.id === job.id ? job : j) });
        const runWork = async (id: string, trigger?: { firedAt: number; delivery?: WebhookDelivery; secretRef?: string; burstId?: string; retry?: boolean }): Promise<Job | "filtered" | "accepted"> => {
          const job = structuredClone(lookup({ id }));
          const scheduled = trigger !== undefined && !trigger.retry, delivery = trigger?.delivery;
          if (delivery && (!job.enabled || job.config.schedule.kind !== "webhook" || job.secretRef !== trigger?.secretRef)) throw new HostCommandError("This webhook changed before the delivery could start.");
          if (delivery && job.deliveries?.some((entry) => remembers(entry, delivery))) return "accepted" as const;
          // Configuration can change while a verified delivery waits behind another start.
          if (delivery && job.config.schedule.kind === "webhook" && !matchesWebhookBody(job.config.schedule.filters, delivery.body)) return "filtered" as const;
          const pending = trigger?.burstId ? job.webhookPending?.find((entry) => entry.id === trigger.burstId) : undefined;
          if (trigger?.burstId && (!pending || !job.enabled || !state.enabled || stopped)) return publicJob(job);
          if (pending && Date.now() < Date.parse(pending.dueAt)) return publicJob(job);
          if (delivery && job.config.schedule.kind === "webhook" && job.config.schedule.coalescing) {
            if (!state.enabled || stopped || ["held", "uncertain", "failed"].includes(job.status)) throw new HostCommandError("Resolve this job before accepting more deliveries.");
            rememberDelivery(job, delivery);
            combineWebhook(job, delivery.body, Date.now(), delivery);
            await replace(job);
            return "accepted" as const;
          }
          if (!scheduled && !trigger?.retry && job.webhookPending?.length) throw new HostCommandError("Waiting webhook deliveries must finish first, or disable this automation to discard them.");
          if (pending && !matchesWebhookBody(job.config.schedule.kind === "webhook" ? job.config.schedule.filters : undefined, Buffer.from(pending.body, "base64"))) {
            job.status = "held"; job.detail = "Waiting webhook deliveries no longer match the saved filters. Disable this automation to discard them.";
            await replace(job); return publicJob(job);
          }
          if (["starting", "running"].includes(job.status)) throw new HostCommandError("This job is already running.");
          if (["held", "uncertain", "failed"].includes(job.status)) throw new HostCommandError("Resolve this job explicitly first.");
          if (!state.enabled) throw new HostCommandError("Scheduling is off. Explicitly enable it first.");
          if (scheduled && (!job.enabled || stopped)) return publicJob(job);
          if (scheduled && job.nextAt && Date.now() < Date.parse(job.nextAt)) return publicJob(job);
          if (job.lastRun?.threadId) {
            const previous = services.thread(job.lastRun.threadId);
            if (previous && !previous.isIdle()) {
              job.status = "held"; job.detail = "The previous thread is still running or waiting.";
              await replace(job); throw new HostCommandError(job.detail);
            }
          }
          if (trigger && !pending && job.nextAt && trigger.firedAt - Date.parse(job.nextAt) > 60_000) {
            job.status = "held"; await replace(job); return publicJob(job);
          }
          try {
            const path = await services.knownWorkspacePath(job.workspaceId);
            if (path !== job.config.workspace) throw new HostCommandError("The job's local workspace changed. Recreate the job explicitly.");
          } catch (error) {
            job.status = "held"; job.detail = String(error).slice(0, 500);
            await replace(job);
            throw new HostCommandError(job.detail);
          }
          const target = job.config.target;
          if (target) {
            const problem = await targetProblem(target.threadId);
            if (problem) { job.status = problem.status; job.detail = problem.detail; await replace(job); throw new HostCommandError(problem.detail); }
          }
          job.status = "starting"; job.detail = undefined;
          if (delivery) {
            rememberDelivery(job, delivery);
          }
          const schedule = job.config.schedule;
          const payload = delivery ?? (pending ? { ...(pending.delivery ?? { id: pending.id, timestamp: Date.parse(pending.at), format: schedule.kind === "webhook" ? schedule.format : undefined }), body: Buffer.from(pending.body, "base64") } : undefined);
          const prompt = job.config.prompt + (payload ? deliveryPrompt(payload, schedule.kind === "webhook" && schedule.includePayload === true) : "");
          const retry = trigger?.retry && job.lastRun?.webhookBurstId ? { webhookBurstId: job.lastRun.webhookBurstId, deliveryCount: job.lastRun.deliveryCount } : {};
          job.lastRun = { intentId: randomUUID(), at: new Date().toISOString(), outcome: "starting", ...retry, ...(target ? { threadId: target.threadId } : {}), ...(pending ? { webhookBurstId: pending.id, deliveryCount: pending.count } : {}) };
          if (pending) job.webhookPending = job.webhookPending!.filter((entry) => entry.id !== pending.id);
          job.nextAt = repeats(job.config.schedule) ? nextAt(job.config, Date.now()) : undefined;
          if (job.config.schedule.kind === "once") job.enabled = false;
          // Await the atomic intent write before the host can create a thread.
          await replace(job);
          if (stopped) throw new HostCommandError("Scheduling stopped before admission.");
          try {
            job.config.accessLevel ??= await defaultAccessLevel();
            if (target) {
              if (!services.sessions.send) throw new HostCommandError("This machine cannot send messages to threads.");
              // The ceiling is set before the message can start a turn; `prepare` sets it again on each turn of the run.
              const level = strictest(ceilingFor(target.threadId) ?? job.config.accessLevel, job.config.accessLevel);
              await context.invokeHostExtension("tau.access", "thread-level", { threadId: target.threadId, level });
              continued.set(target.threadId, level);
              ownTurns.set(target.threadId, null);
              if (stopped) throw new HostCommandError("Scheduling stopped before sending the message.");
              await services.sessions.send(target.threadId, prompt, { delivery: "queue", wake: { source: "automation", label: job.config.name } });
              job.status = "running"; job.lastRun.outcome = "running";
              if (!stopped) await replace(job);
              return publicJob(job);
            }
            const cwd = job.config.workspaceStrategy === "worktree"
              ? (await context.invokeHostExtension("tau.workspace", "create-worktree", { workspace: job.workspaceId, branch: `scheduled/${job.lastRun.intentId}`, startFromOrigin: false }) as { path: string }).path
              : job.config.workspace;
            if (typeof cwd !== "string" || !cwd || (job.config.workspaceStrategy === "worktree" && cwd === job.config.workspace)) throw new HostCommandError("A separate worktree could not be created.");
            if (stopped) throw new HostCommandError("Scheduling stopped before thread creation.");
            const thread = await services.sessions.start({ cwd, backend: job.config.backend, title: `Scheduled: ${job.config.name}`, prompt,
              beforePrompt: async (created) => {
                await context.invokeHostExtension("tau.access", "thread-level", { threadId: created.sessionId, level: job.config.accessLevel });
                created.appendEntry("tau.scheduling/access", { level: job.config.accessLevel });
                job.lastRun!.threadId = created.sessionId;
                await replace(job);
              },
            });
            job.status = "running"; job.lastRun.threadId = thread.sessionId; job.lastRun.outcome = "running";
          } catch (error) {
            job.status = "failed"; job.lastRun.outcome = "failed"; job.lastRun.detail = String(error).slice(0, 500);
          }
          if (!stopped) await replace(job);
          return publicJob(job);
        };
        const run = (...args: Parameters<typeof runWork>) => mutate(() => runWork(...args));
        context.registerCommand("run", (input) => run(lookup(input).id), { access: "owner" });
        context.registerCommand("thread-path", async (input) => {
          const job = lookup(input);
          return job.lastRun?.threadId ? (await services.sessions.list()).find((thread) => thread.sessionId === job.lastRun!.threadId)?.path : undefined;
        }, { access: "read" });
        context.registerCommand("resolve", async (input) => {
          const v = object(input, ["id", "decision", "acknowledgeDuplicateRisk"]);
          return mutate(async () => {
            const job = structuredClone(lookup(v, ["id", "decision", "acknowledgeDuplicateRisk"]));
            if (!["held", "uncertain", "failed"].includes(job.status)) throw new HostCommandError("This job does not need a recovery decision.");
            if (v.decision !== "skip" && v.decision !== "run") throw new HostCommandError("decision must be skip or run.");
            if (job.lastRun?.threadId) {
              const thread = services.thread(job.lastRun.threadId);
              if (thread && !thread.isIdle()) throw new HostCommandError("The previous thread is still running or waiting. Finish or abort it first.");
            }
            if (job.status === "uncertain" && v.decision === "run" && v.acknowledgeDuplicateRisk !== true) throw new HostCommandError("Inspect existing threads first, then set acknowledgeDuplicateRisk: true to deliberately retry.");
            if (v.decision === "run" && !state.enabled) throw new HostCommandError("Scheduling is off. Explicitly enable it first.");
            // A deleted continued thread fails before a window becomes a recorded intent.
            const failedBeforeIntent = job.status === "failed" && job.lastRun?.outcome !== "failed";
            if (v.decision === "skip" && job.webhookPending?.length && (job.status === "held" || failedBeforeIntent)) {
              const first = [...job.webhookPending].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]!;
              job.webhookPending = job.webhookPending.filter((entry) => entry.id !== first.id);
            }
            if (job.status === "uncertain") job.enabled = false;
            job.status = "ready"; job.detail = undefined;
            job.nextAt = repeats(job.config.schedule) ? nextAt(job.config, Date.now()) : undefined;
            if (job.config.schedule.kind === "once") job.enabled = false;
            await replace(job);
            if (v.decision !== "run") return publicJob(job);
            // Retry the recorded intent first. Other accepted windows remain queued.
            const retry = job.lastRun && ["failed", "uncertain"].includes(job.lastRun.outcome);
            const pending = !retry ? job.webhookPending?.[0] : undefined;
            return pending ? runWork(job.id, { firedAt: Date.now(), burstId: pending.id }) : runWork(job.id, { firedAt: Date.now(), retry: true });
          });
        }, { access: "owner" });
        context.registerCommand("set-enabled", (input) => mutate(async () => {
          const v = object(input, ["enabled"]);
          if (typeof v.enabled !== "boolean") throw new HostCommandError("enabled must be a boolean.");
          const next = copyState(); next.enabled = v.enabled;
          if (!v.enabled) for (const job of next.jobs) job.webhookPending = undefined;
          if (v.enabled) holdOverdue(next);
          await save(next); return snapshot();
        }), { access: "owner" });
        const bindSecret = (id: string, reference: string, valid?: () => boolean) => mutate(async () => {
          const job = structuredClone(lookup({ id }));
          if (job.config.schedule.kind !== "webhook" || ["starting", "running"].includes(job.status)) throw new HostCommandError("Only an idle webhook can change its signature key.");
          if (job.webhookPending?.length) throw new HostCommandError("Disable this automation to discard waiting deliveries before changing its signature key.");
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
        const schedules = new ScheduleRequests(context, {
          jobs: () => snapshot().jobs,
          create: (config, origin) => createJob(config, origin),
          threadLevel: threadLevelOf,
          cancel: (threadId, id) => mutate(async () => {
            const job = lookup({ id });
            if (job.origin?.threadId !== threadId) throw new HostCommandError("Only an automation this thread proposed can be cancelled here.");
            if (["starting", "running"].includes(job.status)) throw new HostCommandError("This automation is running now. Cancel it after the run ends.");
            await save({ ...state, jobs: state.jobs.filter((entry) => entry.id !== id) });
            if (job.secretRef) await secretStore?.delete({ service: SECRET_SERVICE, account: job.secretRef }).catch(() => undefined);
          }),
        });
        schedules.register();
        context.registerCommand("manage", async (_input, call) => ({ ...snapshot(), defaultAccessLevel: await defaultAccessLevel().catch(() => undefined), canManage: call.owner, secretRequests: secrets.list(), scheduleRequests: schedules.list(), secretStore: secretStore?.name, webhookUrl: webhookUrl(), webhookProblem }), { access: "read" });
        context.registerCommand("set-webhook-secret", async (input) => {
          const v = object(input, ["id", "value"]);
          const id = text(v.id, "Automation ID", 36);
          const value = text(v.value, "Secret", 8192);
          if (!secretStore) throw new HostCommandError("No operating-system secret store is available on this machine.");
          const problem = webhookSecretProblem(formatOf(lookup({ id })), value);
          if (problem) throw new HostCommandError(problem);
          const reference = randomUUID();
          const item = { service: SECRET_SERVICE, account: reference, label: `Webhook signature: ${lookup({ id }).config.name}` };
          try { await secretStore.set(item, value); await bindSecret(id, reference); }
          catch { await secretStore.delete(item).catch(() => undefined); throw new HostCommandError("Couldn't save the signature key. Try again."); }
          return { saved: true };
        }, { access: "owner" });
        /**
         * The run that continued a thread is over once the thread is quiet: no
         * turn, nothing queued and no background work that could wake it. Until
         * then later automatic turns stay under the run's ceiling.
         */
        const settleContinued = async (threadId: string, outcome: "completed" | "failed") => {
          if (outcome === "completed") {
            if (services.thread(threadId)?.isIdle() === false) return;
            const row = await indexedThread(threadId).catch(() => undefined);
            if (!row || row.queued?.length || row.queueHeld || row.background?.length) return;
          }
          if (stopped || !continuing(threadId)) return;
          ownTurns.delete(threadId);
          if (busy()) { if (outcomes.size < 100) outcomes.set(threadId, { status: outcome }); return; }
          outcomes.set(threadId, { status: outcome });
          await mutate(async () => { await flushOutcomes(); });
        };
        const stopObserver = services.registerTurnObserver({
          // Every turn: a scheduled thread's own level, and the ceiling of a run that continues this thread.
          prepare: async (threadId) => {
            const level = ceilingFor(threadId);
            if (!level) return;
            await context.invokeHostExtension("tau.access", "thread-level", { threadId, level });
            // Remembered so the ceiling lifts when the run is resolved, also after a restart.
            if (state.jobs.some((job) => job.config.target?.threadId === threadId)) continued.set(threadId, level);
          },
          stopped: (threadId) => {
            const pending = secrets.list().some((request) => request.threadId === threadId && request.status === "pending");
            secrets.end(threadId);
            const proposed = schedules.end(threadId);
            return [...(pending ? ["ended the private secret request"] : []), ...(proposed ? ["ended the automation proposal"] : [])];
          },
          accepted: (threadId, turnId) => {
            if (ownTurns.get(threadId) === null) ownTurns.set(threadId, turnId);
          },
          // A continued thread's run is not over when one turn ends: `runEnded` decides.
          runEnded: (threadId, outcome) => {
            if (stopped || expiring.has(threadId) || typeof ownTurns.get(threadId) !== "string" || !continuing(threadId)) return;
            void settleContinued(threadId, outcome).catch((error: unknown) => services.log("scheduling.continue", String(error).slice(0, 300)));
          },
          ended: async (threadId, _turnId, outcome) => {
            if (stopped || expiring.has(threadId) || continuing(threadId)) return;
            const current = state.jobs.find((j) => j.lastRun?.threadId === threadId && j.status === "running");
            // A fast turn can finish before start returns its thread id. Do not
            // wait here: a backend may be awaiting this observer itself.
            if (busy()) { if (outcomes.size < 100) outcomes.set(threadId, { status: outcome }); return; }
            if (!current) return;
            outcomes.set(threadId, { status: outcome });
            await mutate(async () => { await flushOutcomes(); });
          },
        });
        stopWebhookRoute = services.network?.registerHttpRoute?.("webhooks", (request, response) => webhook.handle(request, response));
        arm();
        return async () => {
          stopped = true; clearTimers(); stopObserver(); stopWebhookRoute?.();
          secrets.close(); schedules.close(); await webhook.close();
          await pendingWrite?.catch(() => undefined);
          lock.release();
        };
      } catch (error) { lock.release(); throw error; }
    },
  };
}
export default createSchedulingHostExtension;
