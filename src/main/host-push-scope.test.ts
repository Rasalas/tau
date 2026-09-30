import { describe, expect, it } from "vitest";
import type { HostPushEvent } from "../shared/host-transport.js";
import { HostPushFilter, hostPushScope } from "./host-push-scope.js";

const detail = (sessionId: string, requestId?: string): HostPushEvent => ({
  type: "host-update",
  update: {
    version: 1,
    type: "thread-detail",
    detail: { sessionId, messages: [], isStreaming: false, activeTools: [], ...(requestId ? { requestId } : {}) } as never,
  },
});

describe("host push scope", () => {
  it("scopes a thread's stream to that thread and leaves state for everyone", () => {
    expect(hostPushScope({ type: "assistant-delta", sessionId: "s1", id: "a", delta: "x" })).toBe("thread:s1");
    expect(hostPushScope({ type: "tool-update-delta", sessionId: "s1", id: "t", after: 1, keep: 0, drop: 0, text: "" })).toBe("thread:s1");
    expect(hostPushScope({ type: "user-message", sessionId: "s1", message: { id: "u", role: "user", text: "", timestamp: 1 } })).toBe("thread:s1");
    expect(hostPushScope(detail("s1"))).toBe("thread:s1");
    expect(hostPushScope({ type: "event-log", label: "x", timestamp: 1, sessionId: "s1" })).toBe("thread:s1");
    // What every client needs whatever it shows.
    expect(hostPushScope({ type: "agent-status", sessionId: "s1", running: true })).toBeUndefined();
    expect(hostPushScope({ type: "new-thread-delivery-settled", sessionId: "s1", clientMessageId: "c", accepted: true })).toBeUndefined();
    expect(hostPushScope({ type: "extension-ui-prompt", sessionId: "s1", prompt: { id: "p" } as never })).toBeUndefined();
    expect(hostPushScope({ type: "host-update", update: { version: 1, type: "run", event: "settled", sessionId: "s1" } })).toBeUndefined();
    expect(hostPushScope({ type: "thread-index", threadIndex: { projects: [], sessions: [] } })).toBeUndefined();
    expect(hostPushScope({ type: "event-log", label: "x", timestamp: 1 })).toBeUndefined();
    expect(hostPushScope({ type: "job-progress", jobId: "j", message: "" })).toBeUndefined();
  });

  it("scopes an extension event when it names a topic, and a sign-in to the clients that may sign in", () => {
    expect(hostPushScope({ type: "extension-event", extensionId: "tau.terminal", name: "sessions" })).toBeUndefined();
    expect(hostPushScope({ type: "extension-event", extensionId: "tau.codex", name: "sign-in", payload: {} })).toBe("writers");
    // A filter is about threads and topics: a sign-in passes it, and the transport decides by access.
    expect(new HostPushFilter({ threads: [], topics: [] }).admits({ type: "extension-event", extensionId: "tau.codex", name: "sign-in" })).toBe(true);
    expect(hostPushScope({ type: "extension-event", extensionId: "tau.terminal", name: "data", topic: "output/1" })).toBe("topic:tau.terminal/output/1");
  });

  it("lets through what is subscribed and everything unscoped", () => {
    const filter = new HostPushFilter({ threads: ["s1"], topics: ["tau.terminal/output/1"] });
    expect(filter.admits({ type: "assistant-delta", sessionId: "s1", id: "a", delta: "x" })).toBe(true);
    expect(filter.admits({ type: "assistant-delta", sessionId: "s2", id: "a", delta: "x" })).toBe(false);
    expect(filter.admits({ type: "agent-status", sessionId: "s2", running: true })).toBe(true);
    expect(filter.admits({ type: "extension-event", extensionId: "tau.terminal", name: "data", topic: "output/1" })).toBe(true);
    expect(filter.admits({ type: "extension-event", extensionId: "tau.terminal", name: "data", topic: "output/2" })).toBe(false);
  });

  it("follows the thread a new-thread request created until the client lists it", () => {
    const awaiting = new HostPushFilter({ threads: ["s1"], topics: [], requests: ["new-thread-1"] });
    expect(awaiting.admits(detail("s9"))).toBe(false);
    expect(awaiting.admits(detail("s2", "new-thread-1"))).toBe(true);
    expect(awaiting.admits({ type: "assistant-start", sessionId: "s2", id: "a", timestamp: 1 })).toBe(true);
    // The request is done, the thread not yet listed: still followed.
    const released = new HostPushFilter({ threads: ["s1"], topics: [] }, awaiting);
    expect(released.admits({ type: "assistant-start", sessionId: "s2", id: "a", timestamp: 1 })).toBe(true);
    expect(released.addedThreads(awaiting)).toEqual([]);
    // Listed and later dropped: gone like any other thread.
    const listed = new HostPushFilter({ threads: ["s2"], topics: [] }, released);
    expect(listed.addedThreads(released)).toEqual([]);
    const moved = new HostPushFilter({ threads: ["s1"], topics: [] }, listed);
    expect(moved.admits({ type: "assistant-start", sessionId: "s2", id: "a", timestamp: 1 })).toBe(false);
    expect(moved.addedThreads(listed)).toEqual(["s1"]);
  });

  it("adds nothing when the connection received every push before", () => {
    expect(new HostPushFilter({ threads: ["s1"], topics: [] }).addedThreads(undefined)).toEqual([]);
  });
});
