import { describe, expect, it } from "vitest";
import { isOpenCodeModel, modelAttribution } from "./model-attribution.js";

describe("modelAttribution", () => {
  it("identifies opencode, opencode-go, and opencode.ai endpoints", () => {
    expect(isOpenCodeModel({ provider: "opencode" })).toBe(true);
    expect(isOpenCodeModel({ provider: "opencode-go" })).toBe(true);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai/zen/v1" })).toBe(true);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai/go" })).toBe(true);
    expect(isOpenCodeModel({ provider: "openai" })).toBe(false);
    expect(isOpenCodeModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe(false);
  });

  it("adds required session and client headers for OpenCode models", () => {
    const customSessionId = "sess-123-abc";
    const attribution = modelAttribution({ provider: "opencode" }, customSessionId);
    expect(attribution.sessionId).toBe(customSessionId);
    expect(attribution.headers).toEqual({
      "x-opencode-session": customSessionId,
      "x-opencode-client": "pi",
    });
  });

  it("generates a random UUID session when none is given", () => {
    const attribution = modelAttribution({ provider: "opencode-go" });
    expect(attribution.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(attribution.headers?.["x-opencode-session"]).toBe(attribution.sessionId);
    expect(attribution.headers?.["x-opencode-client"]).toBe("pi");
  });

  it("does not attach opencode headers for other providers", () => {
    const attribution = modelAttribution({ provider: "anthropic" }, "sess-456");
    expect(attribution.sessionId).toBe("sess-456");
    expect(attribution.headers).toBeUndefined();
  });
});
