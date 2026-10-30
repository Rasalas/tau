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
  const abort = vi.fn(async (id: string) => { busyThreads.delete(id); await observer?.ended?.(id, "turn", "completed"); });
  const access = vi.fn(() => "read-only");
  const defaultAccess = vi.fn(() => "full");
  const createWorktree = vi.fn(() => ({ path: "/worktree" }));
  const records = new Map<string, unknown[]>();
  let observer: HostTurnObserver | undefined;
  const registry = await activateHostKit(createSchedulingHostExtension(), {
    stateDir,
    findCommand: () => undefined,
    thread: (id) => id ? { isIdle: () => !busyThreads.has(id), entries: () => records.get(id) ?? [] } as unknown as HostThread : undefined,
    sessions: { abort, start: start ?? (async (options: HostThreadStartOptions) => {
      const sessionId = `thread-${threads.length + 1}`;
      await options.beforePrompt?.({ sessionId, appendEntry: (customType: string, data: unknown) => records.set(sessionId, [{ type: "custom", customType, data }]) } as unknown as HostThread);
      threads.push(options);
      return { sessionId, cwd: options.cwd };
    }) } as unknown as HostSessionServices,
    registerTurnObserver: (value) => { observer = value; return () => { observer = undefined; }; },
    knownWorkspacePath: async (path) => { if (path !== "/project" && path !== `${host}:/project`) throw new Error("Unknown local workspace"); return "/project"; },
    workspaceRef: (path) => ({ workspaceId: `${host}:${path}`, displayPath: path }),
  });
  await registry.activate({ id: "tau.workspace", name: "Workspace", activate(context) { context.registerCommand("create-worktree", createWorktree, { callers: ["tau.scheduling"] }); } });
  await registry.activate({ id: "tau.access", name: "Access", activate(context) { context.registerCommand("thread-level", access, { callers: ["tau.scheduling"] }); context.registerCommand("level", defaultAccess, { access: "read", callers: ["tau.scheduling"] }); } });
  cleanups.push(() => registry.deactivate("tau.scheduling"));
  return { stateDir, registry, threads, busyThreads, abort, access, defaultAccess, createWorktree, prepare: (id: string) => observer?.prepare?.(id, "turn"), end: (id: string, outcome: "completed" | "failed" = "completed") => observer?.ended?.(id, "turn", outcome), call: (command: string, input?: unknown) => registry.invoke("tau.scheduling", command, input) };
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
    { ...config, workspaceStrategy: "shared" }, { ...config, accessLevel: "unknown" },
    ...[0, -1, 1.5, 1441, "60"].map((maxDurationMinutes) => ({ ...config, maxDurationMinutes })),
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
  expect(h.threads).toEqual([expect.objectContaining({ cwd: "/worktree", backend: "codex@work", title: "Scheduled: Daily check", prompt: config.prompt })]);
  await vi.waitFor(async () => expect(h.call("run", { id: job.id })).rejects.toThrow("already running"));
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
it("records a refused start and requires an explicit retry", async () => {
  let release!: () => void;
  const h = await harness(undefined, async () => { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("Runtime unavailable"); });
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true });
  const pending = h.call("run", { id: job.id });
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "starting" }] }));
  release(); await pending;
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "failed", lastRun: { detail: "Error: Runtime unavailable", outcome: "failed" } }] });
  await expect(h.call("run", { id: job.id })).rejects.toThrow("Resolve");
});
it("queues mutations behind a pending start and keeps a timer that fired on time from being held", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:59:00Z"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const h = await harness(undefined, async (options) => { const n = ++starts; if (n === 1) await gate; return { sessionId: `thread-${n}`, cwd: options.cwd }; });
  const manual = await h.call("create", config) as { id: string };
  const daily = await h.call("create", config) as { id: string };
  const removed = await h.call("create", config) as { id: string };
  await h.call("enable", { id: daily.id }); await h.call("set-enabled", { enabled: true });
  const pending = h.call("run", { id: manual.id });
  await vi.waitFor(async () => expect((await h.call("list") as { jobs: { status: string }[] }).jobs[0]).toMatchObject({ status: "starting" }));
  const deleting = h.call("delete", { id: removed.id });
  await vi.advanceTimersByTimeAsync(3 * 60_000);
  expect(starts).toBe(1);
  release();
  await expect(pending).resolves.toMatchObject({ status: "running" });
  await expect(deleting).resolves.toMatchObject({ id: removed.id });
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ id: manual.id, status: "running" }, { id: daily.id, status: "running", lastRun: { threadId: "thread-2" } }] }));
  expect(starts).toBe(2);
});

