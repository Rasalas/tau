import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiRuntimeCatalog } from "../shared/contracts";
import { chosenNewThreadRuntime, effectiveNewThreadRuntime, rememberedNewThreadSelection } from "./new-thread-runtime";

const snapshot = {
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }],
  defaultBackendKind: "acme",
} as HostSnapshot;

describe("the runtime of a new thread", () => {
  it("is the client's choice when the host offers it", () => {
    expect(chosenNewThreadRuntime("acme", snapshot)).toBe("acme");
    expect(effectiveNewThreadRuntime("pi", snapshot)).toBe("pi");
  });

  it("falls back to the host's default when the choice is not installed or absent", () => {
    expect(chosenNewThreadRuntime("gone", snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime("gone", snapshot)).toBe("acme");
    expect(chosenNewThreadRuntime(undefined, snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime(undefined, undefined)).toBe("pi");
  });
});

describe("a new thread's remembered model", () => {
  const old = { provider: "openai", id: "old", name: "Old" };
  const latest = { provider: "openai", id: "latest", name: "Latest" };
  const catalog: UiRuntimeCatalog = { kind: "codex@work", models: [old, latest], model: old, thinkingLevels: { latest: ["low", "high"] } };

  it("takes the newest available choice and a supported level for the exact runtime account", () => {
    const recent = ["codex:openai/old", "openai/old", "codex@work:openai/gone", "codex@work:openai/latest", "codex@work:openai/old"];
    expect(rememberedNewThreadSelection(catalog, recent, { "codex@work:openai/latest": "high" }))
      .toEqual({ runtime: "codex@work", model: latest, thinkingLevel: "high" });
    expect(rememberedNewThreadSelection(catalog, recent, { "codex@work:openai/latest": "max" }))
      .toEqual({ runtime: "codex@work", model: latest });
  });

  it("falls back to the catalog default when remembered models are gone", () => {
    expect(rememberedNewThreadSelection(catalog, ["codex@work:openai/gone"], {})).toEqual({ runtime: "codex@work", model: old });
    expect(rememberedNewThreadSelection({ ...catalog, model: undefined }, ["codex@work:openai/gone"], {})).toBeUndefined();
  });

  it("uses Pi's provider-qualified levels and leaves runtimes without history alone", () => {
    const pi = { ...catalog, kind: "pi", thinkingLevels: { "openai/latest": ["medium", "high"] } };
    expect(rememberedNewThreadSelection(pi, ["codex@work:openai/old", "openai/latest"], { "openai/latest": "high" }))
      .toEqual({ runtime: "pi", model: latest, thinkingLevel: "high" });
    expect(rememberedNewThreadSelection(catalog, ["openai/latest"], {})).toBeUndefined();
  });
});
