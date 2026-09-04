import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await (host as unknown as Internals).activateHostExtensions();
    const internals = host as unknown as Internals;
    const summaries = host.listHostExtensions();
    expect(summaries.map((summary) => summary.id).sort()).toEqual(bundledHostExtensions().map((extension) => extension.id).sort());
    expect(summaries.filter((summary) => !summary.active)).toEqual([]);
    expect(internals.runtimeExtensionsFor(settings).map((entry) => entry.name).sort()).toEqual(["tau-access", "tau-computer-use", "tau-questionnaire", "tau-service-tier", "tau-turn-checkpoints"]);
  });
});

describe("PiHost extension packages", () => {
  const loader = async () => ({
    extensions: [{ extension: { id: "acme.pkg", name: "Package", activate(context: { registerCommand(name: string, handler: () => unknown): void }) { context.registerCommand("ping", () => "pong"); } }, package: { scope: "global" as const, directory: "/home/.tau/extensions/pkg", manifest: { id: "acme.pkg", name: "Package", host: "./host.ts" } } }],
    ungranted: [],
    errors: [],
    skipped: [],
  });

  it("activates packaged host halves outside safe mode and never in safe mode", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tau-safe-mode-"));
    try {
      const grantsFilePath = join(scratch, "grants.json");
      const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [], hostExtensionPackages: loader, grantsFilePath });
      await (host as unknown as Internals).activateHostExtensions();
      // Initially ungranted, so active is false.
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: false, commands: [] }]);
      // Granting it activates it.
      await host.grantExtension("acme.pkg", true);
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"] }]);
      await expect(host.invokeHostExtension("acme.pkg", "ping")).resolves.toBe("pong");
      await host.setHostExtensionActive("acme.pkg", false);
      expect(host.listHostExtensions()[0]?.active).toBe(false);
      await host.setHostExtensionActive("acme.pkg", true);
      expect(host.listHostExtensions()[0]?.active).toBe(true);
      const safe = new PiHost("/repo", () => undefined, {} as never, true, false, { hostExtensions: [], hostExtensionPackages: loader, grantsFilePath });
      await (safe as unknown as Internals).activateHostExtensions();
      expect(safe.listHostExtensions()).toEqual([]);

      // A restart reads the same grants file and starts the package without asking again.
      const restarted = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [], hostExtensionPackages: loader, grantsFilePath });
      await (restarted as unknown as Internals).activateHostExtensions();
      expect(restarted.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"] }]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("lists a package that was never imported, and starts it once it is granted", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tau-ungranted-"));
    try {
      const grantsFilePath = join(scratch, "grants.json");
      const manifest = { id: "acme.pkg", name: "Package", permissions: ["sessions"], host: "./host.ts" };
      const pkg = { scope: "global" as const, directory: "/home/.tau/extensions/pkg", manifest };
      let imported = 0;
      const gated = async () => {
        const { readExtensionGrants, isPackageGranted } = await import("./extension-grants.js");
        const granted = isPackageGranted(manifest, (await readExtensionGrants(grantsFilePath)).grants);
        if (!granted) return { extensions: [], ungranted: [pkg], errors: [], skipped: [] };
        imported += 1;
        return {
          extensions: [{ extension: { id: "acme.pkg", name: "Package", permissions: manifest.permissions, activate(context: { registerCommand(name: string, handler: () => unknown): void }) { context.registerCommand("ping", () => "pong"); } }, package: pkg }],
          ungranted: [],
          errors: [],
          skipped: [],
        };
      };
      const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [], hostExtensionPackages: gated, grantsFilePath });
      await (host as unknown as Internals).activateHostExtensions();
      expect(imported).toBe(0);
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: false, commands: [] }]);

      await host.grantExtension("acme.pkg", true);
      expect(imported).toBe(1);
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"] }]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
