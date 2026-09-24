import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";
import type { HostPush, HostPushEvent, HostResponse } from "../shared/host-transport";
import { HostConnection, type HostTransport } from "./host-connection";

const bootstrap = {
  version: 1,
  threadIndex: { projects: [], sessions: [] },
  detail: { sessionId: "s1", messages: [], isStreaming: false, activeTools: [] },
  catalog: { models: [], thinkingLevel: "none", thinkingLevels: [], allTools: [], extensionCount: 0 },
  project: { cwd: "/tmp/project" },
};

interface Harness {
  transport: HostTransport;
  push(seq: number, event: HostPushEvent, prev?: number): void;
  capabilities: string[];
  /** Answers a `subscribe`; the default accepts it. */
  subscribe?: () => Promise<HostResponse>;
  reopen(): void;
  calls: Array<{ method: string; params: readonly unknown[] }>;
  buffered: HostPush[];
  nextSeq: number;
}

function harness(): Harness {
  const pushListeners = new Set<(push: HostPush) => void>();
  const openListeners = new Set<() => void>();
  const state: Harness = {
    calls: [],
    buffered: [],
    nextSeq: 1,
    capabilities: ["jobs", "replay"],
    push: (seq, event, prev) => { for (const listener of pushListeners) listener({ seq, event, ...(prev === undefined ? {} : { prev }) }); },
    reopen: () => { for (const listener of openListeners) listener(); },
    transport: {
      platform: "test",
      request: async (method, params): Promise<HostResponse> => {
        state.calls.push({ method, params });
        if (method === "hello") {
          const lastSeq = (params[0] as { lastSeq?: number }).lastSeq;
          const missed = lastSeq === undefined ? [] : state.buffered.filter((push) => push.seq > lastSeq);
          const resync = lastSeq !== undefined && state.buffered.length > 0 && lastSeq < state.buffered[0]!.seq - 1;
          return { id: "1", result: { protocol: 1, hostVersion: "0", capabilities: state.capabilities, resync, missed: resync ? [] : missed, nextSeq: state.nextSeq } };
        }
        if (method === "subscribe") return state.subscribe ? state.subscribe() : { id: "1", result: true };
        if (method === "bootstrap") return { id: "1", result: bootstrap };
        if (method === "job-methods") return { id: "1", result: ["rebuild-workbench"] };
        if (method === "start-job") return { id: "1", result: { jobId: "job-1" } };
        return { id: "1", result: undefined };
      },
      onPush: (listener) => { pushListeners.add(listener); return () => pushListeners.delete(listener); },
      onOpen: (listener) => { openListeners.add(listener); return () => openListeners.delete(listener); },
    },
  };
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const agentStatus = (running: boolean): HostPushEvent => ({ type: "agent-status", sessionId: "s1", running });

describe("host connection", () => {
  it("starts at the host's current sequence and delivers pushes in order", async () => {
    const link = harness();
    link.nextSeq = 5;
    const connection = new HostConnection(link.transport);
    await connection.start();
    const seen: HostEvent[] = [];
    connection.onEvent((event) => seen.push(event));
    link.push(5, agentStatus(true));
    link.push(6, agentStatus(false));
    expect(seen).toHaveLength(2);
    expect(connection.getState()).toBe("connected");
  });

  it("names its window in every hello, a reconnect's included", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start("desktop", "w1");
    link.reopen();
    await settle();
    const hellos = link.calls.filter((call) => call.method === "hello").map((call) => call.params[0]);
    expect(hellos).toEqual([
      expect.objectContaining({ profile: "desktop", windowId: "w1" }),
      expect.objectContaining({ profile: "desktop", windowId: "w1" }),
    ]);
  });

  it("repairs a gap by replaying the pushes the host still has", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const seen: HostPushEvent[] = [];
    connection.onEvent((event) => seen.push(event));
    link.buffered = [
      { seq: 1, event: agentStatus(true) },
      { seq: 2, event: { type: "event-log", label: "missed", timestamp: 0 } },
      { seq: 3, event: agentStatus(false) },
    ];
    link.nextSeq = 4;
    // Only the third push arrives: 1 and 2 are missing, so the connection
    // re-hellos, replays them and applies the queued third one exactly once.
    link.push(3, agentStatus(false));
    await settle();
    expect(seen.map((event) => event.type)).toEqual(["agent-status", "event-log", "agent-status"]);
    expect(link.calls.filter((call) => call.method === "hello")).toHaveLength(2);
    expect(connection.getState()).toBe("connected");
  });

  it("refetches the bootstrap when the gap fell out of the host's buffer", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const states: string[] = [];
    connection.onState((state) => states.push(state));
    const seen: HostPushEvent[] = [];
    connection.onEvent((event) => seen.push(event));
    link.buffered = [{ seq: 40, event: agentStatus(true) }];
    link.nextSeq = 41;
    link.push(40, agentStatus(true));
    await settle();
    expect(link.calls.some((call) => call.method === "bootstrap")).toBe(true);
    expect(seen.map((event) => event.type)).toEqual(["thread-index", "host-update", "host-update", "host-update"]);
    expect(states).toEqual(["reconnecting", "resyncing", "connected"]);
  });

  it("recovers after the link comes back", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    link.buffered = [{ seq: 1, event: agentStatus(true) }];
    link.nextSeq = 2;
    const seen: HostPushEvent[] = [];
    connection.onEvent((event) => seen.push(event));
    link.reopen();
    await settle();
    expect(seen).toHaveLength(1);
    expect(connection.getState()).toBe("connected");
  });

  it("stays refused once refused: no request, no reconnect, the reason kept", async () => {
    const link = harness();
    const closed = vi.fn();
    const connection = new HostConnection({ ...link.transport, close: closed });
    await connection.start();
    const states: string[] = [];
    connection.onState((state) => states.push(state));
    connection.refuse("certificate changed");
    connection.refuse("something else");
    expect(connection.getState()).toBe("refused");
    expect(connection.getRefusal()).toBe("certificate changed");
    expect(closed).toHaveBeenCalledTimes(1);
    const before = link.calls.length;
    await expect(connection.request("bootstrap")).rejects.toMatchObject({ code: "refused" });
    link.reopen();
    await settle();
    expect(link.calls.length).toBe(before);
    expect(states).toEqual(["refused"]);
  });

  it("waits for job-done and reports progress on the way", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const onProgress = vi.fn();
    const result = connection.runJob<string>("rebuild-workbench", [], onProgress);
    await settle();
    link.push(link.nextSeq, { type: "job-progress", jobId: "job-1", message: "building" });
    link.push(link.nextSeq + 1, { type: "job-done", jobId: "job-1", result: "built" });
    await expect(result).resolves.toBe("built");
    expect(onProgress).toHaveBeenCalledWith("building", undefined);
  });

  it("rejects a failed job without losing the connection", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const result = connection.runJob("host-extension", []);
    await settle();
    link.push(link.nextSeq, { type: "job-done", jobId: "job-1", error: { message: "no remote", code: "failed" } });
    await expect(result).rejects.toThrow("no remote");
    expect(connection.getState()).toBe("connected");
    await expect(connection.request("abort", [])).resolves.toBeUndefined();
  });

  it("keeps a job result that arrives before the job id does", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const slow = { ...link.transport, request: async (method: string, params: readonly unknown[]) => {
      const response = await link.transport.request(method, params);
      if (method === "start-job") link.push(link.nextSeq, { type: "job-done", jobId: "job-1", result: "early" });
      return response;
    } };
    const early = new HostConnection(slow);
    await early.start();
    await expect(early.runJob<string>("rebuild-workbench")).resolves.toBe("early");
  });

  it("rebuilds a tool's output from deltas and drops one against a push it never saw", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const outputs: string[] = [];
    connection.onEvent((event) => { if (event.type === "tool-update") outputs.push(event.output); });
    const toolDelta = (after: number, text: string, keep: number, drop = 0): HostPushEvent =>
      ({ type: "tool-update-delta", sessionId: "s1", id: "t1", after, keep, drop, text });
    link.push(1, { type: "tool-update", sessionId: "s1", id: "t1", output: "[cut]\nline 1\n" });
    link.push(2, toolDelta(1, "line 2\n", 13));
    // The tail window slid: keep the marker, drop the oldest line.
    link.push(3, toolDelta(2, "line 3\n", 6, 7));
    // Based on a push this client never saw: nothing to rebuild from.
    link.push(4, toolDelta(99, "line 4\n", 20));
    link.push(5, toolDelta(3, "line 5\n", 20));
    link.push(6, { type: "tool-update", sessionId: "s1", id: "t1", output: "[cut]\nline 5\n" });
    expect(outputs).toEqual(["[cut]\nline 1\n", "[cut]\nline 1\nline 2\n", "[cut]\nline 2\nline 3\n", "[cut]\nline 5\n"]);
    expect(connection.getState()).toBe("connected");
  });

  it("ends a tool from the output it streamed, and deferred when it never saw that push", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const ended: HostEvent[] = [];
    connection.onEvent((event) => { if (event.type === "tool-end") ended.push(event); });
    const tool = { id: "t1", name: "bash", args: {}, status: "done" as const, startedAt: 0 };
    link.push(1, { type: "tool-update", sessionId: "s1", id: "t1", output: "line 1\n" });
    link.push(2, { type: "tool-end-delta", sessionId: "s1", tool, after: 1, length: 14, keep: 7, drop: 0, text: "line 2\n" });
    link.push(3, { type: "tool-end-delta", sessionId: "s1", tool: { ...tool, id: "t2" }, after: 1, length: 40, keep: 7, drop: 0, text: "" });
    expect(ended).toEqual([
      { type: "tool-end", sessionId: "s1", tool: { ...tool, output: "line 1\nline 2\n" } },
      { type: "tool-end", sessionId: "s1", tool: { ...tool, id: "t2", outputDeferred: true, outputLength: 40 } },
    ]);
  });

  it("puts a compact detail's turn activity back from its history", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    const updates: HostEvent[] = [];
    connection.onEvent((event) => updates.push(event));
    const tools = [{ id: "t1", name: "bash", args: {}, status: "done" as const, startedAt: 0, output: "ok" }];
    const detail = { ...bootstrap.detail, turnActivityHistory: [{ id: "a1", anchorMessageId: "m1", status: "completed" as const, tools }] };
    link.push(1, { type: "thread-detail-compact", update: { version: 1, type: "thread-detail", detail }, activityFromHistory: true });
    link.push(2, { type: "thread-detail-compact", update: { version: 1, type: "thread-detail", detail }, texts: {} });
    expect(updates).toEqual([
      { type: "host-update", update: { version: 1, type: "thread-detail", detail: { ...detail, turnActivity: { tools, anchorMessageId: "m1" } } } },
      { type: "host-update", update: { version: 1, type: "thread-detail", detail } },
    ]);
  });

  describe("message text", () => {
    const message = { id: "a1", role: "assistant" as const, timestamp: 1 };
    const streamed = (link: Harness) => {
      link.push(1, { type: "assistant-start", sessionId: "s1", id: "a1", timestamp: 1 });
      link.push(2, { type: "assistant-thinking", sessionId: "s1", id: "a1", delta: "plan" });
      link.push(3, { type: "assistant-delta", sessionId: "s1", id: "a1", delta: "Hello" });
    };
    const compactDetail = (texts: Record<string, number>): HostPushEvent => ({
      type: "thread-detail-compact",
      update: { version: 1, type: "thread-detail", detail: { ...bootstrap.detail, messages: [{ ...message, id: "e1", text: "" }] } },
      texts,
    });

    it("ends a message from the text it streamed and fills a detail from that end", async () => {
      const link = harness();
      const connection = new HostConnection(link.transport);
      await connection.start();
      const events: HostEvent[] = [];
      connection.onEvent((event) => events.push(event));
      streamed(link);
      link.push(4, { type: "assistant-end-delta", sessionId: "s1", message, after: 3, text: { keep: 5, drop: 0, text: "!" }, thinking: { keep: 4, drop: 0, text: "" } });
      link.push(5, { type: "assistant-anchor", sessionId: "s1", id: "a1", sourceEntryId: "e1", timestamp: 1 });
      link.push(6, compactDetail({ e1: 4 }));
      expect(events.find((event) => event.type === "assistant-end")).toEqual({ type: "assistant-end", sessionId: "s1", message: { ...message, text: "Hello!", thinking: "plan" } });
      expect(events.at(-1)).toEqual({ type: "host-update", update: { version: 1, type: "thread-detail", detail: {
        ...bootstrap.detail, messages: [{ ...message, id: "e1", text: "Hello!", thinking: "plan" }],
      } } });
      expect(link.calls.map((call) => call.method)).toEqual(["hello"]);
    });

    it("keeps the chain across a replayed gap", async () => {
      const link = harness();
      const connection = new HostConnection(link.transport);
      await connection.start();
      const ended: HostEvent[] = [];
      connection.onEvent((event) => { if (event.type === "assistant-end") ended.push(event); });
      link.push(1, { type: "assistant-start", sessionId: "s1", id: "a1", timestamp: 1 });
      link.buffered = [
        { seq: 2, event: { type: "assistant-delta", sessionId: "s1", id: "a1", delta: "Hel" } },
        { seq: 3, event: { type: "assistant-delta", sessionId: "s1", id: "a1", delta: "lo" } },
      ];
      link.nextSeq = 5;
      link.push(4, { type: "assistant-end-delta", sessionId: "s1", message, after: 3, text: { keep: 5, drop: 0, text: "" } });
      await settle();
      expect(ended).toEqual([{ type: "assistant-end", sessionId: "s1", message: { ...message, text: "Hello" } }]);
      expect(connection.getState()).toBe("connected");
    });

    it("starts over from a snapshot when a push refers to text it never saw", async () => {
      const link = harness();
      const connection = new HostConnection(link.transport);
      await connection.start();
      const events: HostEvent[] = [];
      connection.onEvent((event) => events.push(event));
      link.nextSeq = 10;
      // Joined mid-message: the deltas it saw are not the whole text.
      link.push(1, { type: "assistant-delta", sessionId: "s1", id: "a1", delta: "lo" });
      link.push(2, { type: "assistant-end-delta", sessionId: "s1", message, after: 1, text: { keep: 2, drop: 0, text: "" } });
      await settle();
      expect(events.some((event) => event.type === "assistant-end")).toBe(false);
      expect(link.calls.map((call) => call.method)).toEqual(["hello", "hello", "bootstrap"]);
      expect(link.calls[1]!.params[0]).not.toHaveProperty("lastSeq");
      expect(events.at(-1)).toEqual({ type: "host-update", update: { version: 1, type: "thread-detail", detail: bootstrap.detail } });
      // A detail referring to an end it never saw does the same.
      link.push(10, compactDetail({ e1: 4 }));
      await settle();
      expect(link.calls.map((call) => call.method)).toEqual(["hello", "hello", "bootstrap", "hello", "bootstrap"]);
      expect(connection.getState()).toBe("connected");
    });
  });

  it("learns which methods the host wants run as jobs", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    expect(connection.isJobMethod("rebuild-workbench")).toBe(false);
    await connection.refreshJobMethods();
    expect(connection.isJobMethod("rebuild-workbench")).toBe(true);
    expect(connection.isJobMethod("host-extension", "tau.kit", "copy")).toBe(false);
  });

  describe("subscriptions", () => {
    const delta = (sessionId: string): HostPushEvent => ({ type: "assistant-delta", sessionId, id: "a", delta: "x" });
    const subscribing = () => {
      const link = harness();
      link.capabilities = ["jobs", "replay", "subscriptions"];
      return link;
    };
    const methods = (link: Harness) => link.calls.map((call) => call.method);
    const subscriptions = (link: Harness) => link.calls.filter((call) => call.method === "subscribe").map((call) => call.params[0]);

    it("takes a push the host marks as following skipped ones without asking for a replay", async () => {
      const link = subscribing();
      const connection = new HostConnection(link.transport);
      await connection.start();
      const seen: number[] = [];
      connection.onEvent(() => seen.push(seen.length));
      link.push(1, delta("s1"));
      link.push(4, delta("s1"), 1);
      link.push(5, delta("s1"));
      await settle();
      expect(seen).toHaveLength(3);
      expect(methods(link)).toEqual(["hello"]);
      // A mark that names a push this client never got is still a gap.
      link.push(9, delta("s1"), 7);
      await settle();
      expect(methods(link)).toEqual(["hello", "hello"]);
    });

    it("says what it watches before its next request, and only once it is limited", async () => {
      const link = subscribing();
      const connection = new HostConnection(link.transport);
      await connection.start();
      const stopFirst = connection.watchThread("s1");
      await settle();
      expect(subscriptions(link)).toEqual([]);
      connection.limitToWatched();
      connection.watchTopic("tau.terminal", "output/1");
      connection.watchNewThread("new-thread-1");
      stopFirst();
      connection.watchThread("s2");
      await connection.request("switch-session", ["/s2"]);
      expect(methods(link)).toEqual(["hello", "subscribe", "switch-session"]);
      expect(subscriptions(link)).toEqual([{ threads: ["s2"], topics: ["tau.terminal/output/1"], requests: ["new-thread-1"] }]);
      await settle();
      // Nothing changed since: nothing more is sent.
      await connection.request("switch-session", ["/s2"]);
      expect(subscriptions(link)).toHaveLength(1);
    });

    it("sends no subscription to a host that does not take one", async () => {
      const link = harness();
      const connection = new HostConnection(link.transport);
      await connection.start();
      connection.watchThread("s1");
      connection.limitToWatched();
      await settle();
      expect(methods(link)).toEqual(["hello"]);
    });

    it("replays with what the host confirmed, then asks again for what it wants", async () => {
      const link = subscribing();
      const connection = new HostConnection(link.transport);
      await connection.start();
      connection.watchThread("s1");
      connection.limitToWatched();
      await settle();
      // The link drops before the host answers the next one.
      link.subscribe = () => new Promise(() => undefined);
      connection.watchThread("s2");
      await settle();
      link.subscribe = undefined;
      link.push(1, delta("s1"));
      link.reopen();
      await settle();
      const hellos = link.calls.filter((call) => call.method === "hello").map((call) => call.params[0]);
      expect(hellos[1]).toMatchObject({ lastSeq: 1, subscription: { threads: ["s1"], topics: [] } });
      expect(subscriptions(link).at(-1)).toEqual({ threads: ["s1", "s2"], topics: [] });
      expect(methods(link).slice(-2)).toEqual(["hello", "subscribe"]);
    });

    it("starts over without a subscription when a filtered replay cannot be repaired", async () => {
      const link = subscribing();
      const connection = new HostConnection(link.transport);
      await connection.start();
      connection.watchThread("s1");
      connection.limitToWatched();
      await settle();
      link.push(1, delta("s1"));
      link.buffered = [{ seq: 5, event: delta("s1") }];
      link.nextSeq = 6;
      link.reopen();
      await settle();
      await settle();
      const hellos = link.calls.filter((call) => call.method === "hello").map((call) => call.params[0] as Record<string, unknown>);
      expect(hellos.slice(1).map((hello) => [hello.lastSeq, hello.subscription !== undefined])).toEqual([[1, true], [undefined, false]]);
      // The snapshot first, then what it watches: nothing streamed in between is lost.
      expect(methods(link).slice(-3)).toEqual(["hello", "bootstrap", "subscribe"]);
      expect(connection.getState()).toBe("connected");
    });
  });
});
