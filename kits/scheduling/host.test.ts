import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSessionServices, HostThread, HostThreadStartOptions, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createSchedulingHostExtension } from "./host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
async function harness(root?: string, start?: HostSessionServices["start"], host = "host-a") {
  const stateDir = root ?? await mkdtemp(join(tmpdir(), "tau-scheduling-"));
  if (!root) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const threads: HostThreadStartOptions[] = [];
  const busyThreads = new Set<string>();
  let observer: HostTurnObserver | undefined;
  const registry = await activateHostKit(createSchedulingHostExtension(), {
    stateDir,
    findCommand: () => undefined,
    thread: (id) => id && busyThreads.has(id) ? { isIdle: () => false } as HostThread : undefined,
    sessions: { start: start ?? (async (options) => { threads.push(options); return { sessionId: `thread-${threads.length}`, cwd: options.cwd }; }) } as HostSessionServices,
    registerTurnObserver: (value) => { observer = value; return () => { observer = undefined; }; },
    knownWorkspacePath: async (path) => { if (path !== "/project" && path !== `${host}:/project`) throw new Error("Unknown local workspace"); return "/project"; },
    workspaceRef: (path) => ({ workspaceId: `${host}:${path}`, displayPath: path }),
  });
  cleanups.push(() => registry.deactivate("tau.scheduling"));
  return { stateDir, registry, threads, busyThreads, end: (id: string, outcome: "completed" | "failed" = "completed") => observer?.ended?.(id, "turn", outcome), call: (command: string, input?: unknown) => registry.invoke("tau.scheduling", command, input) };
}
const config = { name: "Daily check", workspace: "/project", backend: "pi", prompt: "Inspect changes and report. Do not merge or deploy.", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } };
it("starts off and preserves explicit, disabled job configuration across activation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const first = await harness();
  expect(await first.call("list")).toEqual({ enabled: false, jobs: [] });
  const job = await first.call("create", config) as { id: string };
  expect(job).toMatchObject({ config, enabled: false, status: "ready", nextAt: "2026-10-03T09:00:00.000Z" });
  await first.registry.deactivate("tau.scheduling");
  const restored = await harness(first.stateDir);
  expect(await restored.call("list")).toMatchObject({ enabled: false, jobs: [job] });
});
it("validates local configuration, replaces it explicitly, and supports enable/disable/delete", async () => {
  const h = await harness();
  for (const invalid of [
    { ...config, prompt: "" }, { ...config, prompt: "x".repeat(16_385) },
    { ...config, backend: "machine" }, { ...config, workspace: "/unknown" },
    { ...config, machine: "remote" },
    { ...config, schedule: { kind: "daily", time: "25:00", timezone: "UTC" } },
    { ...config, schedule: { kind: "daily", time: "09:00", timezone: "local" } },
    { ...config, schedule: { kind: "once", at: "2026-02-30T09:00:00Z" } },
  ]) await expect(h.call("create", invalid)).rejects.toThrow();
  const job = await h.call("create", config) as { id: string };
  await expect(h.call("enable", { id: job.id })).resolves.toMatchObject({ enabled: true });
  await expect(h.call("disable", { id: job.id })).resolves.toMatchObject({ enabled: false });
  await expect(h.call("update", { id: job.id, config: { ...config, name: "New name" } })).resolves.toMatchObject({ config: { ...config, name: "New name" }, enabled: false });
  await h.call("delete", { id: job.id });
  expect(await h.call("list")).toEqual({ enabled: false, jobs: [] });
  await expect(h.call("enable", { id: job.id })).rejects.toThrow("Unknown job");
});

