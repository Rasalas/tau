import { expect, it } from "vitest";
import type { Job } from "./protocol.js";
import { scheduleText, statusText } from "./job-summary.js";

it("summarizes bursts, fixed waits and completed delivery counts without payload data", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const schedule = { kind: "webhook" as const, filters: [{ path: "labels[].name", op: "exists" as const }, { path: "action", op: "equals" as const, value: "closed" }], coalescing: { keyPath: "issue.id", waitSeconds: 120 } };
  const job: Job = { id: "job", workspaceId: "workspace", enabled: true, status: "ready", config: { name: "Check", prompt: "Inspect", workspace: "/project", backend: "pi", workspaceStrategy: "worktree", maxDurationMinutes: 60, schedule }, webhookBursts: [{ id: "window", at: new Date(now).toISOString(), dueAt: new Date(now + 102_000).toISOString(), count: 3 }] };
  expect(scheduleText(schedule)).toBe("Signed webhook · 2 payload filters · combines bursts (2 min)");
  expect(statusText(job, now)).toBe("Combining 3 deliveries · starts in 1:42");
  expect(statusText(job, now + 200_000)).toBe("Combining 3 deliveries · starts in 0:00");
  job.webhookBursts = undefined; job.status = "completed";
  job.lastRun = { intentId: "intent", at: new Date(now).toISOString(), outcome: "completed", webhookBurstId: "window", deliveryCount: 4 };
  expect(statusText(job, now)).toContain("finished · combined 4 deliveries");
});
