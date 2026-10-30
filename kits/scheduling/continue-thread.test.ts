import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostCommandCall, HostMcpTool, HostMcpToolProvider, HostSessionServices, HostThread, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createSchedulingHostExtension } from "./host.js";
import type { Job, ManagementState, ScheduleRequest } from "./protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

interface Row { id: string; backendKind?: string; machine?: { id: string; name: string }; queued?: unknown[]; queueHeld?: boolean; background?: unknown[] }
async function harness(existing?: string, sendGate?: Promise<void>) {
  const stateDir = existing ?? await mkdtemp(join(tmpdir(), "tau-continue-"));
  if (!existing) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const index: Row[] = [{ id: "t-1", backendKind: "pi" }, { id: "remote~t", backendKind: "machine", machine: { id: "rex", name: "Rex" } }];
  const trash: { sessionId: string }[] = [];
  const busy = new Set<string>();
  const levels = new Map<string, string>();
  const providers: HostMcpToolProvider[] = [];
  const access = vi.fn((input: { threadId: string; level: string | null }, _call: HostCommandCall) => input.level);
  let sends = 0;
  // The host announces the wake's turn as it admits it, before `send` returns.
  const send = vi.fn(async (id: string, _text: string, _options?: unknown) => { observer?.accepted?.(id, `run-turn-${++sends}`, { deferBefore: false }); await sendGate; });
  const start = vi.fn(async () => ({ sessionId: "new-thread", cwd: "/worktree" }));
  let observer: HostTurnObserver | undefined;
  const registry = await activateHostKit(createSchedulingHostExtension(), {
    stateDir, findCommand: () => undefined,
    knownWorkspacePath: async (path) => { if (path !== "/project" && path !== "host:/project") throw new Error("Unknown local workspace"); return "/project"; },
    workspaceRef: (path) => ({ workspaceId: `host:${path}`, displayPath: path }),
    thread: (id) => id && index.some((row) => row.id === id) ? { sessionId: id, backendKind: "pi", isIdle: () => !busy.has(id), entries: () => [] } as unknown as HostThread : undefined,
    sessions: {
      start, send,
      refreshIndex: async () => ({ type: "thread-index", index: { projects: [], sessions: structuredClone(index) } }),
      trash: async () => trash,
    } as unknown as HostSessionServices,
    registerTurnObserver: (value) => { observer = value; return () => { observer = undefined; }; },
    mcp: { registerTools: (value) => { providers.push(value); return () => undefined; }, gate: () => () => undefined, connect: async () => undefined },
  });
  await registry.activate({ id: "tau.workspace", name: "Workspace", activate(context) { context.registerCommand("create-worktree", () => ({ path: "/worktree" }), { callers: ["tau.scheduling"] }); } });
  await registry.activate({ id: "tau.access", name: "Access", activate(context) {
    context.registerCommand("thread-level", access as never, { callers: ["tau.scheduling"] });
    context.registerCommand("thread-level-of", (input) => levels.get((input as { threadId: string }).threadId) ?? "full", { callers: ["tau.scheduling"] });
    context.registerCommand("level", () => "full", { access: "read", callers: ["tau.scheduling"] });
  } });
  cleanups.push(() => registry.deactivate("tau.scheduling"));
  const call = (command: string, input?: unknown) => registry.invoke("tau.scheduling", command, input);
  const manage = () => call("manage") as Promise<ManagementState>;
  const tools = async (sessionId = "t-1") => {
    const all: HostMcpTool[] = [];
    for (const provider of providers) all.push(...await provider({ sessionId, cwd: "/project" }) as HostMcpTool[]);
    return (name: string) => all.find((tool) => tool.name === name)!;
  };
  return { stateDir, index, trash, busy, levels, access, send, start, call, manage, tools, registry,
    prepare: (id: string) => observer?.prepare?.(id, "turn"), end: (id: string, turn = "turn") => observer?.ended?.(id, turn, "completed"), stop: (id: string) => observer?.stopped?.(id),
    accept: (id: string, turn: string) => observer?.accepted?.(id, turn, { deferBefore: false }),
    runEnded: (id: string, outcome: "completed" | "failed" = "completed") => observer?.runEnded?.(id, outcome) };
}
const config = { name: "Nightly cleanup", workspace: "/project", backend: "pi", prompt: "Continue the cleanup.", accessLevel: "ask", schedule: { kind: "daily", time: "21:00", timezone: "UTC" }, target: { kind: "thread", threadId: "t-1" } };
const run = async (h: Awaited<ReturnType<typeof harness>>) => {
  const job = await h.call("create", config) as Job;
  await h.call("set-enabled", { enabled: true });
  return job;
};

