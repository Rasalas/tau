import { describe, expect, it } from "vitest";
import { bundledHostExtensions } from "./extensions/index.js";
import { PiHost } from "./pi-host.js";

type Internals = {
  activateHostExtensions(): Promise<void>;
  runtimeExtensionsFor(settings: { getGlobalSettings(): object; getProjectSettings(): object }): Array<{ name: string }>;
};
const settings = { getGlobalSettings: () => ({}), getProjectSettings: () => ({}) };

describe("PiHost safe mode", () => {
  it("loads no host extension and injects no Pi extension", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, { hostExtensions: bundledHostExtensions() });
    await (host as unknown as Internals).activateHostExtensions();
    expect(host.listHostExtensions()).toEqual([]);
    expect((host as unknown as Internals).runtimeExtensionsFor(settings)).toEqual([]);
  });

  it("loads every bundled kit outside safe mode, each removable on its own", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: bundledHostExtensions() });
    const internals = host as unknown as Internals;
    await internals.activateHostExtensions();
    const summaries = host.listHostExtensions();
    expect(summaries.map((summary) => summary.id).sort()).toEqual(bundledHostExtensions().map((extension) => extension.id).sort());
    expect(summaries.filter((summary) => !summary.active)).toEqual([]);
    expect(internals.runtimeExtensionsFor(settings).map((entry) => entry.name).sort()).toEqual(["tau-access", "tau-computer-use", "tau-questionnaire", "tau-service-tier"]);
  });
});
