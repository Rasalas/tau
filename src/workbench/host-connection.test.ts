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
  push(seq: number, event: HostPushEvent): void;
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
    push: (seq, event) => { for (const listener of pushListeners) listener({ seq, event }); },
    reopen: () => { for (const listener of openListeners) listener(); },
    transport: {
      platform: "test",
      request: async (method, params): Promise<HostResponse> => {
        state.calls.push({ method, params });
        if (method === "hello") {
          const lastSeq = (params[0] as { lastSeq?: number }).lastSeq;
          const missed = lastSeq === undefined ? [] : state.buffered.filter((push) => push.seq > lastSeq);
          const resync = lastSeq !== undefined && state.buffered.length > 0 && lastSeq < state.buffered[0]!.seq - 1;
          return { id: "1", result: { protocol: 1, hostVersion: "0", capabilities: ["jobs", "replay"], resync, missed: resync ? [] : missed, nextSeq: state.nextSeq } };
        }
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

  it("learns which methods the host wants run as jobs", async () => {
    const link = harness();
    const connection = new HostConnection(link.transport);
    await connection.start();
    expect(connection.isJobMethod("rebuild-workbench")).toBe(false);
    await connection.refreshJobMethods();
    expect(connection.isJobMethod("rebuild-workbench")).toBe(true);
    expect(connection.isJobMethod("host-extension", "tau.kit", "copy")).toBe(false);
  });
});