it("sends each run into the same local thread as a wake, under the job's ceiling from before the message until the run ends", async () => {
  const h = await harness();
  const job = await run(h);
  expect(job.config.target).toEqual({ kind: "thread", threadId: "t-1" });
  await expect(h.call("run", { id: job.id })).resolves.toMatchObject({ status: "running", lastRun: { threadId: "t-1", outcome: "running" } });
  expect(h.start).not.toHaveBeenCalled();
  expect(h.send).toHaveBeenCalledExactlyOnceWith("t-1", "Continue the cleanup.", { delivery: "queue", wake: { source: "automation", label: "Nightly cleanup" } });
  expect(h.access).toHaveBeenCalledWith({ threadId: "t-1", level: "ask" }, expect.objectContaining({ extension: "tau.scheduling" }));
  expect(h.access.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]!);
  // Every turn of the run sets it again, so a rebuilt runtime cannot escape it.
  h.access.mockClear();
  await h.prepare("t-1");
  expect(h.access).toHaveBeenCalledWith({ threadId: "t-1", level: "ask" }, expect.anything());
  h.access.mockClear();
  await h.end("t-1", "run-turn-1");
  h.runEnded("t-1");
  await vi.waitFor(async () => expect(await h.manage()).toMatchObject({ jobs: [{ status: "completed", lastRun: { threadId: "t-1", outcome: "completed" } }] }));
  expect(h.access).toHaveBeenCalledExactlyOnceWith({ threadId: "t-1", level: null }, expect.anything());
  // The user's own later turns run at the thread's own level again.
  h.access.mockClear();
  await h.prepare("t-1");
  expect(h.access).not.toHaveBeenCalled();
  await h.call("run", { id: job.id });
  expect(h.send).toHaveBeenCalledTimes(2);
});

it("holds a run while the thread is busy or has queued messages, then runs it on a decision", async () => {
  const h = await harness();
  const job = await run(h);
  h.busy.add("t-1");
  await expect(h.call("run", { id: job.id })).rejects.toThrow("still running");
  expect(await h.manage()).toMatchObject({ jobs: [{ status: "held", detail: "The thread is still running or has queued messages." }] });
  h.busy.delete("t-1");
  h.index[0]!.queued = [{ id: "q" }];
  await expect(h.call("resolve", { id: job.id, decision: "run" })).rejects.toThrow("queued");
  h.index[0]!.queued = undefined;
  await expect(h.call("resolve", { id: job.id, decision: "run" })).resolves.toMatchObject({ status: "running" });
  expect(h.send).toHaveBeenCalledOnce();
});

it("fails clearly when the continued thread was deleted or sits in the trash, without sending", async () => {
  const h = await harness();
  const job = await run(h);
  h.index.splice(0, 1);
  h.trash.push({ sessionId: "t-1" });
  await expect(h.call("run", { id: job.id })).rejects.toThrow("in the trash");
  expect(await h.manage()).toMatchObject({ jobs: [{ status: "failed", detail: expect.stringContaining("in the trash") }] });
  await h.call("resolve", { id: job.id, decision: "skip" });
  h.trash.splice(0);
  await expect(h.call("run", { id: job.id })).rejects.toThrow("was deleted");
  expect(h.send).not.toHaveBeenCalled();
});

