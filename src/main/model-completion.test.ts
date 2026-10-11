import { describe, expect, it, vi } from "vitest";
import { completeText } from "./model-completion.js";

const reply = (text: string, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }], errorMessage: stopReason === "error" ? "boom" : undefined });
const model = { provider: "p", id: "m" } as never;
const attribution = { sessionId: "s" };

function runtime(final: ReturnType<typeof reply>, deltas: string[] = []) {
  return {
    completeSimple: vi.fn(async () => final),
    streamSimple: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start" };
        for (const delta of deltas) yield { type: "text_delta", delta };
      },
      result: async () => final,
    })),
  };
}

describe("completeText", () => {
  it("answers once without a listener", async () => {
    const models = runtime(reply("  hello "));
    expect(await completeText(models as never, model, { system: "s", prompt: "p" }, attribution)).toBe("hello");
    expect(models.streamSimple).not.toHaveBeenCalled();
    expect(models.completeSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 48, timeoutMs: 30_000, cacheRetention: "none" });
  });

  it("streams every delta and returns the whole answer", async () => {
    const models = runtime(reply("ab"), ["a", "b"]);
    const seen: string[] = [];
    const signal = new AbortController().signal;
    const text = await completeText(models as never, model, { system: "s", prompt: "p", maxTokens: 900, timeoutMs: 90_000, signal, onText: (delta) => seen.push(delta) }, attribution);
    expect(text).toBe("ab");
    expect(seen).toEqual(["a", "b"]);
    expect(models.completeSimple).not.toHaveBeenCalled();
    expect(models.streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 900, timeoutMs: 90_000, signal });
  });

  it("fails with the provider's message", async () => {
    await expect(completeText(runtime(reply("", "error")) as never, model, { system: "s", prompt: "p", onText: () => undefined }, attribution)).rejects.toThrow("boom");
  });
});
