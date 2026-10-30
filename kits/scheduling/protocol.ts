export const SCHEDULING_ID = "tau.scheduling";
export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timezone: "UTC" }
  /** Five-field cron in an IANA zone, the composer's "Repeat": `0 9 * * 1,3,5`, `Europe/Berlin`. */
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "webhook"; format?: WebhookFormat; includePayload?: boolean };
/**
 * How a webhook proves its sender: Tau's own signed headers (default),
 * GitHub's `X-Hub-Signature-256`, Stripe's `Stripe-Signature`, or a shared
 * secret in `Authorization: Bearer` for curl.
 */
export type WebhookFormat = "tau" | "github" | "stripe" | "bearer";
export const WEBHOOK_FORMATS: readonly WebhookFormat[] = ["tau", "github", "stripe", "bearer"];
/** An existing local thread each run continues with a new message, instead of starting a new thread. */
export interface RunTarget { kind: "thread"; threadId: string }
/** Kinds that have a next occurrence after each run. */
export const repeats = (schedule: Schedule) => schedule.kind === "daily" || schedule.kind === "cron";
export type AccessLevel = "read-only" | "ask" | "auto" | "full";
export interface JobConfig {
  workspaceStrategy: "worktree" | "current";
  /** Omitted input adopts the new-thread default; saved jobs keep the resolved level. */
  accessLevel?: AccessLevel;
  maxDurationMinutes: number;
  name: string;
  workspace: string;
  backend: string;
  prompt: string;
  schedule: Schedule;
  /** Absent: a new thread per run. */
  target?: RunTarget;
}
export interface Job {
  id: string;
  config: JobConfig;
  workspaceId: string;
  detail?: string;
  enabled: boolean;
  status: "ready" | "held" | "starting" | "running" | "completed" | "failed" | "uncertain";
  nextAt?: string;
  lastRun?: { intentId: string; at: string; threadId?: string; outcome: string; detail?: string };
  /** A host-owned secret account; never the value. */
  secretRef?: string;
  /** Accepted webhook delivery IDs. Persisted before starting their threads. */
  deliveries?: string[];
  /** The thread whose agent proposed this automation and the owner approved; it may list and cancel it. */
  origin?: { threadId: string };
}
export interface SchedulingState { enabled: boolean; jobs: Job[] }
export interface SecretRequest {
  id: string;
  threadId: string;
  jobId: string;
  label: string;
  reason: string;
  status: "pending" | "saved" | "declined" | "ended";
  expiresAt: number;
}
export interface ManagementState extends SchedulingState {
  canManage: boolean;
  defaultAccessLevel?: AccessLevel;
  webhookUrl?: string;
  webhookProblem?: string;
  secretStore?: string;
  secretRequests: SecretRequest[];
  /** Absent from a host older than agent-proposed automations. */
  scheduleRequests?: ScheduleRequest[];
}
/** An agent's proposal for an automation, waiting for the owner. */
export interface ScheduleRequest {
  id: string;
  threadId: string;
  config: JobConfig;
  /** Why the agent wants it, in its words. */
  reason: string;
  status: "pending" | "approved" | "declined" | "ended";
  expiresAt: number;
  jobId?: string;
}
