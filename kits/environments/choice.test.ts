import { describe, expect, it } from "vitest";
import type { HostReadiness, HostResources, RuntimeReadiness } from "tau/host-extension";
import { chooseMachine, readWeights, weightOf, type MachineCandidate } from "./choice.js";

const GB = 1024 ** 3;
const NOW = 1_000_000;

const resources = (patch: Partial<HostResources> = {}): HostResources => ({
  sampledAt: 0, cpuCount: 2, cpuUtilization: 0.1, totalMemory: 8 * GB, availableMemory: 4 * GB, runningTurns: 0, ...patch,
});

const pi = (patch: Partial<RuntimeReadiness> = {}): RuntimeReadiness => ({ kind: "pi", label: "Pi", state: "ready", models: 1, modelIds: ["openai-codex/gpt-5.6-luna"], ...patch });

const readiness = (...runtimes: RuntimeReadiness[]): HostReadiness => ({
  checkedAt: 0, runtimes: runtimes.length ? runtimes : [pi()], git: { version: "2.50.0", mergeTree: true }, disk: { path: "/w", free: 100 * GB }, display: { kind: "screen" },
});

/** This computer: 10 busy cores, weight 20. rex: 2 idle cores, weight 50. */
const here = (patch: Partial<MachineCandidate> = {}): MachineCandidate => ({
  id: "mac", name: "mac", local: true, weight: 20, resources: resources({ cpuCount: 10, cpuUtilization: 0.6 }), receivedAt: NOW - 1_000, readiness: readiness(), ...patch,
});
const rex = (patch: Partial<MachineCandidate> = {}): MachineCandidate => ({
  id: "rex-id", name: "rex", weight: 50, resources: resources(), receivedAt: NOW - 1_000, readiness: readiness(), ...patch,
});

describe("chooseMachine", () => {
  it("scores weight × cores × idle CPU × free memory, and says why", () => {
    const choice = chooseMachine([here(), rex()], { model: "openai-codex/gpt-5.6-luna" }, NOW);
    // mac: 20 × 10 × 0.4 × 0.5 = 40; rex: 50 × 2 × 0.9 × 0.5 = 45.
    expect(choice.chosen).toMatchObject({ id: "rex-id", score: 45 });
    expect(choice.reason).toBe("rex has the most room: 45 (weight 50 · 2 cores · CPU 10 % · 50 % memory free); this computer 40.");
    // With both idle, the bigger machine wins despite the weights.
    expect(chooseMachine([here({ resources: resources({ cpuCount: 10, cpuUtilization: 0.1 }) }), rex()], {}, NOW).chosen?.id).toBe("mac");
  });

  it.each([
    ["a reading older than 15 s", rex({ receivedAt: NOW - 16_000 }), "its reading is 16 s old"],
    ["no reading", rex({ resources: undefined }), "no reading of its load"],
    ["CPU at 95 %", rex({ resources: resources({ cpuUtilization: 0.95 }) }), "CPU 95 %"],
    ["CPU not measured", rex({ resources: resources({ cpuUtilization: undefined }) }), "its CPU was not measured yet"],
    ["5 % memory free", rex({ resources: resources({ availableMemory: 0.05 * 8 * GB }) }), "only 5 % memory free"],
    ["weight 0", rex({ weight: 0 }), "weight 0, never automatically"],
    ["its runtime not signed in", rex({ readiness: readiness(pi({ state: "sign-in-required" })) }), "Pi is not signed in"],
    ["the runtime missing", rex({ readiness: readiness(pi({ kind: "codex", label: "Codex" })) }), "it has no pi"],
    ["the model missing", rex({ readiness: readiness(pi({ modelIds: ["anthropic/other"] })) }), "Pi there has no openai-codex/gpt-5.6-luna"],
    ["unknown readiness", rex({ readiness: undefined }), "what it can run is unknown"],
    ["as many turns as cores", rex({ resources: resources({ runningTurns: 2 }) }), "2 turns running on 2 cores"],
    ["offline", rex({ unavailable: "offline" }), "offline"],
  ])("leaves out a machine with %s", (_case, candidate, why) => {
    const choice = chooseMachine([here(), candidate], { model: "openai-codex/gpt-5.6-luna" }, NOW);
    expect(choice.chosen?.id).toBe("mac");
    expect(choice.verdicts[1]).toMatchObject({ id: "rex-id", excluded: why });
    expect(choice.reason).toContain(`rex left out: ${why}`);
  });

  it("does not hold a runtime that names its models only in a thread to a model", () => {
    expect(chooseMachine([rex({ readiness: readiness(pi({ modelIds: undefined, models: undefined })) })], { model: "x/y" }, NOW).chosen?.id).toBe("rex-id");
  });

  it("takes codex where codex is ready", () => {
    const both = readiness(pi(), pi({ kind: "codex", label: "Codex", state: "sign-in-required" }));
    expect(chooseMachine([here(), rex({ readiness: both })], { backend: "codex" }, NOW).verdicts[1]?.excluded).toBe("Codex is not signed in");
  });

  it("answers no machine when none qualifies, this computer included", () => {
    const choice = chooseMachine([here({ weight: 0 }), rex({ resources: resources({ cpuUtilization: 0.99 }) })], {}, NOW);
    expect(choice.chosen).toBeUndefined();
    expect(choice.reason).toBe("No machine can take it now (this computer left out: weight 0, never automatically; rex left out: CPU 99 %).");
  });
});

describe("weights", () => {
  it("spares this computer by default and keeps a saved one within 0–100", () => {
    expect(weightOf({}, "mac", true)).toBe(20);
    expect(weightOf({}, "rex", false)).toBe(50);
    expect(weightOf({ rex: 0 }, "rex", false)).toBe(0);
    expect(weightOf({ rex: 140 }, "rex", false)).toBe(100);
    expect(readWeights('{"rex":70,"bad":"x"}')).toEqual({ rex: 70 });
    expect(readWeights("{nope")).toEqual({});
    expect(readWeights(undefined)).toEqual({});
  });
});
