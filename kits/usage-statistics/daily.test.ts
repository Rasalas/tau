import { describe, expect, it, vi } from "vitest";
import type { WorkbenchEvent, WorkbenchEvents } from "tau";
import { createMemoryStorage } from "../../src/renderer/test-support/kit-harness.js";
import { DailyUsage, DAILY_KEY, modelLabel, reasoningLabel, runtimeLabel, accessLabel } from "./daily.js";
import { UsageStatistics, type SendEvent } from "./statistics.js";
import { watchUsage } from "./watch.js";

const release = { version: "0.7.43", platform: "darwin" as const, channel: "stable" as const };
const DAY = Date.parse("2026-10-14T10:00:00Z");

function setup(enabled = true) {
  let now = DAY;
  const storage = createMemoryStorage();
  const statistics = new UsageStatistics(storage, async () => undefined, () => now, () => "0123456789abcdef");
  if (enabled) statistics.setEnabled(true);
  statistics.start(release);
  const send = vi.fn<SendEvent>(async () => undefined);
  const daily = new DailyUsage(storage, statistics, send, () => now);
  return { storage, statistics, send, daily, at: (ms: number) => { now = ms; } };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what leaves the device", () => {
  it("names only known runtimes, providers, levels and access, and drops a runtime instance's own name", () => {
    expect(runtimeLabel("codex@work-account")).toBe("codex");
    expect(runtimeLabel(undefined)).toBe("pi");
    expect(runtimeLabel("acme-agent")).toBe("other");
    expect(modelLabel({ provider: "anthropic", id: "claude-sonnet-5-5" })).toBe("anthropic/claude-sonnet-5-5");
    expect(modelLabel({ provider: "acme-internal", id: "secret-llm" })).toBe("other");
    expect(reasoningLabel("default (low)")).toBe("default");
    expect(reasoningLabel("xhigh")).toBe("xhigh");
    expect(reasoningLabel("turbo")).toBe("other");
    expect(accessLabel("ask")).toBe("ask");
    expect(accessLabel("anything")).toBe("other");
  });
});

