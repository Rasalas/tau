import { describe, expect, it } from "vitest";
import { modelPresentation } from "./model-manifest";

describe("model manifest", () => {
  it("marks legacy generations and badges the newest, leaving the rest current", () => {
    expect(modelPresentation({ provider: "anthropic", id: "claude-fable-5" })).toEqual({ legacy: false, badge: "new" });
    expect(modelPresentation({ provider: "anthropic", id: "claude-opus-4-1" })).toEqual({ legacy: true });
    expect(modelPresentation({ provider: "anthropic", id: "claude-haiku-4-5-20251001" })).toEqual({ legacy: false });
    expect(modelPresentation({ provider: "openai-codex", id: "gpt-4.1" })).toEqual({ legacy: true });
    expect(modelPresentation({ provider: "openai-codex", id: "gpt-5.6-sol" })).toEqual({ legacy: false });
    expect(modelPresentation({ provider: "opencode-go", id: "kimi-k2" })).toEqual({ legacy: false });
  });

  it("takes a manifest of its own, matching providers by string or pattern", () => {
    const manifest = [{ provider: /acme/u, id: /^old/u, status: "legacy" as const }, { id: /^shiny/u, badge: "new" as const }];
    expect(modelPresentation({ provider: "acme-cloud", id: "old-1" }, manifest).legacy).toBe(true);
    expect(modelPresentation({ provider: "other", id: "old-1" }, manifest).legacy).toBe(false);
    expect(modelPresentation({ provider: "other", id: "shiny-2" }, manifest).badge).toBe("new");
  });
});
