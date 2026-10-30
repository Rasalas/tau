import { HostCommandError } from "tau/host-extension";
import { CRON_MAX_LENGTH, knownTimeZone, parseCron } from "./cron.js";
import { WEBHOOK_FORMATS, type AccessLevel, type JobConfig, type RunTarget, type WebhookFormat } from "./protocol.js";

export function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new HostCommandError("Invalid scheduling input.");
  return input as Record<string, unknown>;
}
export function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new HostCommandError(`${name} must be nonempty and at most ${max} characters.`);
  return value;
}
export function timestamp(value: unknown): string {
  const at = text(value, "UTC timestamp", 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at.replace(/Z$/u, at.length === 20 ? ".000Z" : "Z")) throw new HostCommandError("Use a valid UTC timestamp, YYYY-MM-DDTHH:mm:ssZ.");
  return new Date(at).toISOString();
}
export function decodeAccessLevel(value: unknown): AccessLevel {
  if (value !== "read-only" && value !== "ask" && value !== "auto" && value !== "full") throw new HostCommandError("Invalid access level.");
  return value;
}
/** A thread ID as the index names a local one; a machine's composite ID is refused later, by locality. */
export function decodeTarget(input: unknown): RunTarget | undefined {
  if (input === undefined) return undefined;
  const v = object(input, ["kind", "threadId"]);
  const threadId = text(v.threadId, "Thread ID", 256);
  if (v.kind !== "thread" || !/^[A-Za-z0-9._:~-]+$/u.test(threadId)) throw new HostCommandError("Continue an existing thread by its ID.");
  return { kind: "thread", threadId };
}
export function decodeConfig(input: unknown): JobConfig {
  const v = object(input, ["name", "workspace", "backend", "prompt", "schedule", "workspaceStrategy", "accessLevel", "maxDurationMinutes", "target"]);
  const target = decodeTarget(v.target);
  const workspaceStrategy = v.workspaceStrategy === undefined ? "worktree" : v.workspaceStrategy;
  const accessLevel = v.accessLevel === undefined ? undefined : decodeAccessLevel(v.accessLevel);
  const maxDurationMinutes = v.maxDurationMinutes === undefined ? 60 : v.maxDurationMinutes;
  if (workspaceStrategy !== "worktree" && workspaceStrategy !== "current") throw new HostCommandError("Workspace strategy must be worktree or current.");
  if (typeof maxDurationMinutes !== "number" || !Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 1 || maxDurationMinutes > 1440) throw new HostCommandError("Maximum duration must be 1 to 1440 minutes.");
  const execution = { workspaceStrategy, accessLevel, maxDurationMinutes, ...(target ? { target } : {}) } as Pick<JobConfig, "workspaceStrategy" | "accessLevel" | "maxDurationMinutes" | "target">;
  const name = text(v.name, "Name", 120);
  const workspace = text(v.workspace, "Local workspace", 4096);
  const backend = text(v.backend, "Runtime backend", 128);
  if (!/^[a-z0-9][a-z0-9@._-]*$/u.test(backend) || backend === "machine" || backend.startsWith("machine@")) throw new HostCommandError("Select a local runtime backend.");
  const prompt = text(v.prompt, "Prompt", 16_384);
  const s = object(v.schedule, ["kind", "at", "time", "timezone", "expression", "format", "includePayload"]);
  if (s.kind === "webhook") {
    object(s, ["kind", "format", "includePayload"]);
    if (s.format !== undefined && !WEBHOOK_FORMATS.includes(s.format as WebhookFormat)) throw new HostCommandError("Webhook format must be tau, github, stripe or bearer.");
    if (s.includePayload !== undefined && typeof s.includePayload !== "boolean") throw new HostCommandError("includePayload must be a boolean.");
    const format = s.format as WebhookFormat | undefined;
    return { ...execution, name, workspace, backend, prompt, schedule: { kind: "webhook", ...(format && format !== "tau" ? { format } : {}), ...(s.includePayload === true ? { includePayload: true } : {}) } };
  }
  if (s.kind === "once") {
    object(s, ["kind", "at"]);
    return { ...execution, name, workspace, backend, prompt, schedule: { kind: "once", at: timestamp(s.at) } };
  }
  if (s.kind === "cron") {
    object(s, ["kind", "expression", "timezone"]);
    const timezone = text(s.timezone, "Time zone", 64);
    if (!knownTimeZone(timezone)) throw new HostCommandError(`Unknown time zone ${timezone}. Use an IANA zone such as Europe/Berlin.`);
    let expression: string;
    try { expression = parseCron(text(s.expression, "Cron expression", CRON_MAX_LENGTH)).source; }
    catch (error) { throw error instanceof HostCommandError ? error : new HostCommandError((error as Error).message); }
    return { ...execution, name, workspace, backend, prompt, schedule: { kind: "cron", expression, timezone } };
  }
  object(s, ["kind", "time", "timezone"]);
  if (s.kind !== "daily" || s.timezone !== "UTC" || typeof s.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(s.time)) throw new HostCommandError("Daily schedules use HH:mm and timezone UTC only.");
  return { ...execution, name, workspace, backend, prompt, schedule: { kind: "daily", time: s.time, timezone: "UTC" } };
}