it("runs one-off prompts as ordinary threads only after explicit opt-in and holds overlap until the turn ends", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, backend: "codex@work", schedule: { kind: "once", at: "2026-10-03T08:01:00Z" } }) as { id: string };
  await h.call("enable", { id: job.id });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.threads).toEqual([]);
  await h.call("set-enabled", { enabled: true });
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "running", lastRun: { threadId: "thread-1", outcome: "running" } }] }));
  expect(h.threads).toEqual([{ cwd: "/project", backend: "codex@work", title: "Scheduled: Daily check", prompt: config.prompt }]);
  await expect(h.call("run", { id: job.id })).rejects.toThrow("already running");
  await h.end("thread-1");
  expect(await h.call("list")).toMatchObject({ jobs: [{ enabled: false, status: "completed", lastRun: { outcome: "completed" } }] });
});

it("holds missed daily runs after restart until the user skips or deliberately runs them", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const first = await harness();
  const job = await first.call("create", config) as { id: string };
  await first.call("enable", { id: job.id }); await first.call("set-enabled", { enabled: true });
  await first.registry.deactivate("tau.scheduling");
  await vi.advanceTimersByTimeAsync(3 * 86_400_000);
  const h = await harness(first.stateDir);
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held", nextAt: "2026-10-03T09:00:00.000Z" }] });
  expect(h.threads).toEqual([]);
  await expect(h.call("run", { id: job.id })).rejects.toThrow("Resolve");
  await h.call("resolve", { id: job.id, decision: "skip" });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "ready", nextAt: "2026-10-06T09:00:00.000Z" }] });
  await vi.advanceTimersByTimeAsync(3_600_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "running" }] }));
});
it("restores an interrupted start as uncertain and never starts it again automatically", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  let finish!: (value: { sessionId: string; cwd: string }) => void;
  const first = await harness(undefined, () => new Promise((resolve) => { finish = resolve; }));
  const job = await first.call("create", config) as { id: string };
  await first.call("set-enabled", { enabled: true });
  const pending = first.call("run", { id: job.id });
  await vi.waitFor(async () => expect(await first.call("list")).toMatchObject({ jobs: [{ status: "starting", lastRun: { outcome: "starting" } }] }));
  await first.registry.deactivate("tau.scheduling");
  const h = await harness(first.stateDir);
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "uncertain", lastRun: { outcome: "uncertain" } }] });
  await expect(h.call("enable", { id: job.id })).rejects.toThrow("Resolve");
  await expect(h.call("resolve", { id: job.id, decision: "run" })).rejects.toThrow("acknowledgeDuplicateRisk");
  finish({ sessionId: "late-thread", cwd: "/project" }); await pending;
  expect(h.threads).toEqual([]);
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "uncertain" }] });
  await h.call("resolve", { id: job.id, decision: "skip" });
});

it("keeps immediate completion visible even when the turn ends before start returns", async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness(undefined, async () => {
    await h.end("quick-thread");
    return { sessionId: "quick-thread", cwd: "/project" };
  });
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true });
  await h.call("run", { id: job.id });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "completed", lastRun: { threadId: "quick-thread", outcome: "completed" } }] });
});
it("holds overdue jobs when enabling and skips missed daily work instead of replaying it", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("enable", { id: job.id });
  await vi.advanceTimersByTimeAsync(86_400_000);
  await h.call("set-enabled", { enabled: true });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held" }] });
  expect(h.threads).toEqual([]);
});
it("records a refused start, requires an explicit retry, and refuses concurrent mutations with a bounded busy error", async () => {
  let release!: () => void;
  const h = await harness(undefined, async () => { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("Runtime unavailable"); });
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true });
  const pending = h.call("run", { id: job.id });
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "starting" }] }));
  await expect(h.call("delete", { id: job.id })).rejects.toThrow("busy");
  release(); await pending;
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "failed", lastRun: { detail: "Error: Runtime unavailable", outcome: "failed" } }] });
  await expect(h.call("run", { id: job.id })).rejects.toThrow("Resolve");
});

it("refuses a second scheduler over the same host state instead of duplicating work", async () => {
  const first = await harness();
  const second = await harness(first.stateDir);
  expect(second.registry.isActive("tau.scheduling")).toBe(false);
  expect(first.registry.isActive("tau.scheduling")).toBe(true);
});