it("continues only threads on this machine", async () => {
  const h = await harness();
  await expect(h.call("create", { ...config, target: { kind: "thread", threadId: "remote~t" } })).rejects.toThrow("another machine");
  await expect(h.call("create", { ...config, target: { kind: "thread", threadId: "unknown" } })).rejects.toThrow("Unknown thread");
  await expect(h.call("create", { ...config, target: { kind: "new-thread" } })).rejects.toThrow();
  expect((await h.manage()).jobs).toEqual([]);
});

it("lets the thread's agent propose a schedule that exists only after the owner approves, clamped to the thread's level", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  const h = await harness();
  h.levels.set("t-1", "ask");
  const tool = (await h.tools())("tau_schedule_thread");
  const answer = tool.execute("call", { prompt: "Continue the cleanup.", reason: "The user asked for it nightly.", daily: "21:00", timezone: "Europe/Berlin", accessLevel: "full" }, undefined, undefined, {} as never);
  let request: ScheduleRequest | undefined;
  await vi.waitFor(async () => { request = (await h.manage()).scheduleRequests![0]!; expect(request).toBeDefined(); });
  expect(request!).toMatchObject({ threadId: "t-1", status: "pending", config: { accessLevel: "ask", target: { kind: "thread", threadId: "t-1" }, schedule: { kind: "cron", expression: "0 21 * * *", timezone: "Europe/Berlin" } } });
  expect((await h.manage()).jobs).toEqual([]);
  const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device" } as const;
  await expect(h.registry.invoke("tau.scheduling", "approve-schedule", { id: request!.id }, phone)).rejects.toMatchObject({ code: "forbidden" });
  // The thread runs lower by the time the owner answers: the automation follows.
  h.levels.set("t-1", "read-only");
  await h.call("approve-schedule", { id: request!.id });
  const result = await answer as { details: { status: string; automationId: string; accessLevel: string } };
  expect(result.details).toMatchObject({ status: "approved", accessLevel: "read-only" });
  expect((await h.manage()).jobs).toEqual([expect.objectContaining({ id: result.details.automationId, enabled: true, origin: { threadId: "t-1" }, config: expect.objectContaining({ accessLevel: "read-only" }), nextAt: "2026-10-30T20:00:00.000Z" })]);
  expect((await h.manage()).enabled).toBe(false);

  const listed = await (await h.tools())("tau_thread_schedules").execute("call", {}, undefined, undefined, {} as never) as { details: { automations: unknown[] } };
  expect(listed.details.automations).toEqual([expect.objectContaining({ automationId: result.details.automationId, target: "this-thread", cancellable: true })]);
  await expect((await h.tools("other"))("tau_cancel_thread_schedule").execute("call", { automationId: result.details.automationId }, undefined, undefined, {} as never)).rejects.toThrow("this thread proposed");
  await (await h.tools())("tau_cancel_thread_schedule").execute("call", { automationId: result.details.automationId }, undefined, undefined, {} as never);
  expect((await h.manage()).jobs).toEqual([]);
});

it("answers a declined or stopped proposal without creating anything, and never proposes above read-only", async () => {
  const h = await harness();
  const tool = (await h.tools())("tau_schedule_thread");
  const declined = tool.execute("call", { prompt: "Check CI", reason: "Nightly check", cron: "0 9 * * 1-5", target: "new-thread" }, undefined, undefined, {} as never);
  let id: string | undefined;
  await vi.waitFor(async () => { id = (await h.manage()).scheduleRequests![0]?.id; expect(id).toBeDefined(); });
  expect((await h.manage()).scheduleRequests![0]!.config.target).toBeUndefined();
  await expect(tool.execute("call", { prompt: "Again", reason: "x", daily: "09:00" }, undefined, undefined, {} as never)).rejects.toThrow("already waiting");
  await h.call("decline-schedule", { id });
  expect(await declined).toMatchObject({ details: { status: "declined" } });
  const stopped = tool.execute("call", { prompt: "Check CI", reason: "Nightly check", daily: "09:00", timezone: "UTC" }, undefined, undefined, {} as never);
  await vi.waitFor(async () => expect((await h.manage()).scheduleRequests!.some((request) => request.status === "pending")).toBe(true));
  expect(await h.stop("t-1")).toEqual(["ended the automation proposal"]);
  expect(await stopped).toMatchObject({ details: { status: "ended" } });
  await expect(tool.execute("call", { prompt: "x", reason: "y", daily: "09:00", once: "2030-01-01T00:00:00Z" }, undefined, undefined, {} as never)).rejects.toThrow("exactly one");
  await expect(tool.execute("call", { prompt: "x", reason: "y", once: "2020-01-01T00:00:00Z" }, undefined, undefined, {} as never)).rejects.toThrow("future");
  expect((await h.manage()).jobs).toEqual([]);
});

