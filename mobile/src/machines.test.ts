import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadIndexSnapshot, UiSession } from "../../src/shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../../src/shared/host-protocol";
import { HOST_CLOSE_CODE } from "../../src/shared/host-transport";
import { createMemoryStorage } from "../../src/workbench/client-storage";
import type { HostConnectionState } from "../../src/workbench/host-connection";
import type { SavedHost } from "./hosts";
import type { LinkSocket } from "./machine-link";
import { ARRIVAL_KEY, MACHINES_FOCUS_MIN_MS, MACHINES_REFRESH_MS, MACHINES_START_MS, PhoneMachines } from "./machines";
import type { AppRoute } from "./routes";
import { hostStorage } from "./storage";

afterEach(() => { vi.useRealTimers(); });

const saved = (id: string, name = id): SavedHost => ({ id, name, endpoints: [{ url: `https://${id}.test:7788/` }], access: "full", addedAt: "2026-09-01T00:00:00.000Z" });

const session = (id: string, modifiedAt: number, patch: Partial<UiSession> = {}): UiSession => ({
  id, path: `/s/${id}.jsonl`, title: `Thread ${id}`, modifiedAt, projectPath: "/p/api", projectName: "api", messageCount: 2, ...patch,
});

/** A host at the other end of a link: answers hello, bootstrap and the few calls a visit makes. */
class FakeHost {
  seq = 10;
  index: ThreadIndexSnapshot = { projects: [{ path: "/p/api", name: "api", lastOpenedAt: 1, workspaceId: "ws-api" } as never], sessions: [session("a", 100), session("b", 50)], runs: { a: 90 } };
  hellos: Array<Record<string, unknown>> = [];
  calls: string[] = [];
  sockets: FakeSocket[] = [];
  reachable = true;
  refuse = false;
  missed: unknown[] = [];
  resync = false;
  readCommands: Record<string, string[]> = { "tau.usage": ["limits"] };

  socket = (): LinkSocket => {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (!this.reachable) { socket.fire(1006, "unreachable"); return; }
      socket.readyState = 1;
      socket.onopen?.();
    });
    return socket;
  };

  push(event: unknown): void {
    this.seq += 1;
    for (const socket of this.sockets.filter((entry) => entry.readyState === 1)) socket.deliver({ type: "push", push: { seq: this.seq, event } });
  }
}

class FakeSocket implements LinkSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly host: FakeHost) {}
  deliver(frame: unknown): void { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) })); }
  fire(code: number, reason?: string): void { this.readyState = 3; this.onclose?.({ code, ...(reason ? { reason } : {}) }); }
  close(): void { if (this.readyState !== 3) this.fire(1000); }
  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; hello?: Record<string, unknown>; request?: { id: string; method: string; params: unknown[] } };
    if (frame.type === "hello") {
      this.host.hellos.push(frame.hello!);
      if (this.host.refuse) { queueMicrotask(() => this.fire(HOST_CLOSE_CODE.unauthorized, "revoked")); return; }
      const missed = frame.hello!.lastSeq === undefined ? [] : this.host.missed;
      this.deliver({ type: "hello-reply", id: "hello", reply: { protocol: 1, hostVersion: "0.7.14", capabilities: ["replay"], resync: this.host.resync, missed, nextSeq: this.host.seq + 1 } });
      return;
    }
    const { id, method, params } = frame.request!;
    this.host.calls.push(method);
    const result = method === "bootstrap" ? { threadIndex: this.host.index }
      : method === "update-status" ? { version: "0.7.14", phase: "current", automatic: true }
        : method === "host-extensions" ? Object.entries(this.host.readCommands).map(([extension, readCommands]) => ({ id: extension, readCommands }))
          : method === "host-extension" ? { answered: params }
            : undefined;
    this.deliver({ type: "response", response: { id, result } });
  }
}