it("does not reassign a persisted workspace to another host with the same path", async () => {
  const first = await harness();
  const job = await first.call("create", config) as { id: string };
  await first.call("set-enabled", { enabled: true });
  await first.registry.deactivate("tau.scheduling");
  const other = await harness(first.stateDir, undefined, "host-b");
  await expect(other.call("run", { id: job.id })).rejects.toThrow("workspace");
  expect(other.threads).toEqual([]);
  expect(await other.call("list")).toMatchObject({ jobs: [{ status: "held", detail: "Error: Unknown local workspace" }] });
});

it("fails closed on malformed persisted jobs instead of overwriting or scheduling them", async () => {
  const first = await harness();
  await first.registry.deactivate("tau.scheduling");
  const folder = join(first.stateDir, "tau.scheduling");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "jobs.json"), JSON.stringify({ version: 1, enabled: true, jobs: [{ id: "bad", config: { ...config, backend: "machine" }, status: "ready", enabled: true }] }));
  const h = await harness(first.stateDir);
  expect(h.registry.isActive("tau.scheduling")).toBe(false);
  expect(h.threads).toEqual([]);
});

it("allows read-only listing but limits every mutation to the owning host", async () => {
  const h = await harness();
  const readonly = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
  const full = { kind: "workbench-client", connection: "phone", pairedClient: "device" } as const;
  expect(await h.registry.invoke("tau.scheduling", "list", undefined, readonly)).toEqual({ enabled: false, jobs: [] });
  for (const command of ["create", "update", "enable", "disable", "delete", "set-enabled", "run", "resolve"]) {
    await expect(h.registry.invoke("tau.scheduling", command, config, full)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.registry.invoke("tau.scheduling", command, config, readonly)).rejects.toMatchObject({ code: "forbidden" });
  }
});
it("cancels future timers on deactivation without creating threads", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("enable", { id: job.id }); await h.call("set-enabled", { enabled: true });
  await h.registry.deactivate("tau.scheduling");
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(h.threads).toEqual([]);
});
it("does not start a thread if its durable intent cannot be written", async () => {
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true });
  const file = join(h.stateDir, "tau.scheduling", "jobs.json");
  await rm(file); await mkdir(file);
  await expect(h.call("run", { id: job.id })).rejects.toThrow();
  expect(h.threads).toEqual([]);
  expect(h.registry.isActive("tau.scheduling")).toBe(false);
});

it("runs a held one-off only after a deliberate recovery decision", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, schedule: { kind: "once", at: "2026-10-02T08:00:00Z" } }) as { id: string };
  await h.call("enable", { id: job.id }); await h.call("set-enabled", { enabled: true });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held" }] });
  await h.call("resolve", { id: job.id, decision: "run" });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "running", enabled: false, lastRun: { threadId: "thread-1" } }] });
  await h.end("thread-1", "failed");
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "failed", lastRun: { outcome: "failed" } }] });
});

it("holds a new run when the user has continued the previous scheduled thread", async () => {
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true }); await h.call("run", { id: job.id }); await h.end("thread-1");
  h.busyThreads.add("thread-1");
  await expect(h.call("run", { id: job.id })).rejects.toThrow("previous thread");
  await expect(h.call("resolve", { id: job.id, decision: "skip" })).rejects.toThrow("previous thread");
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held" }] });
});

it("bounds the persisted file size before accepting more configuration", async () => {
  const h = await harness();
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    try { await h.call("create", { ...config, prompt: "€".repeat(16_384) }); }
    catch (caught) { error = caught; break; }
  }
  expect(String(error)).toContain("2 MiB");
  expect(h.registry.isActive("tau.scheduling")).toBe(true);
  await h.registry.deactivate("tau.scheduling");
  const restored = await harness(h.stateDir);
  expect(restored.registry.isActive("tau.scheduling")).toBe(true);
});
