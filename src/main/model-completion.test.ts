import { describe, expect, it, vi } from "vitest";
import { isExpectedCommandError } from "./host-extension-errors.js";
import { completeText } from "./model-completion.js";

const reply = (text: string, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }], errorMessage: stopReason === "error" ? "boom" : undefined });
const model = { provider: "p", id: "m" } as never;
const attribution = { sessionId: "s" };

function runtime(final: ReturnType<typeof reply>, deltas: string[] = []) {
  return {
    completeSimple: vi.fn(async (..._args: unknown[]) => final),
    streamSimple: vi.fn((..._args: unknown[]) => ({
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

  it.each([false, true])("passes supported thinking to the model, streaming=%s", async (streaming) => {
    const models = runtime(reply("answer"));
    const selected = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: null, max: null } } as never;
    await completeText(models as never, selected, { system: "s", prompt: "p", thinkingLevel: "high", ...(streaming ? { onText: () => undefined } : {}) }, attribution);
    const calls = streaming ? models.streamSimple.mock.calls : models.completeSimple.mock.calls;
    expect(calls[0]?.[2]).toMatchObject({ reasoning: "high" });
  });

  it.each(["high", "invalid", "off"])("ignores unsupported thinking %s on a model without reasoning", async (thinkingLevel) => {
    const models = runtime(reply("answer"));
    await completeText(models as never, { provider: "p", id: "plain", reasoning: false } as never, { system: "s", prompt: "p", thinkingLevel }, attribution);
    expect(models.completeSimple.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("fails with the provider's message", async () => {
    await expect(completeText(runtime(reply("", "error")) as never, model, { system: "s", prompt: "p", onText: () => undefined }, attribution)).rejects.toThrow("boom");
  });

  describe("on a Pi login", () => {
    const modelsError = (code: string, message: string) => Object.assign(new Error(message), { name: "ModelsError", code });
    const withLogin = (getAuth: () => Promise<unknown>, oauth = true) => ({
      ...runtime(reply("named")),
      isUsingOAuth: vi.fn(() => oauth),
      getAuth: vi.fn(getAuth),
      getProvider: () => ({ name: "Anthropic" }),
    });

    it("asks to sign in again when the refresh token expired, without sending the request", async () => {
      const models = withLogin(async () => {
        throw modelsError("oauth", 'OAuth refresh failed for p: Anthropic token refresh request failed. body={"error": "invalid_grant", "error_description": "Refresh token expired"}; stack=Error: HTTP request failed\n    at postJson');
      });
      const failure = await completeText(models as never, model, { system: "s", prompt: "p" }, attribution).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Pi's Anthropic login has expired. Sign in again on Pi under Settings → Runtimes.");
      // A login to renew is no broken command: it must not count toward deactivating the package that asked.
      expect(isExpectedCommandError(failure)).toBe(true);
      expect(models.completeSimple).not.toHaveBeenCalled();
    });

    it("names a refresh that failed for another reason without claiming the login expired", async () => {
      const models = withLogin(async () => { throw modelsError("oauth", "OAuth refresh failed for p: fetch failed"); });
      const failure = await completeText(models as never, model, { system: "s", prompt: "p" }, attribution).catch((error: unknown) => error);
      expect((failure as Error).message).toBe("Pi could not refresh its Anthropic login. Sign in again on Pi under Settings → Runtimes if this keeps happening.");
      expect(isExpectedCommandError(failure)).toBe(true);
    });

    it("leaves other failures to the request", async () => {
      const models = withLogin(async () => { throw modelsError("provider", "Unknown provider: p"); });
      await expect(completeText(models as never, model, { system: "s", prompt: "p" }, attribution)).resolves.toBe("named");
    });

    it("checks only a provider Pi reaches through a login", async () => {
      const models = withLogin(async () => undefined, false);
      await expect(completeText(models as never, model, { system: "s", prompt: "p" }, attribution)).resolves.toBe("named");
      expect(models.getAuth).not.toHaveBeenCalled();
    });
  });
});