function fakeClient(state: HostConnectionState = "connected") {
  const listeners = new Set<(next: HostConnectionState) => void>();
  return {
    getConnectionState: () => state,
    onConnectionState: (listener: (next: HostConnectionState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: HostConnectionState) { state = next; for (const listener of listeners) listener(next); },
  };
}

function setup(options: { rexToken?: string | undefined; visible?: boolean } = {}) {
  const hosts = { mac: saved("mac", "Mac"), rex: saved("rex", "rex") };
  const fake = new FakeHost();
  const storage = createMemoryStorage();
  const routes: AppRoute[] = [];
  const forgotten: string[] = [];
  let visible = options.visible ?? true;
  const visibilityListeners = new Set<() => void>();
  const client = fakeClient();
  const machines = new PhoneMachines({
    hosts: async () => [{ host: hosts.mac, token: "t-mac" }, { host: hosts.rex, ...("rexToken" in options ? (options.rexToken ? { token: options.rexToken } : {}) : { token: "t-rex" }) }],
    storage,
    shown: hosts.mac,
    client,
    socket: () => fake.socket(),
    navigate: (route) => routes.push(route),
    forgetToken: async (id) => { forgotten.push(id); },
    rename: async () => undefined,
    remove: async () => undefined,
    visibility: {
      visible: () => visible,
      subscribe: (listener) => { visibilityListeners.add(listener); return () => visibilityListeners.delete(listener); },
    },
    lingerMs: 1_000,
  });
  const setVisible = (next: boolean) => { visible = next; for (const listener of visibilityListeners) listener(); };
  return { machines, fake, storage, routes, forgotten, client, setVisible, hosts };
}

const rexOf = (machines: PhoneMachines) => machines.getSnapshot()?.environments.find((entry) => entry.id === "rex");

describe("PhoneMachines", () => {
  it("lists every paired host, the shown one first, and reads the others after a moment", async () => {
    vi.useFakeTimers();
    const { machines, fake } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.getSnapshot()?.shown).toBe("mac");
    expect(machines.getSnapshot()?.environments.map((entry) => [entry.id, entry.status])).toEqual([["mac", "connected"], ["rex", "connecting"]]);
    expect(fake.hellos).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS);
    const rex = rexOf(machines)!;
    expect(rex.status).toBe("connected");
    expect(rex.threads.map((thread) => [thread.id, thread.running ?? false])).toEqual([["a", true], ["b", false]]);
    expect(rex.projects[0]?.workspaceId).toBe("ws-api");
    // An auxiliary hello that follows no thread and no topic.
    expect(fake.hellos[0]).toMatchObject({ auxiliary: true, subscription: { threads: [], topics: [] }, token: "t-rex" });
    expect(fake.hellos[0]).not.toHaveProperty("lastSeq");
    expect(fake.calls).toEqual(["bootstrap", "update-status"]);
  });

  it("closes an idle link, reads again at a calm interval by replay, and not while the app is away", async () => {
    vi.useFakeTimers();
    const { machines, fake, setVisible } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sockets.at(-1)!.readyState).toBe(3);
    fake.missed = [{ seq: 12, event: { type: "host-update", update: { version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: "c", shell: session("c", 200) } } } }, { seq: 13, event: { type: "agent-status", sessionId: "a", running: false } }];
    fake.seq = 13;
    await vi.advanceTimersByTimeAsync(MACHINES_REFRESH_MS);
    expect(fake.hellos[1]).toMatchObject({ lastSeq: 10 });
    expect(fake.calls.filter((call) => call === "bootstrap")).toHaveLength(1);
    expect(rexOf(machines)!.threads.map((thread) => [thread.id, thread.running ?? false])).toEqual([["c", false], ["a", false], ["b", false]]);
    setVisible(false);
    await vi.advanceTimersByTimeAsync(MACHINES_REFRESH_MS * 3);
    expect(fake.hellos).toHaveLength(2);
    // Back in front: read at once.
    setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.hellos).toHaveLength(3);
    expect(fake.hellos[2]).toMatchObject({ lastSeq: 13 });
    // Again in front soon after: no second read.
    setVisible(false);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(MACHINES_FOCUS_MIN_MS - 1_000);
    expect(fake.hellos).toHaveLength(3);
  });

  it("takes a snapshot again when the host cannot replay the gap", async () => {
    vi.useFakeTimers();
    const { machines, fake } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS + 1_000);
    fake.resync = true;
    fake.index = { ...fake.index, sessions: [session("z", 500)], runs: {} };
    await vi.advanceTimersByTimeAsync(MACHINES_REFRESH_MS);
    expect(fake.calls.filter((call) => call === "bootstrap")).toHaveLength(2);
    expect(rexOf(machines)!.threads.map((thread) => thread.id)).toEqual(["z"]);
  });

  it("keeps an unreachable host's threads, greyed as offline, and a reload shows them at once", async () => {
    vi.useFakeTimers();
    const first = setup();
    first.machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS + 1_000);
    first.fake.reachable = false;
    await vi.advanceTimersByTimeAsync(MACHINES_REFRESH_MS);
    const rex = rexOf(first.machines)!;
    expect(rex.status).toBe("offline");
    expect(rex.lastSeenAt).toBeDefined();
    expect(rex.threads).toHaveLength(2);
    // The next page (a machine switch reloads the app) starts from what was kept.
    const again = new PhoneMachines({ ...optionsOf(first), storage: first.storage });
    again.getSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(rexOf(again)!.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(rexOf(again)!.status).toBe("offline");
    again.dispose();
  });

  it("marks a host that refused the token and drops the token, as opening it would", async () => {
    vi.useFakeTimers();
    const { machines, fake, forgotten } = setup();
    fake.refuse = true;
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS);
    expect(rexOf(machines)).toMatchObject({ status: "refused" });
    expect(forgotten).toEqual(["rex"]);
    await vi.advanceTimersByTimeAsync(MACHINES_REFRESH_MS);
    expect(fake.hellos).toHaveLength(1);
  });

  it("shows a host without a token as refused and never connects to it", async () => {
    vi.useFakeTimers();
    const { machines, fake } = setup({ rexToken: undefined });
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS);
    expect(rexOf(machines)).toMatchObject({ status: "refused" });
    expect(fake.sockets).toHaveLength(0);
  });

  it("follows the shown host's own connection", async () => {
    vi.useFakeTimers();
    const { machines, client } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    client.set("reconnecting");
    expect(machines.getSnapshot()?.environments[0]).toMatchObject({ id: "mac", status: "offline" });
    client.set("connected");
    expect(machines.getSnapshot()?.environments[0]).toMatchObject({ status: "connected" });
  });

  it("marks the threads the phone settled while it showed that host", async () => {
    vi.useFakeTimers();
    const { machines, storage } = setup();
    hostStorage(storage, "rex").set("tau.preferences.v1", JSON.stringify({ settledThreadIds: ["b"] }));
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS + 1_000);
    expect(rexOf(machines)!.threads.map((thread) => [thread.id, thread.settled ?? false])).toEqual([["a", false], ["b", true]]);
  });

  it("opens a thread there by its id, and carries a new thread's draft to the next page", async () => {
    vi.useFakeTimers();
    const { machines, routes, storage } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(MACHINES_START_MS + 1_000);
    await machines.open("rex", { thread: { path: "/s/b.jsonl" } });
    expect(routes.at(-1)).toEqual({ view: "workbench", hostId: "rex", threadId: "b" });
    await machines.open("rex", { newThread: { draft: "Fix it", workspaceId: "ws-api" } });
    expect(routes.at(-1)).toEqual({ view: "workbench", hostId: "rex" });
    expect(JSON.parse(storage.get(ARRIVAL_KEY)!)).toEqual({ machine: "rex", target: { newThread: { draft: "Fix it", workspaceId: "ws-api" } } });
    // Only the page on that host takes it.
    expect(await machines.takeArrival()).toBeUndefined();
    await expect(machines.open("nowhere")).rejects.toThrow(/not paired/);
  });

  it("reads a kit's command there only when that host lists it as reading, over the same link", async () => {
    vi.useFakeTimers();
    const { machines, fake } = setup();
    machines.getSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    const answer = machines.readExtension("rex", "tau.usage", "limits", { a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(answer).resolves.toEqual({ answered: ["tau.usage", "limits", { a: 1 }] });
    const refused = expect(machines.readExtension("rex", "tau.usage", "delete-everything")).rejects.toThrow(/only reads/);
    await vi.advanceTimersByTimeAsync(0);
    await refused;
    expect(fake.sockets).toHaveLength(1);
    expect(fake.calls).toEqual(["host-extensions", "host-extension"]);
  });
});

function optionsOf(setupResult: ReturnType<typeof setup>): ConstructorParameters<typeof PhoneMachines>[0] {
  return {
    hosts: async () => [{ host: setupResult.hosts.mac, token: "t-mac" }, { host: setupResult.hosts.rex, token: "t-rex" }],
    storage: setupResult.storage,
    shown: setupResult.hosts.mac,
    client: fakeClient(),
    socket: () => setupResult.fake.socket(),
    navigate: () => undefined,
    forgetToken: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    visibility: { visible: () => true, subscribe: () => () => undefined },
    lingerMs: 1_000,
  };
}
