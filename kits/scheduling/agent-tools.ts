import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { HostCommandError, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import { knownTimeZone } from "./cron.js";
import type { AccessLevel, Job, JobConfig, Schedule, ScheduleRequest } from "./protocol.js";
import { decodeAccessLevel, decodeConfig, object, text } from "./validation.js";

const STRICTNESS: Record<AccessLevel, number> = { "read-only": 0, ask: 1, auto: 2, full: 3 };
/** The stricter of two levels; an automation never runs above the thread that asked for it. */
export const strictest = (left: AccessLevel, right: AccessLevel): AccessLevel => STRICTNESS[right] < STRICTNESS[left] ? right : left;

export const SCHEDULE_TOOL = "tau_schedule_thread";
export const LIST_SCHEDULES_TOOL = "tau_thread_schedules";
export const CANCEL_SCHEDULE_TOOL = "tau_cancel_thread_schedule";

/** What the tools need from the scheduler; it owns the jobs and their persistence. */
export interface ScheduleDeps {
  jobs(): readonly Job[];
  /** Creates the approved automation, enabled, clamped again to the thread's level at that moment. */
  create(config: JobConfig, origin: { threadId: string; turnOn: boolean }): Promise<Job>;
  /** Deletes an automation this thread proposed; refuses any other. */
  cancel(threadId: string, jobId: string): Promise<void>;
  /** The level the thread runs at now: the workbench's, narrowed by the thread's own. */
  threadLevel(threadId: string): Promise<AccessLevel>;
}

/** The automation's name from the prompt's first line, at most 60 characters. */
export function proposedName(prompt: string): string {
  const line = prompt.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "Scheduled message";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/** `daily` 21:00 in a zone becomes a cron rule there; UTC keeps the plain daily kind. */
export function proposedSchedule(input: { daily?: unknown; cron?: unknown; once?: unknown; timezone?: unknown }, now = Date.now(), localZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Schedule {
  const given = [input.daily, input.cron, input.once].filter((value) => value !== undefined);
  if (given.length !== 1) throw new HostCommandError("Give exactly one of daily, cron or once.");
  const timezone = input.timezone === undefined ? localZone : text(input.timezone, "Time zone", 64);
  if (!knownTimeZone(timezone)) throw new HostCommandError(`Unknown time zone ${timezone}. Use an IANA zone such as Europe/Berlin.`);
  if (input.daily !== undefined) {
    const time = text(input.daily, "Daily time", 5);
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
    if (!match) throw new HostCommandError("daily takes HH:mm, for example 21:00.");
    return timezone === "UTC" ? { kind: "daily", time, timezone: "UTC" } : { kind: "cron", expression: `${Number(match[2])} ${Number(match[1])} * * *`, timezone };
  }
  if (input.cron !== undefined) return { kind: "cron", expression: text(input.cron, "Cron expression", 120), timezone };
  const at = text(input.once, "Time", 24);
  if (!(Date.parse(at) > now)) throw new HostCommandError("once takes a future UTC time, YYYY-MM-DDTHH:mm:ssZ.");
  return { kind: "once", at };
}

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

/**
 * Lets a thread's agent propose an automation for this thread or for a new
 * thread in its project. Creating one is the owner's decision: the proposal
 * waits as a card that only this machine's own window can approve, and its
 * access never exceeds the level the asking thread runs at.
 */
export class ScheduleRequests {
  private readonly requests = new Map<string, ScheduleRequest>();
  private readonly answers = new Map<string, () => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly approving = new Set<string>();
  private readonly stops: (() => void)[] = [];
  constructor(private readonly context: HostExtensionContext, private readonly deps: ScheduleDeps) {}

  list(): ScheduleRequest[] { return [...this.requests.values()].map((request) => structuredClone(request)); }
  private changed(): void { this.context.emit("schedule-requests", this.list()); }
  /** Ends the thread's waiting proposals; true when one was waiting. */
  end(threadId: string): boolean {
    let ended = false;
    for (const request of this.requests.values()) if (request.threadId === threadId && request.status === "pending") { this.finish(request.id, "ended"); ended = true; }
    return ended;
  }
  private finish(id: string, status: ScheduleRequest["status"]): void {
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return;
    request.status = status;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.answers.get(id)?.(); this.answers.delete(id);
    this.changed();
  }

  tools(session: RuntimeSessionInfo): HostMcpTool[] {
    const { services } = this.context;
    const mine = (job: Job) => job.origin?.threadId === session.sessionId || job.config.target?.threadId === session.sessionId;
    return [{
      annotations: { readOnlyHint: false },
      name: SCHEDULE_TOOL, label: "Schedule this thread",
      description: "Propose an automation that sends a prompt on a schedule: into this thread (target this-thread, the default) or into a new thread in this project each run (new-thread). Give exactly one of daily (HH:mm), cron (five fields) or once (future UTC time); times use timezone, default this machine's zone. The user must approve it before it exists; this call waits for that answer. Access never exceeds this thread's current level. Example: daily \"21:00\", prompt \"Continue the nightly cleanup\".",
      parameters: Type.Object({
        prompt: Type.String({ description: "The message each run sends." }),
        reason: Type.String({ description: "One sentence for the user: why this should repeat." }),
        daily: Type.Optional(Type.String({ description: "Every day at HH:mm." })),
        cron: Type.Optional(Type.String({ description: "Five-field cron, e.g. 0 9 * * 1-5." })),
        once: Type.Optional(Type.String({ description: "One run at this UTC time, YYYY-MM-DDTHH:mm:ssZ." })),
        timezone: Type.Optional(Type.String({ description: "IANA zone for daily and cron; this machine's zone when omitted." })),
        target: Type.Optional(Type.Union([Type.Literal("this-thread"), Type.Literal("new-thread")])),
        name: Type.Optional(Type.String()),
        accessLevel: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")], { description: "Lower than this thread's level if you want; never higher." })),
      }),
      execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
        const v = object(input, ["prompt", "reason", "daily", "cron", "once", "timezone", "target", "name", "accessLevel"]);
        const prompt = text(v.prompt, "Prompt", 16_384);
        const reason = text(v.reason, "Reason", 500);
        if (v.target !== undefined && v.target !== "this-thread" && v.target !== "new-thread") throw new HostCommandError("target is this-thread or new-thread.");
        const schedule = proposedSchedule(v);
        const current = await this.deps.threadLevel(session.sessionId);
        const accessLevel = strictest(v.accessLevel === undefined ? current : decodeAccessLevel(v.accessLevel), current);
        const workspace = await services.knownWorkspacePath(session.cwd);
        const config = decodeConfig({
          name: v.name === undefined ? proposedName(prompt) : text(v.name, "Name", 120), workspace, backend: services.thread(session.sessionId)?.backendKind ?? "pi", prompt, schedule,
          workspaceStrategy: "worktree", accessLevel, maxDurationMinutes: 60,
          ...(v.target === "new-thread" ? {} : { target: { kind: "thread", threadId: session.sessionId } }),
        });
        if (signal?.aborted) throw new HostCommandError("The proposal ended.");
        if ([...this.requests.values()].some((entry) => entry.status === "pending" && entry.threadId === session.sessionId)) throw new HostCommandError("A proposal from this thread is already waiting for the user.");
        // Keep at most 100 answered proposals.
        for (const [id, old] of this.requests) if (this.requests.size >= 100 && old.status !== "pending") this.requests.delete(id);
        const request: ScheduleRequest = { id: randomUUID(), threadId: session.sessionId, config, reason, status: "pending", expiresAt: Date.now() + 86_400_000 };
        this.requests.set(request.id, request);
        const answer = new Promise<void>((resolve) => this.answers.set(request.id, resolve));
        const cancel = () => this.finish(request.id, "ended");
        signal?.addEventListener("abort", cancel, { once: true });
        this.timers.set(request.id, setTimeout(cancel, 86_400_000));
        this.changed();
        try {
          await answer;
          if (request.status !== "approved") return result({ status: request.status });
          const job = this.deps.jobs().find((entry) => entry.id === request.jobId);
          return result({ status: "approved", automationId: request.jobId, name: config.name, target: config.target ? "this-thread" : "new-thread", accessLevel: job?.config.accessLevel, enabled: job?.enabled, nextAt: job?.nextAt });
        } finally { signal?.removeEventListener("abort", cancel); }
      },
    }, {
      annotations: { readOnlyHint: true },
      name: LIST_SCHEDULES_TOOL, label: "List this thread's automations",
      description: "List the automations this thread proposed or that continue this thread, and any proposal still waiting for the user.",
      parameters: Type.Object({}),
      execute: async () => result({
        automations: this.deps.jobs().filter(mine).map((job) => ({
          automationId: job.id, name: job.config.name, schedule: job.config.schedule, target: job.config.target?.threadId === session.sessionId ? "this-thread" : "new-thread",
          enabled: job.enabled, status: job.status, nextAt: job.nextAt, accessLevel: job.config.accessLevel, cancellable: job.origin?.threadId === session.sessionId,
        })),
        waiting: this.list().filter((request) => request.threadId === session.sessionId && request.status === "pending").map((request) => ({ name: request.config.name, schedule: request.config.schedule })),
      }),
    }, {
      annotations: { readOnlyHint: false, destructiveHint: true },
      name: CANCEL_SCHEDULE_TOOL, label: "Cancel an automation of this thread",
      description: "Delete an automation this thread proposed (see tau_thread_schedules). Threads it already ran stay. Automations the user made are theirs to change.",
      parameters: Type.Object({ automationId: Type.String() }),
      execute: async (_id: string, input: unknown) => {
        const v = object(input, ["automationId"]);
        await this.deps.cancel(session.sessionId, text(v.automationId, "Automation ID", 36));
        return result({ status: "deleted", automationId: v.automationId });
      },
    }];
  }

  register(): void {
    const { context } = this;
    context.registerCommand("schedule-requests", () => this.list(), { access: "read" });
    context.registerCommand("approve-schedule", async (input) => {
      const v = object(input, ["id", "turnOn"]);
      const id = text(v.id, "Proposal ID", 36);
      const request = this.requests.get(id);
      if (!request || request.status !== "pending" || request.expiresAt < Date.now()) throw new HostCommandError("This proposal ended.");
      if (this.approving.has(id)) throw new HostCommandError("This proposal is already being approved.");
      this.approving.add(id);
      try {
        const job = await this.deps.create(request.config, { threadId: request.threadId, turnOn: v.turnOn === true });
        request.jobId = job.id;
        // The thread stopped while the job was saved: the automation stays; the user sees it on the page.
        this.finish(id, "approved");
        return structuredClone(job);
      } finally { this.approving.delete(id); }
    }, { access: "owner" });
    context.registerCommand("decline-schedule", (input) => { const v = object(input, ["id"]); this.finish(text(v.id, "Proposal ID", 36), "declined"); return { declined: true }; }, { access: "owner" });
    this.stops.push(context.services.mcp.registerTools((session) => this.tools(session)));
    this.stops.push(context.services.registerRuntimeExtension("tau-thread-schedules", (pi, session) => { for (const tool of this.tools(session)) pi.registerTool(tool); }));
    this.stops.push(context.services.registerThreadLifecycle({ threadDeleted: async (id) => { this.end(id); } }));
  }

  close(): void {
    for (const request of this.requests.values()) this.finish(request.id, "ended");
    for (const stop of this.stops.splice(0)) stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