describe("daily usage", () => {
  it("counts a day and sends it as counted events only once the next day begins", async () => {
    const { send, daily, at } = setup();
    daily.prompt({ backendKind: "claude-code", model: { provider: "anthropic", id: "claude-sonnet-5-5" }, thinkingLevel: "high", access: "full" });
    daily.prompt({ backendKind: "claude-code", model: { provider: "anthropic", id: "claude-sonnet-5-5" }, thinkingLevel: "high", access: "full" });
    daily.runEnded("claude-code", "ok");
    daily.runEnded("codex@work", "error");
    daily.flush();
    expect(send).not.toHaveBeenCalled();

    at(DAY + 86_400_000);
    daily.prompt({ backendKind: "pi", model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "low", access: "ask" });
    await settled();
    expect(send.mock.calls.map(([report]) => report.event)).toEqual([
      { category: "prompts", action: "claude-code", name: "anthropic/claude-sonnet-5-5 · high · full", value: 2 },
      { category: "runs", action: "claude-code", name: "ok", value: 1 },
      { category: "runs", action: "codex", name: "error", value: 1 },
    ]);
    expect(send.mock.calls[0][0]).toMatchObject({ id: "0123456789abcdef", release });

    // The new day kept its first prompt while the finished one was sent.
    send.mockClear();
    at(DAY + 2 * 86_400_000);
    daily.flush();
    await settled();
    expect(send.mock.calls.map(([report]) => report.event)).toEqual([{ category: "prompts", action: "pi", name: "openai/gpt-5.6-luna · low · ask", value: 1 }]);
  });

  it("keeps a day whose sending failed and tries again later", async () => {
    const { send, daily, at } = setup();
    daily.runEnded("pi", "limit");
    send.mockRejectedValueOnce(new Error("offline"));
    at(DAY + 86_400_000);
    daily.flush();
    await settled();
    daily.flush();
    await settled();
    expect(send).toHaveBeenCalledTimes(1);
    at(DAY + 86_400_000 + 5 * 60_000);
    daily.flush();
    await settled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("counts nothing without consent and forgets the counts when reporting is turned off", async () => {
    const off = setup(false);
    off.daily.prompt({ backendKind: "pi" });
    expect(off.storage.get(DAILY_KEY)).toBeNull();

    const { storage, statistics, send, daily, at } = setup();
    daily.prompt({ backendKind: "pi" });
    expect(storage.get(DAILY_KEY)).not.toBeNull();
    statistics.setEnabled(false);
    at(DAY + 86_400_000);
    daily.flush();
    await settled();
    expect(send).not.toHaveBeenCalled();
    expect(storage.get(DAILY_KEY)).toBeNull();
  });
});

function fakeEvents() {
  const listeners = new Map<string, Set<(event: WorkbenchEvent) => void>>();
  const events = { on: (type: string, listener: (event: WorkbenchEvent) => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
    return () => set.delete(listener);
  } } as unknown as WorkbenchEvents;
  const emit = (event: WorkbenchEvent) => listeners.get(event.type)?.forEach((listener) => listener(event));
  return { events, emit };
}

const answer = (sessionId: string, error?: string) =>
  ({ type: "assistant-end", sessionId, message: { id: "m", role: "assistant", text: "", timestamp: 0, ...(error ? { error } : {}) } }) as unknown as WorkbenchEvent;

const index = (sessions: Array<{ id: string; backendKind?: string; limit?: unknown }>) =>
  ({ type: "thread-index", threadIndex: { projects: [], sessions } }) as unknown as WorkbenchEvent;

describe("watching runs", () => {
  it("counts how runs of threads this window prompted end, including a draft's first run", () => {
    vi.useFakeTimers();
    try {
      const daily = { prompt: vi.fn(), runEnded: vi.fn() };
      const { events, emit } = fakeEvents();
      let current: { sessionId?: string; backendKind?: string } = { sessionId: "a", backendKind: "codex" };
      const stop = watchUsage(events, daily as never, () => current);

      emit({ type: "prompt-accepted" });
      expect(daily.prompt).toHaveBeenCalledWith({ sessionId: "a", backendKind: "codex" });
      emit({ type: "agent-status", sessionId: "a", running: true });
      emit(answer("a", "500 · boom"));
      emit({ type: "agent-status", sessionId: "a", running: false });
      // The thread list reports the run's end late; the answer already said how it went.
      emit(index([{ id: "a", backendKind: "codex" }]));
      expect(daily.runEnded).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3_000);
      expect(daily.runEnded).toHaveBeenLastCalledWith("codex", "error");

      // A retry that answers after an error is a success; a usage limit is its own outcome.
      emit({ type: "prompt-accepted" });
      emit({ type: "agent-status", sessionId: "a", running: true });
      emit(answer("a", "overloaded"));
      emit(answer("a"));
      emit({ type: "agent-status", sessionId: "a", running: false });
      vi.advanceTimersByTime(3_000);
      expect(daily.runEnded).toHaveBeenLastCalledWith("codex", "ok");
      emit({ type: "prompt-accepted" });
      emit({ type: "agent-status", sessionId: "a", running: true });
      emit({ type: "agent-status", sessionId: "a", running: false });
      emit(index([{ id: "a", backendKind: "codex", limit: { message: "Usage limit reached" } }]));
      vi.advanceTimersByTime(3_000);
      expect(daily.runEnded).toHaveBeenLastCalledWith("codex", "limit");

      // Another window's thread is not counted here.
      emit({ type: "agent-status", sessionId: "other", running: true });
      emit({ type: "agent-status", sessionId: "other", running: false });
      vi.advanceTimersByTime(5_000);
      expect(daily.runEnded).toHaveBeenCalledTimes(3);

      current = { backendKind: "claude-code" };
      emit({ type: "prompt-accepted" });
      emit({ type: "agent-status", sessionId: "b", running: true });
      emit({ type: "agent-status", sessionId: "b", running: false });
      vi.advanceTimersByTime(3_000);
      expect(daily.runEnded).toHaveBeenLastCalledWith("claude-code", "ok");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
