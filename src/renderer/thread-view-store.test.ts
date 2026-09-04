// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, HostEvent, UiMessage, UiToolRun } from "../shared/contracts";
import { createThreadViewState, reduceHostEvent, ThreadViewStore, type ThreadViewState } from "./thread-view-store";

const SESSION = "active";

function state(overrides: Partial<ThreadViewState> = {}): ThreadViewState {
  return { ...createThreadViewState(), activeThreadId: SESSION, ...overrides };
}

function userMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return { id: "user-1", role: "user", text: "hello", timestamp: 10, ...overrides };
}

function tool(overrides: Partial<UiToolRun> = {}): UiToolRun {
  return { id: "tool-1", name: "read", args: {}, status: "running", startedAt: 1, ...overrides };
}

function reduceAll(initial: ThreadViewState, events: readonly HostEvent[]): ThreadViewState {
  return events.reduce(reduceHostEvent, initial);
}

describe("reduceHostEvent", () => {
  it("leaves the view alone for events other collaborators own", () => {
    const initial = state();
    const events: HostEvent[] = [
      { type: "host-update", update: { version: 1, type: "project", project: { cwd: "/repo" } } },
      { type: "thread-index", threadIndex: { projects: [], sessions: [] } },
      { type: "extension-event", extensionId: "kit", name: "ping" },
      { type: "new-thread-delivery-settled", sessionId: SESSION, clientMessageId: "c1", accepted: true },
    ];
    expect(reduceAll(initial, events)).toBe(initial);
  });

  it("ignores runtime events from a background thread", () => {
    const initial = state();
    const events: HostEvent[] = [
      { type: "assistant-start", sessionId: "other", id: "a", timestamp: 1 },
      { type: "assistant-delta", sessionId: "other", id: "a", delta: "hidden" },
      { type: "assistant-thinking", sessionId: "other", id: "a", delta: "hidden" },
      { type: "assistant-end", sessionId: "other", message: { id: "a", role: "assistant", text: "hi", timestamp: 1 } },
      { type: "assistant-anchor", sessionId: "other", id: "a", sourceEntryId: "e1", timestamp: 1 },
      { type: "user-message", sessionId: "other", message: userMessage() },
      { type: "tool-start", sessionId: "other", tool: tool() },
      { type: "tool-update", sessionId: "other", id: "tool-1", output: "x" },
      { type: "tool-end", sessionId: "other", tool: tool({ status: "done" }) },
      { type: "queue", sessionId: "other", steering: [], followUp: [] },
      { type: "agent-status", sessionId: "other", running: true },
      { type: "notice", sessionId: "other", message: "nope", level: "info" },
      { type: "error", sessionId: "other", message: "nope" },
      { type: "event-log", sessionId: "other", label: "nope", timestamp: 1 },
      { type: "extension-ui-resolved", sessionId: "other", id: "p1" },
    ];
    expect(reduceAll(initial, events)).toBe(initial);
  });

  it("opens a new activity group when a run starts and keeps tools when it stops", () => {
    const running = reduceHostEvent(
      state({ tools: [tool()], toolAnchorId: "user-1" }),
      { type: "agent-status", sessionId: SESSION, running: true },
    );
    expect(running.tools).toEqual([]);
    expect(running.toolAnchorId).toBeUndefined();
    expect(running.turnActivitySessionId).toBe(SESSION);

    const stopped = reduceHostEvent(running, { type: "agent-status", sessionId: SESSION, running: false });
    expect(stopped).toBe(running);
  });

  it("streams an assistant row from its first delta and keeps its start time", () => {
    const next = reduceAll(state(), [
      { type: "assistant-start", sessionId: SESSION, id: "a", timestamp: 42 },
      { type: "assistant-delta", sessionId: SESSION, id: "a", delta: "he" },
      { type: "assistant-delta", sessionId: SESSION, id: "a", delta: "llo" },
      { type: "assistant-thinking", sessionId: SESSION, id: "a", delta: "why" },
    ]);
    expect(next.transcript.messages).toEqual([{ id: "a", role: "assistant", text: "hello", thinking: "why", timestamp: 42 }]);
    expect(next.transcript.tokenEstimate).toBeGreaterThan(0);
  });

  it("replaces a streamed row at assistant-end and drops an empty one", () => {
    const streamed = reduceAll(state(), [
      { type: "assistant-start", sessionId: SESSION, id: "a", timestamp: 1 },
      { type: "assistant-delta", sessionId: SESSION, id: "a", delta: "draft" },
    ]);
    const finished = reduceHostEvent(streamed, {
      type: "assistant-end",
      sessionId: SESSION,
      message: { id: "a", role: "assistant", text: "final", timestamp: 1 },
    });
    expect(finished.transcript.messages.map((message) => message.text)).toEqual(["final"]);
    expect(finished.assistantStarts.has("a")).toBe(false);

    const emptied = reduceHostEvent(streamed, {
      type: "assistant-end",
      sessionId: SESSION,
      message: { id: "a", role: "assistant", text: "", timestamp: 1 },
    });
    expect(emptied.transcript.messages).toEqual([]);
  });

  it("appends an assistant-end message the transcript has never seen", () => {
    const next = reduceHostEvent(state(), {
      type: "assistant-end",
      sessionId: SESSION,
      message: { id: "a", role: "assistant", text: "done", timestamp: 1 },
    });
    expect(next.transcript.messages.map((message) => message.id)).toEqual(["a"]);
  });

  it("parks an anchor until its row exists and stamps the entry id once it does", () => {
    const parked = reduceHostEvent(state(), {
      type: "assistant-anchor", sessionId: SESSION, id: "a", sourceEntryId: "entry-1", timestamp: 5, beforeMessageId: "b",
    });
    expect(parked.assistantAnchors.get("entry-1")).toEqual({ id: "a", timestamp: 5, beforeMessageId: "b" });

    const withRow = reduceAll(state(), [
      { type: "assistant-end", sessionId: SESSION, message: { id: "a", role: "assistant", text: "done", timestamp: 1 } },
      { type: "assistant-anchor", sessionId: SESSION, id: "a", sourceEntryId: "entry-1", timestamp: 5 },
    ]);
    expect(withRow.transcript.messages[0].sourceEntryId).toBe("entry-1");
    expect(withRow.assistantAnchors.size).toBe(0);
  });

  describe("user-message deduplication", () => {
    it("appends a message the transcript does not have", () => {
      const next = reduceHostEvent(state(), { type: "user-message", sessionId: SESSION, message: userMessage() });
      expect(next.transcript.messages.map((message) => message.id)).toEqual(["user-1"]);
    });

    it("replaces the row when the same message arrives under the same id", () => {
      const seeded = reduceHostEvent(state(), { type: "user-message", sessionId: SESSION, message: userMessage() });
      const next = reduceHostEvent(seeded, {
        type: "user-message", sessionId: SESSION, message: userMessage({ text: "hello", sourceEntryId: "entry-1" }),
      });
      expect(next.transcript.messages).toHaveLength(1);
      expect(next.transcript.messages[0].sourceEntryId).toBe("entry-1");
    });

    it("does not append when the same client message already exists under another id", () => {
      const seeded = reduceHostEvent(state(), {
        type: "user-message", sessionId: SESSION, message: userMessage({ id: "persisted", clientMessageId: "c1" }),
      });
      const next = reduceHostEvent(seeded, {
        type: "user-message", sessionId: SESSION, message: userMessage({ id: "live", clientMessageId: "c1", text: "changed" }),
      });
      expect(next.transcript.messages.map((message) => message.id)).toEqual(["persisted"]);
      expect(next.transcript.messages[0].text).toBe("hello");
    });

    it("treats two client turns with the same client message id as different messages", () => {
      const seeded = reduceHostEvent(state(), {
        type: "user-message",
        sessionId: SESSION,
        message: userMessage({ id: "first", clientMessageId: "c1", clientTurnId: "turn-1" }),
      });
      const next = reduceHostEvent(seeded, {
        type: "user-message",
        sessionId: SESSION,
        message: userMessage({ id: "second", clientMessageId: "c1", clientTurnId: "turn-2", timestamp: 11 }),
      });
      expect(next.transcript.messages.map((message) => message.id)).toEqual(["first", "second"]);
    });

    it("falls back to the source entry id before id and timestamp", () => {
      const seeded = reduceHostEvent(state(), {
        type: "user-message", sessionId: SESSION, message: userMessage({ id: "persisted", sourceEntryId: "entry-1" }),
      });
      const next = reduceHostEvent(seeded, {
        type: "user-message", sessionId: SESSION, message: userMessage({ id: "live", sourceEntryId: "entry-1" }),
      });
      expect(next.transcript.messages.map((message) => message.id)).toEqual(["persisted"]);

      const byTimestamp = reduceHostEvent(seeded, {
        type: "user-message", sessionId: SESSION, message: userMessage({ id: "other" }),
      });
      expect(byTimestamp.transcript.messages).toHaveLength(1);
    });

    it("reconciles the optimistic row the confirmed message belongs to", () => {
      const optimistic = { scope: "session:active", message: userMessage({ id: "local-c1", clientMessageId: "c1", clientTurnId: "turn-1" }) };
      const next = reduceHostEvent(state({ optimisticMessages: [optimistic] }), {
        type: "user-message",
        sessionId: SESSION,
        message: userMessage({ id: "persisted", clientMessageId: "c1", clientTurnId: "turn-1" }),
      });
      expect(next.optimisticMessages).toEqual([]);
    });
  });

  it("drops the optimistic row when a prompt answers without a user turn or fails", () => {
    const optimistic = { scope: "session:active", message: userMessage({ clientMessageId: "c1" }) };
    const withoutTurn = reduceHostEvent(state({ optimisticMessages: [optimistic] }), {
      type: "prompt-without-user-turn", sessionId: SESSION, clientMessageId: "c1",
    });
    expect(withoutTurn.optimisticMessages).toEqual([]);

    const failed = reduceHostEvent(state({ optimisticMessages: [optimistic] }), {
      type: "user-message-failed", sessionId: SESSION, clientMessageId: "c1", message: "rejected",
    });
    expect(failed.optimisticMessages).toEqual([]);
  });

  it("anchors the first tool of a turn to the last message with text", () => {
    const seeded = state({
      transcript: reduceHostEvent(state(), { type: "user-message", sessionId: SESSION, message: userMessage() }).transcript,
    });
    const started = reduceHostEvent(seeded, { type: "tool-start", sessionId: SESSION, tool: tool() });
    expect(started.toolAnchorId).toBe("user-1");
    expect(started.tools).toHaveLength(1);

    const updated = reduceHostEvent(started, { type: "tool-update", sessionId: SESSION, id: "tool-1", output: "partial" });
    expect(updated.tools[0].output).toBe("partial");
    expect(reduceHostEvent(updated, { type: "tool-update", sessionId: SESSION, id: "tool-1", output: "partial" })).toBe(updated);

    const ended = reduceHostEvent(updated, { type: "tool-end", sessionId: SESSION, tool: tool({ status: "done", output: "full" }) });
    expect(ended.tools).toEqual([tool({ status: "done", output: "full" })]);
  });

  it("records notices, errors, log entries and queue changes", () => {
    const notice = reduceHostEvent(state(), { type: "notice", sessionId: SESSION, message: "saved", level: "warning" });
    expect(notice.notice).toEqual({ message: "saved", level: "warning" });

    const error = reduceHostEvent(state(), { type: "error", message: "broken" });
    expect(error.notice).toEqual({ message: "broken", level: "info" });

    const logged = reduceHostEvent(state(), { type: "event-log", label: "thread.switch", detail: "12ms", timestamp: 7 });
    expect(logged.events).toEqual([{ id: "7-0", label: "thread.switch", detail: "12ms", timestamp: 7 }]);

    const queued = reduceHostEvent(state(), { type: "queue", sessionId: SESSION, steering: ["a"], followUp: ["b", "c"] });
    expect(queued.events[0].label).toBe("queue.changed");
    expect(queued.events[0].detail).toBe("1 steering · 2 follow-up");
  });

  it("collects and resolves extension prompts", () => {
    const prompt: ExtensionUiPrompt = { id: "p1", sessionId: SESSION, kind: "confirm", title: "Continue?" };
    const asked = reduceHostEvent(state(), { type: "extension-ui-prompt", sessionId: SESSION, prompt });
    expect(asked.uiPrompts).toEqual([prompt]);

    const resolved = reduceHostEvent(asked, { type: "extension-ui-resolved", sessionId: SESSION, id: "p1" });
    expect(resolved.uiPrompts).toEqual([]);
    expect(reduceHostEvent(resolved, { type: "extension-ui-resolved", sessionId: SESSION, id: "p1" })).toBe(resolved);
  });
});

