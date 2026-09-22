import { describe, expect, it } from "vitest";
import { providerMarks } from "./runtime-marks";

describe("providerMarks", () => {
  it("shows a Pi model by its provider alone", () => {
    expect(providerMarks("anthropic", "pi")).toEqual({ model: "anthropic" });
    expect(providerMarks("openai-codex", undefined)).toEqual({ model: "openai-codex" });
  });

  it("puts another runtime beside the model provider", () => {
    expect(providerMarks("anthropic", "claude-code")).toEqual({ model: "anthropic", runtime: "claude-code" });
    expect(providerMarks("google", "antigravity")).toEqual({ model: "google", runtime: "antigravity" });
  });

  it("drops a runtime that shares the provider's name", () => {
    expect(providerMarks("opencode", "OpenCode")).toEqual({ model: "opencode" });
  });

  it("lets a runtime stand alone when there is no model, Pi included", () => {
    expect(providerMarks(undefined, "claude-code")).toEqual({ runtime: "claude-code" });
    expect(providerMarks(undefined, "pi")).toEqual({ runtime: "pi" });
    expect(providerMarks(undefined, undefined)).toEqual({});
  });
});
