import { describe, expect, it, vi } from "vitest";
import { refusesTemperature, withConfiguredSampling } from "./configured-sampling.js";

const model = { provider: "p", id: "m", api: "openai-completions", reasoning: false } as never;
const context = { messages: [] } as never;

describe("withConfiguredSampling", () => {
  it("adds the configured values and leaves the caller's own alone", async () => {
    const stream = vi.fn(() => "stream" as never);
    const wrapped = withConfiguredSampling(stream, async () => ({ temperature: 0.3, maxTokens: 900 }));
    await expect(wrapped(model, context, { sessionId: "s" })).resolves.toBe("stream");
    expect(stream).toHaveBeenLastCalledWith(model, context, { sessionId: "s", temperature: 0.3, maxTokens: 900 });
    // Compaction names its own output budget.
    await wrapped(model, context, { maxTokens: 200 });
    expect(stream).toHaveBeenLastCalledWith(model, context, { maxTokens: 200, temperature: 0.3 });
  });

  it("sends the request unchanged when nothing is set or the config cannot be read", async () => {
    const stream = vi.fn(() => "stream" as never);
    await withConfiguredSampling(stream, async () => ({}))(model, context, { sessionId: "s" });
    expect(stream).toHaveBeenLastCalledWith(model, context, { sessionId: "s" });
    await withConfiguredSampling(stream, async () => { throw new Error("unreadable"); })(model, context, undefined);
    expect(stream).toHaveBeenLastCalledWith(model, context, {});
  });

  it("keeps a temperature from a model that would fail the request over it", async () => {
    const stream = vi.fn(() => "stream" as never);
    const codex = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses", reasoning: true } as never;
    await withConfiguredSampling(stream, async () => ({ temperature: 0.3, maxTokens: 900 }))(codex, context, {});
    expect(stream).toHaveBeenLastCalledWith(codex, context, { maxTokens: 900 });
  });
});

describe("refusesTemperature", () => {
  it("names the Codex endpoint and OpenAI's reasoning models, nothing else", () => {
    expect(refusesTemperature({ api: "openai-codex-responses", reasoning: false })).toBe(true);
    expect(refusesTemperature({ api: "openai-responses", reasoning: true })).toBe(true);
    expect(refusesTemperature({ api: "azure-openai-responses", reasoning: true })).toBe(true);
    expect(refusesTemperature({ api: "openai-responses", reasoning: false })).toBe(false);
    expect(refusesTemperature({ api: "anthropic-messages", reasoning: true })).toBe(false);
    expect(refusesTemperature({ api: "openai-completions", reasoning: true })).toBe(false);
  });
});
