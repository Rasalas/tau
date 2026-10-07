import { HostCommandError } from "tau/host-extension";
import type { JobConfig } from "./protocol.js";

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
export function decodeConfig(input: unknown): JobConfig {
  const v = object(input, ["name", "workspace", "backend", "prompt", "schedule"]);
  const name = text(v.name, "Name", 120);
  const workspace = text(v.workspace, "Local workspace", 4096);
  const backend = text(v.backend, "Runtime backend", 128);
  if (!/^[a-z0-9][a-z0-9@._-]*$/u.test(backend) || backend === "machine" || backend.startsWith("machine@")) throw new HostCommandError("Select a local runtime backend.");
  const prompt = text(v.prompt, "Prompt", 16_384);
  const s = object(v.schedule, ["kind", "at", "time", "timezone"]);
  if (s.kind === "webhook") {
    object(s, ["kind"]);
    return { name, workspace, backend, prompt, schedule: { kind: "webhook" } };
  }
  if (s.kind === "once") {
    object(s, ["kind", "at"]);
    return { name, workspace, backend, prompt, schedule: { kind: "once", at: timestamp(s.at) } };
  }
  object(s, ["kind", "time", "timezone"]);
  if (s.kind !== "daily" || s.timezone !== "UTC" || typeof s.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(s.time)) throw new HostCommandError("Daily schedules use HH:mm and timezone UTC only.");
  return { name, workspace, backend, prompt, schedule: { kind: "daily", time: s.time, timezone: "UTC" } };
}