it("refuses to propose anything when the thread's level cannot be read", async () => {
  const h = await harness();
  await h.registry.deactivate("tau.access");
  await expect((await h.tools())("tau_schedule_thread").execute("call", { prompt: "x", reason: "y", daily: "09:00" }, undefined, undefined, {} as never)).rejects.toThrow();
  expect((await h.manage()).scheduleRequests).toEqual([]);
});

it("keeps the ceiling on an interrupted run's thread after a restart until the user resolves it", async () => {
  const first = await harness(undefined, new Promise<void>(() => undefined));
  const job = await run(first);
  void first.call("run", { id: job.id }).catch(() => undefined);
  await vi.waitFor(() => expect(first.send).toHaveBeenCalled());
  await first.registry.deactivate("tau.scheduling");
  const h = await harness(first.stateDir);
  expect(await h.manage()).toMatchObject({ jobs: [{ status: "uncertain", lastRun: { threadId: "t-1" } }] });
  await h.prepare("t-1");
  expect(h.access).toHaveBeenCalledWith({ threadId: "t-1", level: "ask" }, expect.anything());
  h.access.mockClear();
  await h.call("resolve", { id: job.id, decision: "skip" });
  expect(h.access).toHaveBeenCalledExactlyOnceWith({ threadId: "t-1", level: null }, expect.anything());
});

it("keeps the ceiling through the run's later automatic turns until the thread is quiet", async () => {
  const h = await harness();
  const job = await run(h);
  await h.call("run", { id: job.id });
  // The run's own turn ends while background work it started still runs.
  h.index[0]!.background = [{ id: "build" }];
  h.access.mockClear();
  await h.end("t-1", "run-turn-1");
  h.runEnded("t-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await h.manage()).toMatchObject({ jobs: [{ status: "running" }] });
  expect(h.access).not.toHaveBeenCalledWith({ threadId: "t-1", level: null }, expect.anything());
  // The background work wakes the thread: that turn is still held to the automation's level.
  h.accept("t-1", "background-wake");
  await h.prepare("t-1");
  expect(h.access).toHaveBeenCalledWith({ threadId: "t-1", level: "ask" }, expect.anything());
  await h.end("t-1", "background-wake");
  h.index[0]!.background = [];
  h.access.mockClear();
  h.runEnded("t-1");
  await vi.waitFor(async () => expect(await h.manage()).toMatchObject({ jobs: [{ status: "completed" }] }));
  expect(h.access).toHaveBeenCalledExactlyOnceWith({ threadId: "t-1", level: null }, expect.anything());
});

it("keeps the ceiling on a continued thread whose run failed until the owner resolves it", async () => {
  const h = await harness();
  const job = await run(h);
  await h.call("run", { id: job.id });
  h.access.mockClear();
  h.runEnded("t-1", "failed");
  await vi.waitFor(async () => expect(await h.manage()).toMatchObject({ jobs: [{ status: "failed" }] }));
  expect(h.access).not.toHaveBeenCalledWith({ threadId: "t-1", level: null }, expect.anything());
  await h.prepare("t-1");
  expect(h.access).toHaveBeenCalledWith({ threadId: "t-1", level: "ask" }, expect.anything());
  h.access.mockClear();
  await h.call("resolve", { id: job.id, decision: "skip" });
  expect(h.access).toHaveBeenCalledExactlyOnceWith({ threadId: "t-1", level: null }, expect.anything());
});
