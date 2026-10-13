import { describe, expect, it } from "vitest";
import { runtimeChoices, type ReadinessRuntimes } from "./host-resources.js";

const model = { provider: "test", id: "available", name: "Available" };

function source(): ReadinessRuntimes {
  return {
    runtimeBackends: () => [{ kind: "fixture@work", label: "Work runtime" }],
    runtimeCatalogs: async () => [],
    runtimeCatalog: async (kind) => ({ kind, models: [model], thinkingLevels: {} }),
    runtimeBackendOwner: () => "test.fixture",
    invokeHostExtension: async () => ({ account: { signedIn: true } }),
  };
}

describe("extension runtime choices", () => {
  it("uses composer models and the project's effective gate for an instance", async () => {
    const calls: string[] = [];
    const choices = await runtimeChoices(source(), async (kind) => { calls.push(kind); return false; });
    expect(calls).toEqual(["fixture@work"]);
    expect(choices).toMatchObject([{ backend: { kind: "fixture@work" }, enabled: false, catalog: { models: [model] }, readiness: { state: "ready" } }]);
  });

  it("checks the selected instance's sign-in even if the catalog lists models", async () => {
    const fixture = source();
    const calls: unknown[] = [];
    fixture.invokeHostExtension = async (...args) => { calls.push(args); return { account: { signedIn: false, detail: "Sign in first" } }; };
    const choices = await runtimeChoices(fixture, async () => true, "fixture@work");
    expect(calls).toEqual([["test.fixture", "sign-in-state", { target: "work" }]]);
    expect(choices[0]!.readiness).toMatchObject({ state: "sign-in-required", note: "Sign in first" });
  });

  it("preserves missing-program and unavailable-catalog failures", async () => {
    const fixture = source();
    fixture.runtimeCatalog = async (kind) => ({ kind, models: [], thinkingLevels: {}, status: "not-installed" });
    expect((await runtimeChoices(fixture, async () => true))[0]!.readiness.state).toBe("not-installed");
    fixture.runtimeCatalog = async () => undefined;
    expect((await runtimeChoices(fixture, async () => true))[0]!.readiness.state).toBe("checking");
    expect(await runtimeChoices(fixture, async () => true, "missing")).toEqual([]);
  });
});
