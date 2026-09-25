import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HostBlob,
  HostExtensionServices,
  HostMachine,
  HostMachineServices,
  HostSessionServices,
  HostThread,
  HostThreadImportOptions,
  HostThreadLifecycle,
  HostThreadStartOptions,
  HostTurnObserver,
  RuntimeExtensionFactory,
  UiMessage,
  UiThreadUsage,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createRemoteWorkHostExtension } from "./host.js";
import { remoteThreadsClient, type RemoteThreadsService } from "./threads-client.js";
import {
  HOSTED_COMMANDS,
  REMOTE_WORK_EXTENSION_ID as ID,
  THREAD_LINK_EVENT,
  type HostedThreadReport,
  type RemoteThreadLink,
  type RemoteThreadWaitResult,
} from "./protocol.js";

const made: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function put(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "pipe" }).toString().trim();

const USAGE: UiThreadUsage = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 105, costUsd: 0.00011, turns: 1 };

/** A thread on rex as the fake session layer runs it; the test ends its turns. */
interface FakeThread {
  id: string;
  cwd: string;
  streaming: boolean;
  open: boolean;
  messages: UiMessage[];
  usage?: UiThreadUsage;
  prompts: string[];
  jsonl?: string;
  origin?: { hostId: string; threadId: string; details?: Record<string, unknown> };
  /** Holds transcript reads, as a slow session file would. */
  transcriptGate?: Promise<void>;
}

/**
 * rex's sessions: `start` and `send` accept a turn at once and leave it
 * running, as a model would; `finish` ends it with an answer, `abort` stops it.
 */
function fakeSessions() {
  const threads = new Map<string, FakeThread>();
  const observers: HostTurnObserver[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const runtimeExtensions: RuntimeExtensionFactory[] = [];
  /** Threads moved into rex's trash. */
  const removed: string[] = [];
  const begin = (thread: FakeThread, text: string) => {
    thread.prompts.push(text);
    thread.streaming = true;
    thread.open = true;
    for (const observer of observers) observer.accepted?.(thread.id, `turn-${thread.prompts.length}`, { deferBefore: false });
  };
  const end = async (thread: FakeThread, outcome: "completed" | "failed") => {
    thread.streaming = false;
    thread.open = false;
    for (const observer of observers) await observer.ended?.(thread.id, `turn-${thread.prompts.length}`, outcome);
  };
  const view = (thread: FakeThread) => ({
    sessionId: thread.id,
    cwd: thread.cwd,
    backendKind: "pi",
    sessionFile: undefined,
    get usage() { return thread.usage; },
    model: { provider: "tau-fake", id: "fake-1" },
    isStreaming: () => thread.streaming,
    isIdle: () => !thread.open,
    transcript: async () => {
      await thread.transcriptGate;
      return thread.messages;
    },
  }) as unknown as HostThread;
  const services: Partial<HostExtensionServices> = {
    thread: (id?: string) => { const thread = id ? threads.get(id) : undefined; return thread ? view(thread) : undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerRuntimeExtension: (_name, factory) => { runtimeExtensions.push(factory); return () => undefined; },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    sessions: {
      list: async () => [],
      start: async (options: HostThreadStartOptions) => {
        const thread: FakeThread = { id: randomUUID(), cwd: options.cwd, streaming: false, open: false, messages: [], prompts: [] };
        threads.set(thread.id, thread);
        // The prompt is accepted before `start` answers, as the host delivers it.
        begin(thread, options.prompt);
        return { sessionId: thread.id, cwd: thread.cwd };
      },
      import: async (options: HostThreadImportOptions) => {
        const thread: FakeThread = { id: randomUUID(), cwd: options.cwd, streaming: false, open: false, messages: [], prompts: [], jsonl: options.jsonl, origin: options.origin };
        threads.set(thread.id, thread);
        return { sessionId: thread.id, path: join(options.cwd, "imported.jsonl"), cwd: options.cwd };
      },
      send: async (id: string, text: string) => begin(threads.get(id)!, text),
      abort: async (id: string) => {
        const thread = threads.get(id)!;
        if (thread.open) await end(thread, "completed");
      },
      remove: async (id: string) => {
        if (threads.get(id)?.streaming) throw new Error("A running thread cannot be removed.");
        removed.push(id);
      },
    } as Partial<HostSessionServices> as HostSessionServices,
  };
  return {
    services,
    threads,
    removed,
    only: () => [...threads.values()][0]!,
    finish: async (thread: FakeThread, text: string, error?: string) => {
      thread.messages.push({ role: "assistant", text, ...(error ? { error } : {}) } as UiMessage);
      thread.usage = { ...USAGE, turns: thread.prompts.length, costUsd: USAGE.costUsd * thread.prompts.length };
      await end(thread, error ? "failed" : "completed");
    },
    /** Pi's dialog events, as the runtime extension receives them. */
    dialog: (thread: FakeThread, title: string | undefined) => {
      const handlers = new Map<string, (event: unknown) => void>();
      const pi = { on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); } };
      for (const factory of runtimeExtensions) void factory(pi as never, { sessionId: thread.id, cwd: thread.cwd } as never);
      if (title) handlers.get("ui_prompt_start")?.({ kind: "confirm", title });
      else handlers.get("ui_prompt_end")?.({});
    },
    deleted: async (thread: FakeThread) => { for (const lifecycle of lifecycles) await lifecycle.threadDeleted?.(thread.id, thread.cwd); },
  };
}

