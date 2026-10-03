export const SCHEDULING_ID = "tau.scheduling";
export type Schedule = { kind: "once"; at: string } | { kind: "daily"; time: string; timezone: "UTC" };
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
}
export interface SchedulingState { enabled: boolean; jobs: Job[] }
