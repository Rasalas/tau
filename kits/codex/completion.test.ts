import { expect, it, vi } from "vitest";
import { completeCodex } from "./completion.js";
import type { CodexSessionInput, CodexSessionLike } from "./thread-backend.js";

it("closes a failed completion without waiting for an unresolved startTurn request", async () => {
  const close = vi.fn(async () => undefined);
  const open = async (input: CodexSessionInput) => ({
    startThread: async () => ({ thread: { id: "helper" }, model: "gpt-6-luna", reasoningEffort: "low" }),
    startTurn: async () => {
      input.onNotification("turn/completed", { threadId: "helper", turn: { status: "failed", error: { message: "Model unavailable" } } });
      return new Promise<string>(() => undefined);
    }, close,
  }) as unknown as CodexSessionLike;
  await expect(completeCodex(open, "/repo", "gpt-6-luna", "low", { system: "Title", prompt: "Task" })).rejects.toThrow("Model unavailable");
  expect(close).toHaveBeenCalledOnce();
});

it("times out and closes a completion whose thread/start never answers", async () => {
  const close = vi.fn(async () => undefined);
  const open = async () => ({ startThread: () => new Promise(() => undefined), close }) as unknown as CodexSessionLike;
  vi.useFakeTimers();
  try {
    const result = completeCodex(open, "/repo", "gpt-6-luna", "low", { system: "Title", prompt: "Task" });
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