/**
 * Host A and "rex", each with Remote Work Kit in its own registry. A's
 * `services.machines` reaches rex's registry as A's agents device; `online`
 * cuts the connection both ways (calls refuse, topic events are lost).
 */
async function twoHosts(options: { hello?: "old" | "missing" } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-remote-threads-")));
  made.push(dir);
  const work = join(dir, "work");
  await mkdir(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  await put(work, "README.md", "# Project\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "start");

  const sessions = fakeSessions();
  const device = "a-agents";
  const blobs = new Map<string, HostBlob>();
  const watchers = new Set<{ topic: string; listener: (event: { name: string; payload?: unknown }) => void }>();
  const state = { online: true, status: "connected" as HostMachine["status"] };
  const rexServices: Partial<HostExtensionServices> = {
    ...sessions.services,
    cwd: () => dir,
    stateDir: join(dir, "rex-state"),
    blobs: {
      take: async (id, use) => {
        const blob = blobs.get(id)!;
        blobs.delete(id);
        return use(blob);
      },
    },
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
  };
  const rexRoot = join(dir, "rex-home", ".tau", "remote-work");
  const rexEnv = { ...process.env, TAU_TEST_CLONE_ROOT: dir };
  const rex = await activateHostKit(createRemoteWorkHostExtension({ root: rexRoot, env: rexEnv }), rexServices, (event) => {
    if (!state.online) return;
    for (const watcher of watchers) if (watcher.topic === event.topic) watcher.listener({ name: event.name, payload: event.payload });
  });
  closers.push(() => rex.dispose());
  if (options.hello) {
    // An older rex: its kit answers another protocol, or has no thread commands at all.
    const original = rex.invoke.bind(rex);
    rex.invoke = (async (extensionId: string, command: string, input?: unknown, principal?: never) => {
      if (command === HOSTED_COMMANDS.hello) {
        if (options.hello === "missing") throw new Error(`Host extension Remote Work has no command "${command}".`);
        return { protocol: 0 };
      }
      return original(extensionId, command, input, principal);
    }) as typeof rex.invoke;
  }
  const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: device };
  const wire = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
  const listeners = new Set<(list: readonly HostMachine[]) => void>();
  const list = (): HostMachine[] => [{ id: "rex-id", name: "rex", status: state.status, hostVersion: "0.6.0" }];
  const machines: HostMachineServices = {
    self: { id: "mini-id", name: "mini", version: "0.7.0" },
    list,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    call: async (_machine, extensionId, command, input) => {
      if (!state.online) throw new Error("rex is offline.");
      return wire(await rex.invoke(extensionId, command, wire(input), paired));
    },
    request: async (_machine, method) => {
      if (method === "readiness") return { checkedAt: 0, runtimes: [], git: { version: "2.45.0", mergeTree: true }, disk: { path: "/", free: 50e9 }, display: { kind: "none" } };
      throw new Error("unknown-method");
    },
    watch: (_machine, topic, listener) => {
      const watcher = { topic, listener };
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    },
    upload: async (_machine, source) => {
      const chunks: Buffer[] = [];
      if (source instanceof Uint8Array) chunks.push(Buffer.from(source));
      else for await (const chunk of source) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const id = randomUUID().replaceAll("-", "");
      const path = join(dir, "rex-blobs", id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      blobs.set(id, { id, path, size: bytes.length, sha256, device });
      return { id, size: bytes.length, sha256 };
    },
  };
  const setOnline = (online: boolean) => {
    state.online = online;
    state.status = online ? "connected" : "offline";
    for (const listener of listeners) listener(list());
  };

  const aSessions = new Map<string, string>();
  const openA = async () => {
    const events: PublishedKitEvent[] = [];
    const a = await activateHostKit(createRemoteWorkHostExtension({ pollMs: 5 }), {
      machines,
      stateDir: join(dir, "a-state"),
      thread: () => undefined,
      sessions: { list: async () => [...aSessions].map(([sessionId, path]) => ({ sessionId, path, cwd: work })) } as unknown as HostExtensionServices["sessions"],
    }, (event) => events.push(event));
    closers.push(() => a.dispose());
    const call = <T>(command: string, input?: unknown) => a.invoke(ID, command, input) as Promise<T>;
    return { a, call, events };
  };
  const { a, call, events } = await openA();
  return { dir, work, rex, a, call, events, openA, sessions, setOnline, rexRoot, aSessions, device, paired };
}

type Hosts = Awaited<ReturnType<typeof twoHosts>>;

async function until<T>(read: () => T | Promise<T>, test: (value: T) => boolean, what: string): Promise<T> {
  // Generous: a transfer runs real Git, which a busy machine slows down.
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    const value = await read();
    if (test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never saw ${what}`);
}

const linkOf = (hosts: Hosts, id: string) => hosts.call<RemoteThreadLink>("thread", { link: id });
/** The link once its thread exists on rex. */
const started = (hosts: Hosts, id: string) => until(() => linkOf(hosts, id), (link) => Boolean(link.thread) || link.status === "failed", "the thread on rex");

describe("Remote Work Kit: a thread started here runs on another machine", () => {
  it("starts in the worktree that holds this checkout's state and follows it from running to idle, with its cost", async () => {
    const hosts = await twoHosts();
    await put(hosts.work, "notes.md", "uncommitted\n");
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "Say one word", parentThreadId: "parent-1", agent: "reviewer", model: "tau-fake/fake-1" });
    expect(link).toMatchObject({ status: "sending", machine: "rex-id", machineName: "rex", title: "Say one word", parentThreadId: "parent-1", agent: "reviewer", model: { provider: "tau-fake", id: "fake-1" } });

    const running = await started(hosts, link.id);
    expect(running.status).toBe("running");
    const thread = hosts.sessions.threads.get(running.thread!)!;
    // The thread works in the transfer's worktree there, which has the uncommitted file.
    expect(thread.cwd).toBe(running.worktree);
    expect(thread.cwd.startsWith(join(hosts.rexRoot, "worktrees"))).toBe(true);
    expect(await readFile(join(thread.cwd, "notes.md"), "utf8")).toBe("uncommitted\n");
    expect(thread.prompts).toEqual(["Say one word"]);

    const waiting = hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id, timeoutMs: 10_000 });
    await hosts.sessions.finish(thread, "apple");
    const done = await waiting;
    expect(done.reason).toBe("idle");
    expect(done.link).toMatchObject({ status: "idle", thread: thread.id, there: { state: "idle", turns: 1, outcome: "completed", lastMessage: "apple" } });
    expect(done.link.usage?.costUsd).toBeGreaterThan(0);

    const bookPath = join(hosts.dir, "a-state", ID, "remote-links.json");
    const book = await until(async () => JSON.parse(await readFile(bookPath, "utf8")) as RemoteThreadLink[], (entries) => entries[0]?.status === "idle", "the idle link in the book");
    expect(book[0]).toMatchObject({ id: link.id, machine: "rex-id", thread: thread.id, base: running.base, status: "idle" });
    expect(book[0]!.usage?.costUsd).toBeGreaterThan(0);
    expect(hosts.events.filter((event) => event.name === THREAD_LINK_EVENT).map((event) => (event.payload as RemoteThreadLink).status)).toEqual(expect.arrayContaining(["sending", "starting", "running", "idle"]));

    // A second message goes to the same thread there.
    await hosts.call("thread-send", { link: link.id, text: "One more" });
    expect(thread.prompts).toEqual(["Say one word", "One more"]);
    await until(() => linkOf(hosts, link.id), (value) => value.status === "running", "the second turn running");
    await hosts.sessions.finish(thread, "banana");
    const second = await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id });
    expect(second.link.there).toMatchObject({ turns: 2, lastMessage: "banana" });
    expect(await hosts.call<RemoteThreadLink[]>("threads", { parentThreadId: "parent-1" })).toHaveLength(1);
  });

  it("stops a running turn there, and reads a failed answer as failed with the provider's error", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "wait 60000" });
    const running = await started(hosts, link.id);
    const thread = hosts.sessions.threads.get(running.thread!)!;
    const stopped = await hosts.call<RemoteThreadLink>("thread-abort", { link: link.id });
    expect(thread.streaming).toBe(false);
    expect(stopped).toMatchObject({ status: "idle", there: { outcome: "aborted" } });

    await hosts.call("thread-send", { link: link.id, text: "fail 429 quota" });
    await hosts.sessions.finish(thread, "", "429 You exceeded your current quota.");
    const failed = await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id });
    expect(failed.reason).toBe("failed");
    expect(failed.link).toMatchObject({ status: "failed", error: "429 You exceeded your current quota.", there: { outcome: "failed" } });
    // A failed turn is not the end: the next message runs.
    await hosts.call("thread-send", { link: link.id, text: "again" });
    await hosts.sessions.finish(thread, "ok");
    expect((await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id })).link).toMatchObject({ status: "idle" });
    expect((await linkOf(hosts, link.id)).error).toBeUndefined();
  });

  it("says when the thread waits on a dialog there, and what it asks", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "ask me" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    hosts.sessions.dialog(thread, "Delete build/?");
    const asked = await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id });
    expect(asked).toMatchObject({ reason: "waiting", link: { status: "waiting", there: { question: "Delete build/?" } } });
    hosts.sessions.dialog(thread, undefined);
    await until(() => linkOf(hosts, link.id), (value) => value.status === "running", "running again after the answer");
  });

  it("reads offline while rex is unreachable, and catches up once it is back", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "Work a while" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    hosts.setOnline(false);
    const offline = await until(() => linkOf(hosts, link.id), (value) => value.status === "offline", "offline");
    expect(offline.there?.state).toBe("running");
    expect(await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id, timeoutMs: 10_000 })).toMatchObject({ reason: "offline" });
    await expect(hosts.call("thread-send", { link: link.id, text: "hello?" })).rejects.toThrow(/offline/u);

    // The turn ends while nobody hears it; the event is lost.
    await hosts.sessions.finish(thread, "done meanwhile");
    expect((await linkOf(hosts, link.id)).status).toBe("offline");
    hosts.setOnline(true);
    const back = await until(() => linkOf(hosts, link.id), (value) => value.status === "idle", "idle after the reconnect");
    expect(back.there).toMatchObject({ lastMessage: "done meanwhile", turns: 1 });
  });

  it("follows its links again after this host restarts", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "Long work" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    await hosts.a.deactivate(ID);
    await hosts.sessions.finish(thread, "finished while A was away");
    const again = await hosts.openA();
    const link2 = await until(() => again.call<RemoteThreadLink>("thread", { link: link.id }), (value) => value.status === "idle", "idle after the restart");
    expect(link2.there?.lastMessage).toBe("finished while A was away");
    // And it hears the next turn by its topic.
    await again.call("thread-send", { link: link.id, text: "more" });
    await hosts.sessions.finish(thread, "more done");
    expect((await again.call<RemoteThreadWaitResult>("thread-wait", { link: link.id })).link.there?.lastMessage).toBe("more done");
  });

  it("takes a Pi session from here with its origin, and continues it there", async () => {
    const hosts = await twoHosts();
    const jsonl = `${JSON.stringify({ type: "session", version: 3, id: "here-1", timestamp: "2026-09-25T00:00:00Z", cwd: hosts.work })}\n`;
    const path = join(hosts.dir, "here-1.jsonl");
    await writeFile(path, jsonl);
    hosts.aSessions.set("here-1", path);
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, session: { threadId: "here-1" }, prompt: "Go on", title: "Continue" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    expect(thread.jsonl).toBe(jsonl);
    expect(thread.origin).toMatchObject({ hostId: "mini-id", threadId: "here-1" });
    expect(thread.prompts).toEqual(["Go on"]);
    await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.work, session: { threadId: "nope" } })).rejects.toThrow(/no Pi session/u);
  });

  it("brings the work back as a branch and merges it on settle; nothing is taken while the thread runs", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "Write a changelog", title: "Changelog" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    await expect(hosts.call("thread-result", { link: link.id })).rejects.toThrow(/still working/u);
    await expect(hosts.call("thread-settle", { link: link.id, how: "apply" })).rejects.toThrow(/still working/u);
    await put(thread.cwd, "CHANGELOG.md", "- from rex\n");
    await hosts.sessions.finish(thread, "done");
    await hosts.call("thread-wait", { link: link.id });

    const settled = await hosts.call<RemoteThreadLink>("thread-settle", { link: link.id, how: "apply" });
    expect(settled).toMatchObject({ status: "settled", result: { state: "branch", branch: "tau/rex/changelog" }, applied: { state: "merged" }, settled: { how: "applied" } });
    expect(await readFile(join(hosts.work, "CHANGELOG.md"), "utf8")).toBe("- from rex\n");
    expect(existsSync(thread.cwd)).toBe(false);
    // Settled: nothing more goes there.
    await expect(hosts.call("thread-send", { link: link.id, text: "more" })).rejects.toThrow(/settled/u);
    expect(await hosts.call<RemoteThreadLink[]>("threads", { active: true })).toEqual([]);
  });

  it("starts from HEAD and the working copy, so a commit made after the last checkpoint survives the merge back", async () => {
    const hosts = await twoHosts();
    await put(hosts.work, "fruit.txt", "kiwi\n");
    git(hosts.work, "add", "fruit.txt");
    git(hosts.work, "commit", "-qm", "kiwi");
    // A parent turn left a draft and a checkpoint of that working copy; then the user committed.
    await put(hosts.work, "draft.txt", "a draft\n");
    git(hosts.work, "add", "-A");
    git(hosts.work, "update-ref", "refs/tau/checkpoints/parent/turn-1/after", git(hosts.work, "write-tree"));
    git(hosts.work, "reset", "-q");
    await put(hosts.work, "fruit.txt", "pear\n");
    git(hosts.work, "commit", "-qm", "pear", "--", "fruit.txt");

    // A sub-agent's start (which named that checkpoint before H18) and a "Continue on" alike.
    for (const [index, input] of [
      { prompt: "Add a basket", title: "Basket", parentThreadId: "parent", snapshotRef: "refs/tau/checkpoints/parent/turn-1/after" },
      { prompt: "Add a bowl", title: "Bowl", parentThreadId: "parent" },
    ].entries()) {
      const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, ...input });
      const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
      expect(await readFile(join(thread.cwd, "fruit.txt"), "utf8")).toBe("pear\n");
      expect(await readFile(join(thread.cwd, "draft.txt"), "utf8")).toBe("a draft\n");
      await put(thread.cwd, `made-${index}.txt`, `${input.title}\n`);
      git(thread.cwd, "add", "-A");
      git(thread.cwd, "commit", "-qm", input.title);
      await hosts.sessions.finish(thread, "done");
      await hosts.call("thread-wait", { link: link.id });
      const settled = await hosts.call<RemoteThreadLink>("thread-settle", { link: link.id, how: "apply" });
      expect(settled.applied).toMatchObject({ state: "merged" });
      expect(await readFile(join(hosts.work, "fruit.txt"), "utf8")).toBe("pear\n");
      expect(await readFile(join(hosts.work, `made-${index}.txt`), "utf8")).toBe(`${input.title}\n`);
    }
    expect(await readFile(join(hosts.work, "draft.txt"), "utf8")).toBe("a draft\n");
  });

  it("moves a sub-agent's thread into rex's trash on settle, and tells rex's Agents Kit how deep it started", async () => {
    const hosts = await twoHosts();
    const clients = new Map<string, RemoteThreadsService>();
    await hosts.rex.activate({ id: "tau.agents", name: "Agents", activate(context) { clients.set("rex", remoteThreadsClient(context.invokeHostExtension)); } });
    await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.work, prompt: "x", agentDepth: 0 })).rejects.toThrow(/agentDepth/u);
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "One word", parentThreadId: "p1", agentDepth: 2 });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    // rex's own Agents Kit reads the depth; a thread rex started itself has none.
    expect(await clients.get("rex")!.agentDepth(thread.id)).toBe(2);
    expect(await clients.get("rex")!.agentDepth("elsewhere")).toBeUndefined();
    await hosts.sessions.finish(thread, "done");
    await hosts.call("thread-wait", { link: link.id });

    const settled = await hosts.call<RemoteThreadLink>("thread-settle", { link: link.id, how: "apply", removeThread: true });
    expect(settled.status).toBe("settled");
    expect(settled.settled?.detail).toMatch(/in rex's trash/u);
    expect(hosts.sessions.removed).toEqual([thread.id]);
    // A thread without removeThread stays there, an ordinary thread of rex.
    const kept = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "Another" });
    const other = hosts.sessions.threads.get((await started(hosts, kept.id)).thread!)!;
    await hosts.sessions.finish(other, "ok");
    await hosts.call("thread-wait", { link: kept.id });
    await hosts.call("thread-settle", { link: kept.id, how: "discard" });
    expect(hosts.sessions.removed).toEqual([thread.id]);
  });

  it("lets a running thread's worktree go on discard, stopping its turn first", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "wait 60000" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    const settled = await hosts.call<RemoteThreadLink>("thread-settle", { link: link.id, how: "discard" });
    expect(thread.streaming).toBe(false);
    expect(settled).toMatchObject({ status: "settled", settled: { how: "discarded" } });
    expect(existsSync(thread.cwd)).toBe(false);
    expect(git(hosts.work, "branch", "--list")).toBe("* main");
  });

  it("names both versions when rex's Tau cannot run a thread started here", async () => {
    for (const hello of ["missing", "old"] as const) {
      const hosts = await twoHosts({ hello });
      await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.work, prompt: "hi" })).rejects.toThrow("rex has Tau 0.6.0, needs ≥ 0.7.0 to run a thread started here; update Tau there.");
      expect(await hosts.call<RemoteThreadLink[]>("threads")).toEqual([]);
    }
  });

  it("refuses what cannot start, and records a start that failed on the way", async () => {
    const hosts = await twoHosts();
    await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.work })).rejects.toThrow(/prompt or a session/u);
    await expect(hosts.call("thread-start", { machine: "nowhere", cwd: hosts.work, prompt: "hi" })).rejects.toThrow(/do not know a machine nowhere/u);
    await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.dir, prompt: "hi" })).rejects.toThrow(/not inside a Git repository/u);
    hosts.setOnline(false);
    await expect(hosts.call("thread-start", { machine: "rex", cwd: hosts.work, prompt: "hi" })).rejects.toThrow(/rex is offline/u);
    hosts.setOnline(true);
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "hi" });
    // It goes offline while the state travels.
    hosts.setOnline(false);
    const failed = await until(() => linkOf(hosts, link.id), (value) => value.status === "failed", "the failed start");
    expect(failed.error).toMatch(/offline/u);
    expect((await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id })).reason).toBe("failed");
  });

  it("is a service Agents and Handoff reach through their own context, and no other kit", async () => {
    const hosts = await twoHosts();
    const clients = new Map<string, RemoteThreadsService>();
    for (const id of ["tau.agents", "tau.other"]) {
      await hosts.a.activate({ id, name: id, activate(context) { clients.set(id, remoteThreadsClient(context.invokeHostExtension)); } });
    }
    const agents = clients.get("tau.agents")!;
    const link = await agents.start({ machine: "rex", cwd: hosts.work, prompt: "From a kit", parentThreadId: "p1" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    await hosts.sessions.finish(thread, "ok");
    expect((await agents.wait(link.id, 5_000)).reason).toBe("idle");
    expect((await agents.list({ parentThreadId: "p1" })).map((entry) => entry.id)).toEqual([link.id]);
    await expect(clients.get("tau.other")!.list()).rejects.toThrow(/not allowed|unauthori[sz]ed|may not/iu);
  });

  it("there: another device reads none of the threads, and a deleted thread reads gone", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "hi" });
    const running = await started(hosts, link.id);
    const stranger = { ...hosts.paired, pairedClient: "someone-else" };
    const answer = await hosts.rex.invoke(ID, HOSTED_COMMANDS.reports, { protocol: 1, threads: [running.thread] }, stranger) as { reports: Array<{ state: string }> };
    expect(answer.reports).toEqual([expect.objectContaining({ state: "gone" })]);
    await expect(hosts.rex.invoke(ID, HOSTED_COMMANDS.abort, { protocol: 1, thread: running.thread }, stranger)).rejects.toThrow(/runs no thread/u);
    await expect(hosts.rex.invoke(ID, HOSTED_COMMANDS.start, { protocol: 1, transfer: running.transfer, prompt: "x" }, stranger)).rejects.toThrow(/no worktree/u);
    await expect(hosts.rex.invoke(ID, HOSTED_COMMANDS.reports, { protocol: 2, threads: [] }, hosts.paired)).rejects.toThrow(/protocol/u);
    // The worktree stays while a thread works in it.
    await expect(hosts.rex.invoke(ID, "worktree-remove", { transfer: running.transfer }, hosts.paired)).rejects.toThrow(/still works/u);

    const thread = hosts.sessions.threads.get(running.thread!)!;
    await hosts.sessions.deleted(thread);
    const gone = await until(() => linkOf(hosts, link.id), (value) => value.status === "gone", "gone");
    expect((await hosts.call<RemoteThreadWaitResult>("thread-wait", { link: link.id })).reason).toBe("gone");
    await expect(hosts.call("thread-send", { link: gone.id, text: "x" })).rejects.toThrow(/deleted/u);
  });

  it("there: a turn still reads running while its answer is read, so a report never says idle without it", async () => {
    const hosts = await twoHosts();
    const link = await hosts.call<RemoteThreadLink>("thread-start", { machine: "rex", cwd: hosts.work, prompt: "hi" });
    const thread = hosts.sessions.threads.get((await started(hosts, link.id)).thread!)!;
    const report = async () => ((await hosts.rex.invoke(ID, HOSTED_COMMANDS.reports, { protocol: 1, threads: [thread.id] }, hosts.paired)) as { reports: HostedThreadReport[] }).reports[0]!;
    const before = await report();
    let release!: () => void;
    thread.transcriptGate = new Promise((resolve) => { release = resolve; });
    const finishing = hosts.sessions.finish(thread, "apple");
    // A reconnect asks now: the same revision must be the same state (usage is read live).
    expect(await report()).toMatchObject({ state: "running", turns: 0, revision: before.revision });
    release();
    await finishing;
    expect(await report()).toMatchObject({ state: "idle", outcome: "completed", lastMessage: "apple", revision: before.revision + 1 });
  });
});
