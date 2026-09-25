import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HostExtension,
  HostExtensionServices,
  HostMachine,
  HostMachineServices,
  HostMcpToolProvider,
  HostThread,
  HostThreadStartOptions,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import type { RemoteThreadLink, RemoteThreadStartInput } from "../remote-work/protocol.js";
import type { AgentGitRunner } from "../workspace/agent-worktrees.js";
import { createAgentsHostExtension, wakeMessage } from "./host.js";
import { AGENTS_HOST_EXTENSION_ID, type AgentMachinesView, type AgentsState } from "./protocol.js";
import { resolveMachine } from "./remote.js";

const made: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const BUSY = new Set(["sending", "starting", "running"]);
const clone = <T>(value: T): T => structuredClone(value);

/**
 * Remote Work's thread service as the Agents Kit sees it: links that go from
 * sending to running to idle when the test says so, and a settle that merges
 * or reports a conflict.
 */
function fakeRemoteWork() {
  const links = new Map<string, RemoteThreadLink>();
  const waiters = new Set<() => void>();
  const started: RemoteThreadStartInput[] = [];
  const settled: Array<{ link: string; how: string; removeThread?: boolean }> = [];
  const sent: Array<{ link: string; text: string; delivery?: string }> = [];
  const aborted: string[] = [];
  const depths = new Map<string, number>();
  let conflict: string[] | undefined;
  let next = 0;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const update = (id: string, change: (link: RemoteThreadLink) => void) => {
    const link = links.get(id)!;
    change(link);
    link.updatedAt = Date.now();
    wake();
    return clone(link);
  };
  const report = (link: RemoteThreadLink, state: NonNullable<RemoteThreadLink["there"]>["state"], turns: number, extra: Partial<NonNullable<RemoteThreadLink["there"]>> = {}) => {
    link.there = { thread: link.thread!, state, turns, updatedAt: Date.now(), epoch: "e", revision: (link.there?.revision ?? 0) + 1, ...extra };
    link.status = state;
  };
  const extension: HostExtension = {
    id: "tau.remote-work",
    name: "Remote Work",
    activate(context) {
      const kits = { callers: ["tau.agents"] };
      const input = (value: unknown) => value as Record<string, unknown>;
      context.registerCommand("thread-start", (value) => {
        const start = value as RemoteThreadStartInput;
        started.push(start);
        next += 1;
        const link: RemoteThreadLink = {
          id: `link-${next}`, machine: "rex-id", machineName: "rex", cwd: start.cwd, root: start.cwd,
          ...(start.title ? { title: start.title } : {}),
          ...(start.parentThreadId ? { parentThreadId: start.parentThreadId } : {}),
          status: "sending", createdAt: Date.now(), updatedAt: Date.now(),
        };
        links.set(link.id, link);
        return clone(link);
      }, { long: true, ...kits });
      context.registerCommand("thread", (value) => {
        const link = links.get(String(input(value).link));
        if (!link) throw new Error(`No thread link ${String(input(value).link)} on this machine.`);
        return clone(link);
      }, { access: "read", ...kits });
      context.registerCommand("threads", (value) => [...links.values()].filter((link) => !input(value).machine || link.machine === input(value).machine).map(clone), { access: "read", ...kits });
      context.registerCommand("thread-wait", (value) => new Promise((resolve) => {
        const id = String(input(value).link);
        const timer = setTimeout(() => { waiters.delete(check); resolve({ reason: "timeout", link: clone(links.get(id)!) }); }, Number(input(value).timeoutMs ?? 30_000));
        function check() {
          const link = links.get(id)!;
          if (BUSY.has(link.status)) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve({ reason: link.status === "offline" ? "offline" : link.status, link: clone(link) });
        }
        waiters.add(check);
        check();
      }), { long: true, access: "read", ...kits });
      context.registerCommand("thread-send", (value) => {
        const { link, text, delivery } = input(value) as { link: string; text: string; delivery?: string };
        sent.push({ link, text, ...(delivery ? { delivery } : {}) });
        return update(link, (entry) => { if (delivery !== "queue") report(entry, "running", entry.there?.turns ?? 0); });
      }, { long: true, ...kits });
      context.registerCommand("thread-abort", (value) => {
        const id = String(input(value).link);
        aborted.push(id);
        return update(id, (entry) => report(entry, "idle", (entry.there?.turns ?? 0) + 1, { outcome: "aborted" }));
      }, { long: true, ...kits });
      context.registerCommand("thread-settle", (value) => {
        const { link, how, removeThread } = input(value) as { link: string; how: string; removeThread?: boolean };
        settled.push({ link, how, ...(removeThread ? { removeThread } : {}) });
        return update(link, (entry) => {
          entry.result = { state: "branch", branch: "tau/rex/one-word", tip: "abc", commits: 1, files: 1, fetchedAt: Date.now() };
          if (how === "apply" && conflict) {
            entry.applied = { state: "conflict", at: Date.now(), files: conflict, detail: "conflicts" };
            return;
          }
          entry.status = "settled";
          entry.settled = { how: how === "apply" ? "applied" : "discarded", at: Date.now(), detail: how === "apply" ? "Merged tau/rex/one-word. The worktree on rex is removed. Its thread there is in rex's trash." : "Let go." };
        });
      }, { long: true, ...kits });
      context.registerCommand("hosted-thread-depth", (value) => {
        const depth = depths.get(String(input(value).thread));
        return depth ? { depth } : {};
      }, { access: "read", ...kits });
    },
  };
  return {
    extension, links, started, settled, sent, aborted, depths,
    conflictOn: (files: string[] | undefined) => { conflict = files; },
    /** The state reached rex and its thread runs. */
    run: (id: string) => update(id, (link) => {
      link.thread = `rex-thread-${id}`;
      link.transfer = `t${id.replace(/\D/gu, "")}`;
      link.worktree = `/rex/worktrees/work/${link.transfer}`;
      // As rex reports it: the last answer stays while a new turn runs.
      report(link, "running", link.there?.turns ?? 0, link.there?.lastMessage ? { lastMessage: link.there.lastMessage } : {});
    }),
    finish: (id: string, text: string, outcome: "completed" | "failed" = "completed") => update(id, (link) => {
      report(link, outcome === "failed" ? "failed" : "idle", (link.there?.turns ?? 0) + 1, { lastMessage: text, outcome, ...(outcome === "failed" ? { error: text } : {}) });
      link.usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, costUsd: 0.002, turns: 1 };
    }),
    ask: (id: string, question: string) => update(id, (link) => report(link, "waiting", link.there?.turns ?? 0, { question })),
    offline: (id: string) => update(id, (link) => { link.status = "offline"; }),
  };
}

