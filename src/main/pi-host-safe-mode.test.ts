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

describe("PiHost extension packages", () => {
  const loader = async () => ({
    extensions: [{ extension: { id: "acme.pkg", name: "Package", activate(context: { registerCommand(name: string, handler: () => unknown): void }) { context.registerCommand("ping", () => "pong"); } }, package: { scope: "global" as const, directory: "/home/.tau/extensions/pkg", manifest: { id: "acme.pkg", name: "Package", host: "./host.ts" } } }],
    errors: [],
    skipped: [],
  });

  it("activates packaged host halves outside safe mode and never in safe mode", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [], hostExtensionPackages: loader });
    await (host as unknown as Internals).activateHostExtensions();
    expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"] }]);
    await expect(host.invokeHostExtension("acme.pkg", "ping")).resolves.toBe("pong");
    await host.setHostExtensionActive("acme.pkg", false);
    expect(host.listHostExtensions()[0]?.active).toBe(false);
    await host.setHostExtensionActive("acme.pkg", true);
    expect(host.listHostExtensions()[0]?.active).toBe(true);
    const safe = new PiHost("/repo", () => undefined, {} as never, true, false, { hostExtensions: [], hostExtensionPackages: loader });
    await (safe as unknown as Internals).activateHostExtensions();
    expect(safe.listHostExtensions()).toEqual([]);
  });
});
