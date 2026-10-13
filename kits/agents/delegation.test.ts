import { describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostRuntimeChoice } from "tau/host-extension";
import { delegationModel, sameModel } from "./delegation.js";

const choice: HostRuntimeChoice = {
  backend: { kind: "fixture@work", label: "Work runtime" }, enabled: true,
  readiness: { kind: "fixture@work", label: "Work runtime", state: "ready" },
  catalog: { kind: "fixture@work", models: [{ provider: "test", id: "alternate", name: "Alternate" }], thinkingLevels: {} },
};

function services(choices: HostRuntimeChoice[]): HostExtensionServices {
  return { runtimeChoices: async (_cwd: string, kind?: string) => choices.filter((entry) => !kind || entry.backend.kind === kind) } as HostExtensionServices;
}

describe("delegation model selection", () => {
  it("resolves short ids and preserves the target runtime's default when no model is chosen", async () => {
    await expect(delegationModel(services([choice]), "/project", "fixture@work", "alternate")).resolves.toBe("test/alternate");
    await expect(delegationModel(services([choice]), "/project", "fixture@work", undefined)).resolves.toBeUndefined();
  });

  it("refuses an unknown model even when a ready runtime advertises no models", async () => {
    const empty = { ...choice, catalog: { ...choice.catalog!, models: [] } };
    await expect(delegationModel(services([empty]), "/project", "fixture@work", "unknown")).rejects.toThrow("fixture@work (ready): no known models");
  });

  it("refuses ambiguous short ids and accepts a qualified choice", async () => {
    const ambiguous = { ...choice, catalog: { ...choice.catalog!, models: [...choice.catalog!.models, { provider: "other", id: "alternate", name: "Alternate" }] } };
    await expect(delegationModel(services([ambiguous]), "/project", "fixture@work", "alternate")).rejects.toThrow("ambiguous model");
    await expect(delegationModel(services([ambiguous]), "/project", "fixture@work", "other/alternate")).resolves.toBe("other/alternate");
  });

  it("validates on the selected machine without applying this machine's project gate", async () => {
    const requests = vi.fn(async (_machine: string, method: string) => method === "readiness" ? { runtimes: [choice.readiness] } : choice.catalog);
    const local = { ...services([{ ...choice, enabled: false }]), machines: { request: requests } } as unknown as HostExtensionServices;
    await expect(delegationModel(local, "/project", "fixture@work", "alternate", "remote-host")).resolves.toBe("test/alternate");
    expect(requests.mock.calls).toEqual([["remote-host", "readiness"], ["remote-host", "runtime-catalog", ["fixture@work"]]]);
  });

  it("recognizes inherited, qualified and bare parent model selections", () => {
    expect(sameModel(undefined, "test/current")).toBe(true);
    expect(sameModel("test/current", "test/current")).toBe(true);
    expect(sameModel("current", "test/current")).toBe(true);
    expect(sameModel("other/current", "test/current")).toBe(false);
    expect(sameModel("test/alternate", "test/current")).toBe(false);
  });
});