it("refuses a second scheduler over the same host state instead of duplicating work", async () => {
  const first = await harness();
  const second = await harness(first.stateDir);
  expect(second.registry.isActive("tau.scheduling")).toBe(false);
  expect(first.registry.isActive("tau.scheduling")).toBe(true);
});

it("starts a run on time after the computer sleeps and holds one it slept through when it wakes", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("enable", { id: job.id }); await h.call("set-enabled", { enabled: true });
  // Timers do not advance while the computer sleeps; the wall clock does.
  vi.setSystemTime(new Date("2026-10-03T08:50:00Z"));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "running", nextAt: "2026-10-04T09:00:00.000Z" }] }));
  await h.end("thread-1");
  vi.setSystemTime(new Date("2026-10-04T13:00:00Z"));
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held", nextAt: "2026-10-04T09:00:00.000Z" }] }));
  expect(h.threads).toHaveLength(1);
});
it("does not hold a disabled job and moves it to its next run when enabled again", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T08:00:00Z"));
  const first = await harness();
  const job = await first.call("create", config) as { id: string };
  await first.call("enable", { id: job.id }); await first.call("set-enabled", { enabled: true });
  await first.call("disable", { id: job.id });
  await first.registry.deactivate("tau.scheduling");
  vi.setSystemTime(new Date("2026-10-09T08:00:00Z"));
  const h = await harness(first.stateDir);
  expect(await h.call("list")).toMatchObject({ jobs: [{ enabled: false, status: "ready" }] });
  await h.call("set-enabled", { enabled: false }); await h.call("set-enabled", { enabled: true });
  await h.call("run", { id: job.id });
  vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
  await h.end("thread-1");
  expect(await h.call("list")).toMatchObject({ jobs: [{ enabled: false, status: "completed", nextAt: "2026-10-09T09:00:00.000Z" }] });
  await expect(h.call("enable", { id: job.id })).resolves.toMatchObject({ enabled: true, status: "completed", nextAt: "2026-10-10T09:00:00.000Z" });
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


it("defaults to an isolated worktree and applies persisted new-thread access before admission", async () => {
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  expect(job).toMatchObject({ config: { workspaceStrategy: "worktree", accessLevel: "full", maxDurationMinutes: 60 } });
  await h.call("set-enabled", { enabled: true });
  await h.call("run", { id: job.id });
  expect(h.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ workspace: "host-a:/project", branch: expect.stringMatching(/^scheduled\//u), startFromOrigin: false }), expect.anything());
  expect(h.threads[0]?.cwd).toBe("/worktree");
  expect(h.access).toHaveBeenCalledWith({ threadId: "thread-1", level: "full" }, expect.anything());
  h.access.mockClear();
  await h.prepare("thread-1");
  expect(h.access).toHaveBeenCalledWith({ threadId: "thread-1", level: "full" }, expect.anything());
});

it("persists explicit checkout, access and duration choices", async () => {
  const h = await harness();
  const custom = { ...config, workspaceStrategy: "current", accessLevel: "ask", maxDurationMinutes: 5 };
  const job = await h.call("create", custom) as { id: string };
  await h.call("set-enabled", { enabled: true });
  await h.call("run", { id: job.id });
  expect(h.createWorktree).not.toHaveBeenCalled();
  expect(h.threads[0]?.cwd).toBe("/project");
  expect(h.access).toHaveBeenCalledWith({ threadId: "thread-1", level: "ask" }, expect.anything());
  await h.registry.deactivate("tau.scheduling");
  const restored = await harness(h.stateDir);
  expect(await restored.call("list")).toMatchObject({ jobs: [{ config: custom }] });
});

it.each(["tau.workspace", "tau.access"])("refuses admission when %s is unavailable", async (kit) => {
  const h = await harness();
  const job = await h.call("create", config) as { id: string };
  await h.call("set-enabled", { enabled: true });
  await h.registry.deactivate(kit);
  expect(await h.call("run", { id: job.id })).toMatchObject({ status: "failed" });
  expect(h.threads).toEqual([]);
});

it("stops an overdue run even with automations off, preserves the timeout through abort events and permits explicit recovery", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, maxDurationMinutes: 1 }) as { id: string };
  await h.call("set-enabled", { enabled: true }); await h.call("run", { id: job.id });
  h.busyThreads.add("thread-1");
  await h.call("set-enabled", { enabled: false });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(h.abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "failed", lastRun: { outcome: "failed", detail: expect.stringContaining("Maximum duration") } }] }));
  expect(h.abort).toHaveBeenCalledExactlyOnceWith("thread-1");
  await h.call("resolve", { id: job.id, decision: "skip" });
  await h.call("set-enabled", { enabled: true }); await h.call("run", { id: job.id });
  await h.end("thread-2");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.abort).toHaveBeenCalledTimes(1);
});

