import { describe, expect, it, vi } from "vitest";
import type { HostEvent, NewThreadRequestId } from "../shared/contracts.js";
import type { PiBridgeServerFrame, PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { AttachedPiSession, type AttachedSessionHost } from "./attached-pi-session.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";

function snapshot(overrides: Partial<PiBridgeSnapshot> = {}): PiBridgeSnapshot {
  return {
    sessionId: "pi-session",
    sessionFile: "/tmp/pi-session.jsonl",
    cwd: "/repo",
    messages: [],
    isStreaming: false,
    supportsImageInput: false,
    models: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    activeTools: [],
    allTools: [],
    ...overrides,
  } as PiBridgeSnapshot;
}

function fakeHost() {
  const events: HostEvent[] = [];
  const logs: string[] = [];
  const sessionEvents: Array<{ event: unknown; sessionId: string }> = [];
  const snapshots: Array<NewThreadRequestId | undefined> = [];
  const host: AttachedSessionHost = {
    safeMode: false,
    clientTurns: new ClientTurnLedger(),
    emit: (event) => { events.push(event); },
    log: (label, detail) => { logs.push(detail ? `${label} ${detail}` : label); },
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    fail: vi.fn(),
    beginActivation: () => 1,
    isCurrentActivation: () => true,
    releaseLocalThread: async () => undefined,
    clearActiveThread: () => undefined,
    setCwd: vi.fn(),
    onSessionEvent: (event, sessionId) => { sessionEvents.push({ event, sessionId }); },
    onSnapshot: (requestId) => { snapshots.push(requestId); },
    onReconnected: async () => undefined,
  };
  return { host, events, logs, sessionEvents, snapshots };
}

/** A client the tests hand to the session directly; attach() is not exercised here. */
function fakeClient(command: (input: { command: string; [key: string]: unknown }, timeoutMs?: number) => Promise<unknown>) {
  return {
    descriptor: { epoch: "epoch-1", sessionId: "pi-session", sessionFile: "/tmp/pi-session.jsonl", cwd: "/repo", pid: 1, socketPath: "", token: "", startedAt: 0 },
    isConnected: true,
    command: vi.fn(command),
    close: vi.fn(),
    subscribe: () => () => undefined,
    subscribeDisconnect: () => () => undefined,
  };
}

type Internals = { handleFrame(frame: PiBridgeServerFrame, source: unknown): void };

describe("AttachedPiSession", () => {
  it("owns only the visible thread", () => {
    const { host } = fakeHost();
    const session = new AttachedPiSession(host);
    expect(session.isAttached).toBe(false);
    expect(session.owns(undefined)).toBe(false);
    session.client = fakeClient(async () => undefined) as never;
    session.snapshot = snapshot();
    expect(session.owns(undefined)).toBe(true);
    expect(session.owns("pi-session")).toBe(true);
    expect(session.owns("other")).toBe(false);
  });

  it("detaches and runs the thread itself when Pi stops answering an ordinary command", async () => {
    const { host, events, logs } = fakeHost();
    const session = new AttachedPiSession(host);
    const client = fakeClient(async () => { throw new Error("Pi bridge command 'prompt' timed out."); });
    session.client = client as never;
    session.snapshot = snapshot();
    await expect(session.command({ command: "prompt", text: "hi" })).rejects.toThrow("Tau detached from it");
    expect(session.isAttached).toBe(false);
    expect(client.close).toHaveBeenCalled();
    expect(logs).toContain("bridge.unresponsive prompt");
    expect(events).toContainEqual({ type: "agent-status", sessionId: "pi-session", running: false });
    // A retained command reports nothing and leaves the attachment alone.
    const retained = fakeClient(async () => { throw new Error("Pi bridge disconnected."); });
    session.client = retained as never;
    await expect(session.command({ command: "new_session" }, true)).resolves.toBeUndefined();
    expect(session.isAttached).toBe(true);
    // Other failures are Pi's answer, not a lost connection.
    session.client = fakeClient(async () => { throw new Error("no such skill"); }) as never;
    await expect(session.command({ command: "prompt", text: "x" })).rejects.toThrow("no such skill");
    expect(session.isAttached).toBe(true);
  });

  it("correlates a new session with the request that asked for it", async () => {
    const { host } = fakeHost();
    const session = new AttachedPiSession(host);
    const requestId = "request-1" as NewThreadRequestId;
    const reported = snapshot({ sessionId: "new-session", sessionFile: "/tmp/new.jsonl", newSessionRequestId: requestId });
    const client = fakeClient(async (input) => {
      if (input.command === "new_session") return { requestId, snapshot: reported };
      if (input.command === "new_session_ack") return { accepted: true, requestId, sessionId: "new-session", bridgeEpoch: "epoch-1" };
      return undefined;
    });
    session.client = client as never;
    session.snapshot = snapshot();
    const outcome = await session.requestNewSession({ requestId, projectPath: "/repo", initialPrompt: "hello", attachments: [] });
    expect(outcome.snapshot?.sessionId).toBe("new-session");
    await vi.waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ command: "new_session_ack", requestId, sessionId: "new-session" }), 3_000));

    // A snapshot for another request or another project is not this thread.
    session.client = fakeClient(async () => ({ requestId, snapshot: snapshot({ newSessionRequestId: "request-9" as NewThreadRequestId }) })) as never;
    await expect(session.requestNewSession({ requestId, projectPath: "/repo", attachments: [] })).rejects.toThrow("uncorrelated");
    session.client = fakeClient(async () => ({ requestId: "request-other" })) as never;
    await expect(session.requestNewSession({ requestId, projectPath: "/repo", attachments: [] })).rejects.toThrow("did not acknowledge");
  });

  it("accepts a bare acknowledgement from an older bridge and a later snapshot frame from a newer one", async () => {
    const { host, snapshots } = fakeHost();
    const session = new AttachedPiSession(host);
    const requestId = "request-2" as NewThreadRequestId;
    session.client = fakeClient(async () => undefined) as never;
    session.snapshot = undefined;
    await expect(session.requestNewSession({ requestId, projectPath: "/repo", attachments: [] })).resolves.toEqual({});

    const client = fakeClient(async (input) => (input.command === "new_session" ? { requestId } : { accepted: true, requestId, sessionId: "late", bridgeEpoch: "epoch-1" }));
    session.client = client as never;
    session.snapshot = snapshot();
    const pending = session.requestNewSession({ requestId, projectPath: "/repo", attachments: [] });
    const late = snapshot({ sessionId: "late", sessionFile: "/tmp/late.jsonl", newSessionRequestId: requestId });
    (session as unknown as Internals).handleFrame({ protocolVersion: 1, type: "snapshot", epoch: "epoch-1", seq: 1, snapshot: late } as PiBridgeServerFrame, client);
    await expect(pending).resolves.toEqual({ snapshot: late });
    expect(snapshots).toEqual([requestId]);
    expect(host.setCwd).toHaveBeenCalledWith("/repo");
  });

  it("rejects a new-thread delivery when a disconnected Pi never reports the replacement session", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const session = new AttachedPiSession(host);
    const requestId = "request-disconnected" as NewThreadRequestId;
    session.client = fakeClient(async () => { throw new Error("Pi bridge is not connected."); }) as never;
    session.snapshot = snapshot();
    let settlement = "pending";
    const pending = session.requestNewSession({ requestId, projectPath: "/repo", attachments: [] })
      .then(() => { settlement = "resolved"; }, (error: unknown) => { settlement = error instanceof Error ? error.message : String(error); });

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_001);
      expect(settlement).toBe("Pi did not report the new thread before message delivery timed out.");
    } finally {
      session.detach();
      await pending;
      vi.useRealTimers();
    }
  });

  it("routes frames: Pi's questions become answer-elsewhere prompts, events reach the host, extension events are forwarded", () => {
    const { host, events, sessionEvents } = fakeHost();
    const session = new AttachedPiSession(host);
    const client = fakeClient(async () => undefined);
    session.client = client as never;
    const internals = session as unknown as Internals;
    internals.handleFrame({ protocolVersion: 1, type: "snapshot", epoch: "epoch-1", seq: 1, snapshot: snapshot({ awaitingInput: { kind: "confirm", title: "Allow?" } }) } as PiBridgeServerFrame, client);
    expect(events.at(-1)).toMatchObject({ type: "extension-ui-prompt", sessionId: "pi-session", prompt: { id: "bridge-await-pi-session", kind: "confirm", title: "Allow?", answerElsewhere: true } });
    internals.handleFrame({ protocolVersion: 1, type: "snapshot", epoch: "epoch-1", seq: 2, snapshot: snapshot() } as PiBridgeServerFrame, client);
    expect(events.at(-1)).toEqual({ type: "extension-ui-resolved", id: "bridge-await-pi-session", sessionId: "pi-session" });
    internals.handleFrame({ protocolVersion: 1, type: "event", epoch: "epoch-1", seq: 3, sessionId: "pi-session", event: { type: "agent_start" } } as PiBridgeServerFrame, client);
    expect(sessionEvents).toEqual([{ event: { type: "agent_start" }, sessionId: "pi-session" }]);
    internals.handleFrame({ protocolVersion: 1, type: "event", epoch: "epoch-1", seq: 4, sessionId: "pi-session", event: { type: "extension-event", extensionId: "tau.workspace", name: "checkpoint", payload: { n: 1 } } } as PiBridgeServerFrame, client);
    expect(events.at(-1)).toEqual({ type: "extension-event", extensionId: "tau.workspace", name: "checkpoint", payload: { n: 1 } });
    // Frames from a client that is no longer the attachment are ignored.
    internals.handleFrame({ protocolVersion: 1, type: "event", epoch: "epoch-1", seq: 5, sessionId: "pi-session", event: { type: "agent_end" } } as PiBridgeServerFrame, {});
    expect(sessionEvents).toHaveLength(1);
  });

  it("suppresses attaching while the host takes a session over", async () => {
    const { host } = fakeHost();
    const session = new AttachedPiSession(host);
    await session.withoutAttaching(async () => {
      expect(session.suppressAttach).toBe(true);
      await expect(session.attach("/repo", undefined, {}, 1)).resolves.toBe(false);
    });
    expect(session.suppressAttach).toBe(false);
  });
});
