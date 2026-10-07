export const SCHEDULING_ID = "tau.scheduling";
export type Schedule = { kind: "once"; at: string } | { kind: "daily"; time: string; timezone: "UTC" } | { kind: "webhook" };
export interface JobConfig {
  name: string;
  workspace: string;
  backend: string;
  prompt: string;
  schedule: Schedule;
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
  webhookUrl?: string;
  webhookProblem?: string;
  secretStore?: string;
  secretRequests: SecretRequest[];
}