it("stops an overdue scheduled run promptly after sleep even with automations off", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, maxDurationMinutes: 60 }) as { id: string };
  await h.call("set-enabled", { enabled: true }); await h.call("run", { id: job.id });
  h.busyThreads.add("thread-1");
  await h.call("set-enabled", { enabled: false });
  // Sleep advances the wall clock without running timer callbacks.
  vi.setSystemTime(new Date("2026-10-03T10:00:00Z"));
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "failed", lastRun: { outcome: "failed" } }] }));
  expect(h.abort).toHaveBeenCalledExactlyOnceWith("thread-1");
});

it("rechecks the deadline instead of stopping early when the clock moves backward", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, maxDurationMinutes: 1 }) as { id: string };
  await h.call("set-enabled", { enabled: true }); await h.call("run", { id: job.id });
  vi.setSystemTime(new Date("2026-10-03T07:59:00Z"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(h.abort).toHaveBeenCalledExactlyOnceWith("thread-1"));
});


it.each(["full", "ask", "auto", "read-only"])("reads and saves the new-thread default %s when no access level was chosen", async (level) => {
  const h = await harness();
  h.defaultAccess.mockReturnValue(level);
  expect(await h.call("manage")).toMatchObject({ defaultAccessLevel: level });
  const job = await h.call("create", config) as { id: string };
  expect(job).toMatchObject({ config: { accessLevel: level, workspaceStrategy: "worktree", maxDurationMinutes: 60 } });
  expect(h.defaultAccess).toHaveBeenCalled();
  h.defaultAccess.mockReturnValue(level === "full" ? "ask" : "full");
  await h.call("set-enabled", { enabled: true });
  await h.call("run", { id: job.id });
  expect(h.access).toHaveBeenCalledWith({ threadId: "thread-1", level }, expect.anything());
});

it("keeps an explicit access choice instead of reading the default", async () => {
  const h = await harness();
  h.defaultAccess.mockReturnValue("ask");
  const job = await h.call("create", { ...config, accessLevel: "read-only" }) as { id: string };
  expect(h.defaultAccess).not.toHaveBeenCalled();
  expect(job).toMatchObject({ config: { accessLevel: "read-only" } });
  await h.call("update", { id: job.id, config });
  expect(await h.call("list")).toMatchObject({ jobs: [{ config: { accessLevel: "ask" } }] });
});