describe("ThreadViewStore", () => {
  it("batches streamed deltas into one transcript change per frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const store = new ThreadViewStore();
      store.beginThread(SESSION);
      const changes = vi.fn();
      store.subscribeToTranscript(changes);

      store.dispatch({ type: "assistant-delta", sessionId: SESSION, id: "a", delta: "he" });
      store.dispatch({ type: "assistant-delta", sessionId: SESSION, id: "a", delta: "llo" });
      store.dispatch({ type: "assistant-thinking", sessionId: SESSION, id: "a", delta: "why" });
      // Only the empty row has been committed so far.
      expect(store.getTranscript().messages[0].text).toBe("");
      expect(changes).toHaveBeenCalledTimes(1);

      frames.forEach((frame) => frame(0));
      expect(store.getTranscript().messages[0]).toMatchObject({ text: "hello", thinking: "why" });
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("notifies only the slices an event touched", () => {
    const store = new ThreadViewStore();
    store.beginThread(SESSION);
    const transcript = vi.fn();
    const tools = vi.fn();
    const prompts = vi.fn();
    store.subscribeToTranscript(transcript);
    store.subscribeToTools(tools);
    store.subscribeToPrompts(prompts);

    store.dispatch({ type: "assistant-end", sessionId: SESSION, message: { id: "a", role: "assistant", text: "done", timestamp: 1 } });

    expect(transcript).toHaveBeenCalledTimes(1);
    expect(tools).not.toHaveBeenCalled();
    expect(prompts).not.toHaveBeenCalled();
  });

  it("flushes pending tool output before a run is reported as finished", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const store = new ThreadViewStore();
      store.beginThread(SESSION);
      store.dispatch({ type: "tool-start", sessionId: SESSION, tool: tool() });
      store.dispatch({ type: "tool-update", sessionId: SESSION, id: "tool-1", output: "partial" });
      expect(store.getToolView().tools[0].output).toBeUndefined();

      store.dispatch({ type: "agent-status", sessionId: SESSION, running: false });
      expect(store.getToolView().tools[0].output).toBe("partial");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("materializes a parked anchor row only when an extension asks for it", () => {
    const store = new ThreadViewStore();
    store.beginThread(SESSION);
    store.dispatch({ type: "assistant-anchor", sessionId: SESSION, id: "a", sourceEntryId: "entry-1", timestamp: 5 });
    expect(store.getTranscript().messages).toEqual([]);

    store.resolvePendingAnchors(["entry-1"]);
    expect(store.getTranscript().messages).toEqual([{ id: "a", sourceEntryId: "entry-1", role: "assistant", text: "", timestamp: 5 }]);
  });
});