/** Machines Kit's automatic choice, as H13 will answer it. */
function fakeMachinesKit(answer: { machine?: string | null; reason: string }): HostExtension {
  return {
    id: "tau.environments",
    name: "Machines",
    activate(context) {
      context.registerCommand("choose-machine", () => answer, { access: "read", callers: ["tau.agents"] });
    },
  };
}

async function bench(options: { setting?: string; cores?: number; rex?: Partial<HostMachine>; extra?: HostExtension[]; linksPath?: string; links?: ReadonlyMap<string, RemoteThreadLink> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tau-agents-remote-"));
  made.push(dir);
  const remoteWork = fakeRemoteWork();
  for (const [id, link] of options.links ?? []) remoteWork.links.set(id, link);
  const observers: HostTurnObserver[] = [];
  const mcp: HostMcpToolProvider[] = [];
  const started: HostThreadStartOptions[] = [];
  const woken: Array<{ sessionId: string; text: string }> = [];
  const idle = new Set(["parent"]);
  const rex: HostMachine = { id: "rex-id", name: "rex", status: "connected", ...options.rex };
  const machines: HostMachineServices = {
    self: { id: "mini-id", name: "mini", version: "0.7.0" },
    list: () => [rex],
    subscribe: () => () => undefined,
    call: async () => { throw new Error("the agents kit calls no machine itself"); },
    request: async (_machine, method) => {
      if (method !== "host-resources") throw new Error("unknown-method");
      return { cpuCount: options.cores ?? 2, totalMemory: 8e9, availableMemory: 4e9, runningTurns: 0, sampledAt: Date.now() };
    },
    watch: () => () => undefined,
    upload: async () => { throw new Error("no uploads"); },
  };
  const thread = (sessionId: string): HostThread => ({
    sessionId, cwd: "/project", backendKind: "pi", sessionFile: `/sessions/${sessionId}.jsonl`,
    isStreaming: () => !idle.has(sessionId), isIdle: () => idle.has(sessionId), waitForIdle: async () => undefined,
    transcript: async () => [], entries: () => [], appendEntry: () => undefined,
  }) as unknown as HostThread;
  const services: Partial<HostExtensionServices> = {
    stateDir: join(dir, "state"),
    machines,
    settings: async () => ({ options: {}, values: (options.setting ? { machine: options.setting } : {}) as Record<string, string> }),
    thread: (sessionId?: string) => (sessionId === "parent" || started.some((_, index) => sessionId === `local-${index + 1}`) ? thread(sessionId!) : undefined),
    noteSubprocess: () => undefined,
    sessions: {
      list: async () => [{ sessionId: "parent", path: "/sessions/parent.jsonl", cwd: "/project" }],
      start: async (start: HostThreadStartOptions) => { started.push(start); return { sessionId: `local-${started.length}`, cwd: start.cwd }; },
      send: async (sessionId: string, text: string) => { woken.push({ sessionId, text }); },
      abort: async () => undefined,
    } as unknown as HostExtensionServices["sessions"],
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    mcp: { registerTools: (provider) => { mcp.push(provider); return () => undefined; }, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined },
  };
  const runGit: AgentGitRunner = async (_cwd, args) => (args[0] === "rev-parse" ? "true\n" : "");
  const linksPath = options.linksPath ?? join(dir, "links.json");
  const registry = await activateHostKit(remoteWork.extension, services);
  closers.push(() => registry.dispose());
  for (const extension of options.extra ?? []) await registry.activate(extension);
  await registry.activate(createAgentsHostExtension({ settingsPath: join(dir, "none.json"), linksPath, runGit, remotePollMs: 20 }));
  const tools = (sessionId = "parent") => mcp.flatMap((provider) => provider({ sessionId, cwd: "/project" }));
  const call = async (name: string, params: unknown = {}, sessionId = "parent") => {
    const tool = tools(sessionId).find((entry) => entry.name === name)!;
    return (await tool.execute("call-1", params as never, undefined, undefined, undefined as never)).details as Record<string, unknown>;
  };
  const state = async () => await registry.invoke(AGENTS_HOST_EXTENSION_ID, "state") as AgentsState;
  return { dir, registry, remoteWork, call, state, started, woken, observers, idle, linksPath, rex };
}

async function until<T>(read: () => T | Promise<T>, test: (value: T) => boolean, what: string): Promise<T> {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    const value = await read();
    if (test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never saw ${what}`);
}

const linkOf = async (b: Awaited<ReturnType<typeof bench>>, handle: string) => (await b.state()).links.find((link) => link.id === handle)!;

describe("resolveMachine", () => {
  const machines = (list: HostMachine[]): HostMachineServices => ({ self: { id: "me", name: "mini", version: "1" }, list: () => list } as unknown as HostMachineServices);
  const ports = (list: HostMachine[], auto?: { machine?: string | null; reason: string }) => ({ machines: () => machines(list), auto: async () => auto });
  const rex: HostMachine = { id: "rex-id", name: "rex", status: "connected" };

  it("runs here for nothing, local and this computer's own name; finds a machine by name or id", async () => {
    expect(await resolveMachine(undefined, "setting", ports([rex]))).toEqual({});
    expect(await resolveMachine("local", "tool", ports([rex]))).toEqual({});
    expect(await resolveMachine("mini", "tool", ports([rex]))).toEqual({});
    expect(await resolveMachine("REX", "tool", ports([rex]))).toEqual({ machine: { id: "rex-id", name: "rex" } });
    expect(await resolveMachine("rex-id", "tool", ports([rex]))).toEqual({ machine: { id: "rex-id", name: "rex" } });
  });

  it("refuses a machine that cannot take work, and says where the choice came from", async () => {
    await expect(resolveMachine("box", "tool", ports([rex]))).rejects.toThrow("know no machine box (they know rex)");
    await expect(resolveMachine("rex", "setting", ports([{ ...rex, status: "offline", detail: "last seen 5m ago" }]))).rejects.toThrow('rex is offline: last seen 5m ago. Sub-agents go there by Settings → Agents; pass machine "local"');
    await expect(resolveMachine("rex", "definition", ports([{ ...rex, readOnly: true }]))).rejects.toThrow(/Read only.*The agent definition names it/u);
    await expect(resolveMachine("rex", "tool", ports([rex, { ...rex, id: "rex-2" }]))).rejects.toThrow("More than one machine is called rex");
    await expect(resolveMachine("rex", "tool", { machines: () => undefined, auto: async () => undefined })).rejects.toThrow("keeps no other machines");
  });

  it("asks Machines Kit for auto, and runs here with the reason when it has no answer", async () => {
    expect(await resolveMachine("auto", "setting", ports([rex]))).toEqual({ reason: expect.stringMatching(/choose-machine; this computer runs it/u) });
    expect(await resolveMachine("auto", "tool", ports([rex], { machine: null, reason: "rex is busy" }))).toEqual({ reason: "rex is busy" });
    expect(await resolveMachine("auto", "tool", ports([rex], { machine: "rex-id", reason: "rex has room" }))).toEqual({ machine: { id: "rex-id", name: "rex" }, reason: "rex has room" });
  });
});

describe("Agents Kit: sub-agents on another machine", () => {
  it("spawns on rex, follows it there and wakes the parent with its answer", async () => {
    const b = await bench();
    const spawned = await b.call("tau_spawn_thread", { prompt: "Write one word into a.txt", title: "Word A", machine: "rex" });
    expect(spawned).toMatchObject({ status: "running", title: "Word A", machine: "rex", workspace: "worktree" });
    expect(b.started).toEqual([]);
    expect(b.remoteWork.started[0]).toMatchObject({ machine: "rex-id", cwd: "/project", prompt: "Write one word into a.txt", title: "Word A", parentThreadId: "parent", agentDepth: 1 });
    const handle = String(spawned.threadId);
    expect((await linkOf(b, handle)).machine).toMatchObject({ id: "rex-id", name: "rex", link: "link-1" });

    b.remoteWork.run("link-1");
    await until(() => linkOf(b, handle), (link) => link.machine?.thread === "rex-thread-link-1", "the thread on rex");
    b.remoteWork.finish("link-1", "apple");
    const done = await until(() => linkOf(b, handle), (link) => link.status === "completed", "the finished turn");
    expect(done).toMatchObject({ result: "apple", workspace: { mode: "worktree", branch: "tau/remote-t1", path: "/rex/worktrees/work/t1" }, machine: { costUsd: 0.002 } });
    const woken = await until(() => b.woken, (list) => list.length > 0, "the parent woken");
    expect(woken[0]).toMatchObject({ sessionId: "parent" });
    expect(woken[0]!.text).toContain('"Word A" on rex');
    expect(woken[0]!.text).toContain("apple");

    const status = await b.call("tau_get_thread_status", { threadId: handle });
    expect(status).toMatchObject({ threadId: handle, machine: "rex", status: "completed", lastAssistantMessage: "apple" });
    expect((await b.call("tau_list_threads")).threads).toEqual([expect.objectContaining({ threadId: handle, machine: "rex" })]);
  });

  it("goes where the user's setting says, and a spawn's own machine wins", async () => {
    const b = await bench({ setting: "rex" });
    expect(await b.call("tau_spawn_thread", { prompt: "There" })).toMatchObject({ machine: "rex" });
    const here = await b.call("tau_spawn_thread", { prompt: "Here", machine: "local", workspace: "shared" });
    expect(here.machine).toBeUndefined();
    expect(b.started).toHaveLength(1);
    expect(b.remoteWork.started).toHaveLength(1);
  });

  it("refuses rex when it is offline or the spawn cannot work there", async () => {
    const offline = await bench({ setting: "rex", rex: { status: "offline" } });
    await expect(offline.call("tau_spawn_thread", { prompt: "x" })).rejects.toThrow(/rex is offline.*Settings → Agents/u);
    const b = await bench();
    await expect(b.call("tau_spawn_thread", { prompt: "x", machine: "rex", workspace: "shared" })).rejects.toThrow('"shared" only works on this computer');
    await expect(b.call("tau_spawn_thread", { prompt: "x", machine: "nowhere" })).rejects.toThrow("know no machine nowhere");
    expect(b.remoteWork.started).toEqual([]);
  });

  it("runs as many at once on rex as it has cores; the rest wait and start when one finishes", async () => {
    const b = await bench({ cores: 2 });
    const handles = [];
    for (const word of ["one", "two", "three"]) handles.push(String((await b.call("tau_spawn_thread", { prompt: word, machine: "rex" })).threadId));
    const statuses = async () => (await b.state()).links.map((link) => link.status);
    expect(await statuses()).toEqual(["running", "running", "pending"]);
    expect(b.remoteWork.started).toHaveLength(2);
    expect(((await b.registry.invoke(AGENTS_HOST_EXTENSION_ID, "machines")) as AgentMachinesView).machines).toEqual([expect.objectContaining({ name: "rex", budget: 2 })]);
    // A local spawn is not held back by rex's full budget.
    expect((await b.call("tau_spawn_thread", { prompt: "here", machine: "local", workspace: "shared" })).status).toBe("running");

    b.remoteWork.run("link-1");
    b.remoteWork.finish("link-1", "done");
    await until(() => b.remoteWork.started, (list) => list.length === 3, "the third start on rex");
    expect(b.remoteWork.started[2]!.prompt).toBe("three");
  });

  it("merges the work here through tau_apply_thread_changes, and reports a conflict without applying anything", async () => {
    const b = await bench();
    const first = String((await b.call("tau_spawn_thread", { prompt: "a", machine: "rex" })).threadId);
    const second = String((await b.call("tau_spawn_thread", { prompt: "b", machine: "rex" })).threadId);
    for (const link of ["link-1", "link-2"]) { b.remoteWork.run(link); b.remoteWork.finish(link, "ok"); }
    await until(() => b.state(), (state) => state.links.every((link) => link.status === "completed"), "both finished");

    const applied = await b.call("tau_apply_thread_changes", { threadId: first });
    expect(applied).toMatchObject({ branch: "tau/rex/one-word", detail: expect.stringContaining("Merged tau/rex/one-word") });
    expect(b.remoteWork.settled[0]).toEqual({ link: "link-1", how: "apply", removeThread: true });
    expect((await linkOf(b, first)).workspace).toMatchObject({ settled: "applied", branch: "tau/rex/one-word" });

    b.remoteWork.conflictOn(["README.md"]);
    await expect(b.call("tau_apply_thread_changes", { threadId: second })).rejects.toThrow("Nothing was applied: tau/rex/one-word from rex conflicts with this checkout: README.md. The branch stays");
    expect((await linkOf(b, second)).workspace?.settled).toBeUndefined();
    b.remoteWork.conflictOn(undefined);
    expect(await b.call("tau_apply_thread_changes", { threadId: second, discard: true })).toMatchObject({ detail: "Let go." });
    expect(b.remoteWork.settled[2]).toEqual({ link: "link-2", how: "discard", removeThread: true });
  });

  it("waits, steers, cancels and hears a question through the link there", async () => {
    const b = await bench();
    const handle = String((await b.call("tau_spawn_thread", { prompt: "long", machine: "rex" })).threadId);
    b.remoteWork.run("link-1");
    await until(() => linkOf(b, handle), (link) => Boolean(link.machine?.thread), "the thread on rex");
    const waiting = b.call("tau_wait_for_thread", { threadId: handle, timeoutMs: 5_000 });
    b.remoteWork.ask("link-1", "Which file?");
    expect(await waiting).toMatchObject({ status: "waiting", pendingToolPrompt: "Which file?" });

    b.remoteWork.run("link-1");
    await until(() => linkOf(b, handle), (link) => link.status === "running", "running again");
    expect(await b.call("tau_send_to_thread", { threadId: handle, message: "use b.txt" })).toMatchObject({ delivered: "steered", machine: "rex" });
    expect(b.remoteWork.sent).toEqual([{ link: "link-1", text: "use b.txt", delivery: "steer" }]);
    expect(await b.call("tau_cancel_thread", { threadId: handle })).toMatchObject({ cancelled: true });
    expect(b.remoteWork.aborted).toEqual(["link-1"]);
    await until(() => linkOf(b, handle), (link) => link.status === "cancelled", "cancelled");

    // Going offline ends a wait: the thread may run on there, and nothing here learns when.
    const idle = String((await b.call("tau_spawn_thread", { prompt: "x", machine: "rex" })).threadId);
    b.remoteWork.run("link-2");
    await until(() => linkOf(b, idle), (link) => Boolean(link.machine?.thread), "the second thread");
    const offWait = b.call("tau_wait_for_thread", { threadId: idle, timeoutMs: 5_000 });
    b.remoteWork.offline("link-2");
    expect(await offWait).toMatchObject({ machine: "rex", machineOffline: true, status: "running" });
  });

  it("lets a thread rex started as a depth-2 agent spawn no further", async () => {
    const deep = await bench();
    deep.remoteWork.depths.set("parent", 2);
    await expect(deep.call("tau_spawn_thread", { prompt: "deeper", machine: "local" })).rejects.toThrow("may nest 2 levels deep");
    const b = await bench();
    b.remoteWork.depths.set("parent", 1);
    expect((await b.call("tau_spawn_thread", { prompt: "one more", machine: "local", workspace: "shared" })).status).toBe("running");
  });

  it("chooses through Machines Kit for auto, and runs here without it", async () => {
    const without = await bench({ setting: "auto" });
    expect(await without.call("tau_spawn_thread", { prompt: "x", workspace: "shared" })).toMatchObject({ machineChoice: expect.stringMatching(/this computer runs it/u) });
    expect(without.started).toHaveLength(1);
    const chosen = await bench({ setting: "auto", extra: [fakeMachinesKit({ machine: "rex-id", reason: "rex has 2 free cores" })] });
    expect(await chosen.call("tau_spawn_thread", { prompt: "x" })).toMatchObject({ machine: "rex", machineChoice: "rex has 2 free cores" });
    expect((await chosen.state()).links[0]!.machine?.reason).toBe("rex has 2 free cores");
  });

  it("keeps a child on rex across a restart and follows it again", async () => {
    const b = await bench();
    const handle = String((await b.call("tau_spawn_thread", { prompt: "survive", title: "Survivor", machine: "rex" })).threadId);
    b.remoteWork.run("link-1");
    b.remoteWork.finish("link-1", "first answer");
    b.remoteWork.run("link-1");
    await until(async () => JSON.parse(await readFile(b.linksPath, "utf8").catch(() => "{}")) as { links?: unknown[] }, (file) => (file.links?.length ?? 0) > 0, "the links file");
    const stored = JSON.parse(await readFile(b.linksPath, "utf8")) as { links: Array<Record<string, unknown>> };
    expect(stored.links[0]).toMatchObject({ parentThreadId: "parent", title: "Survivor", remote: { id: handle, machine: { id: "rex-id", name: "rex", link: "link-1" } } });
    expect(stored.links[0]!.threadId).toBeUndefined();

    // A second host on the same file and the same Remote Work links.
    const again = await bench({ linksPath: b.linksPath, links: b.remoteWork.links });
    const restored = await until(() => again.state(), (state) => state.links[0]?.machine?.thread === "rex-thread-link-1", "the restored child");
    expect(restored.links[0]).toMatchObject({ id: handle, status: "running", title: "Survivor", result: "first answer" });
    again.remoteWork.finish("link-1", "still here");
    await until(() => linkOf(again, handle), (link) => link.status === "completed" && link.result === "still here", "its answer after the restart");
  });

  it("names the machine in the message that wakes a parent", () => {
    expect(wakeMessage([{ threadId: "h1", title: "Word", status: "completed", answer: "ok", machine: "rex" }])).toContain('— "Word" on rex (threadId h1): completed');
  });
});