it("does not invent a default if the Access kit cannot be read", async () => {
  const h = await harness();
  await h.registry.deactivate("tau.access");
  expect(await h.call("manage")).toMatchObject({ defaultAccessLevel: undefined });
  await expect(h.call("create", config)).rejects.toThrow();
  expect(await h.call("list")).toEqual({ enabled: false, jobs: [] });
});

it("resolves missing access on older records through the Access kit before admission", async () => {
  const first = await harness();
  const job = await first.call("create", config) as { id: string };
  await first.registry.deactivate("tau.scheduling");
  await writeFile(join(first.stateDir, "tau.scheduling", "jobs.json"), JSON.stringify({ version: 1, enabled: true, jobs: [{ ...job, config }] }));
  const h = await harness(first.stateDir);
  h.defaultAccess.mockReturnValue("auto");
  await h.call("run", { id: job.id });
  expect(h.access).toHaveBeenCalledWith({ threadId: "thread-1", level: "auto" }, expect.anything());
  expect(await h.call("list")).toMatchObject({ jobs: [{ config: { accessLevel: "auto" } }] });
});

it("repeats a cron schedule in its own time zone and holds a missed occurrence like a daily one", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
  const h = await harness();
  for (const invalid of [
    { ...config, schedule: { kind: "cron", expression: "0 9 * *", timezone: "Europe/Berlin" } },
    { ...config, schedule: { kind: "cron", expression: "0 9 * * 1", timezone: "Mars/Olympus" } },
    { ...config, schedule: { kind: "cron", expression: "0 9 * * 1" } },
    { ...config, schedule: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC", time: "09:00" } },
    { ...config, schedule: { kind: "cron", expression: "1,".repeat(120), timezone: "UTC" } },
  ]) await expect(h.call("create", invalid)).rejects.toThrow();
  await expect(h.call("create", { ...config, schedule: { kind: "cron", expression: "0 9 * * 9", timezone: "UTC" } })).rejects.toThrow('day of week field "9"');
  // Wednesday 10:00 in Berlin: Friday 09:00 CEST is next, then 09:30.
  const job = await h.call("create", { ...config, schedule: { kind: "cron", expression: " 0,30  9 * * 1,3,5", timezone: "Europe/Berlin" } }) as { id: string };
  expect(job).toMatchObject({ config: { schedule: { kind: "cron", expression: "0,30 9 * * 1,3,5", timezone: "Europe/Berlin" } }, nextAt: "2026-10-16T07:00:00.000Z" });
  await h.call("enable", { id: job.id }); await h.call("set-enabled", { enabled: true });
  await vi.advanceTimersByTimeAsync(47 * 3_600_000);
  await vi.waitFor(async () => expect(await h.call("list")).toMatchObject({ jobs: [{ status: "running", nextAt: "2026-10-16T07:30:00.000Z" }] }));
  expect(h.threads).toHaveLength(1);
  // The turn outlives 09:30, so that occurrence is held, not replayed.
  await vi.advanceTimersByTimeAsync(45 * 60_000);
  await h.end("thread-1");
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "held", nextAt: "2026-10-16T07:30:00.000Z" }] });
  expect(h.threads).toHaveLength(1);
  // Skipping moves to the next future occurrence, after the clocks went back: 09:00 CET.
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  await h.call("resolve", { id: job.id, decision: "skip" });
  expect(await h.call("list")).toMatchObject({ jobs: [{ status: "ready", enabled: true, nextAt: "2026-10-30T08:00:00.000Z" }] });
});

it("leaves a cron schedule that never matches without a next run", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
  const h = await harness();
  const job = await h.call("create", { ...config, schedule: { kind: "cron", expression: "0 0 30 2 *", timezone: "UTC" } }) as { nextAt?: string };
  expect(job.nextAt).toBeUndefined();
});
