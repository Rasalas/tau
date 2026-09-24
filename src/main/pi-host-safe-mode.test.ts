import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shippedHostExtensions } from "./bundled-kits.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { PiHost } from "./pi-host.js";

const appPath = fileURLToPath(new URL("../..", import.meta.url));
/** Everything Tau ships, the way the app assembles it: kits from `kits/` included. */
const shipped = shippedHostExtensions({ appPath, sources: true }, () => undefined);
/** Kits that no longer live in the host but arrive through the bundled loader. */
// Every kit with a host half; Signals is desktop-only and has no summary here.
const PACKAGED_KIT_IDS = ["tau.access", "tau.agents", "tau.claude-code", "tau.computer-use", "tau.keybindings", "tau.packages", "tau.pi-ui", "tau.preview", "tau.questionnaire", "tau.review", "tau.service-tier", "tau.thread-titles", "tau.workspace", "tau.worktree-names"];

type Internals = {
  activateHostExtensions(): Promise<void>;
  runtimeExtensionsFor(settings: { getGlobalSettings(): object; getProjectSettings(): object }): Array<{ name: string }>;
  requireBackend(kind: string): { kind: string };
};
const settings = { getGlobalSettings: () => ({}), getProjectSettings: () => ({}) };

describe("PiHost safe mode", () => {
  it("loads no host extension and injects no Pi extension", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, { hostExtensions: shipped });
    await (host as unknown as Internals).activateHostExtensions();
    expect(host.listHostExtensions()).toEqual([]);
    expect((host as unknown as Internals).runtimeExtensionsFor(settings)).toEqual([]);
  });

  it("loads every bundled kit outside safe mode, each removable on its own", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: shipped });
    await (host as unknown as Internals).activateHostExtensions();
    const internals = host as unknown as Internals;
    const summaries = host.listHostExtensions();
    expect(summaries.map((summary) => summary.id).sort()).toEqual((await shipped()).map((extension) => extension.id).sort());
    // The migrated kits are compiled from `kits/` and imported like packages.
    expect(summaries.filter((summary) => PACKAGED_KIT_IDS.includes(summary.id)).map((summary) => summary.id).sort()).toEqual(PACKAGED_KIT_IDS);
    expect(summaries.filter((summary) => !summary.active)).toEqual([]);
    expect(internals.runtimeExtensionsFor(settings).map((entry) => entry.name).sort()).toEqual(["tau-access", "tau-agents", "tau-computer-use", "tau-computer-use-screen", "tau-evidence", "tau-pi-limits", "tau-plan", "tau-preview", "tau-pull-requests", "tau-questionnaire", "tau-service-tier", "tau-takeover", "tau-turn-checkpoints"]);
  });

  // A runtime backend now arrives from a package rather than from a host
  // constructor. `start()` activates the kits before it checks the default
  // backend, so the kind the environment named is registered by then; until
  // then the host says which extension is missing rather than failing blankly.
  it("finds the default backend a kit registered, and names the gap before the kits load", async () => {
    const kind = selectDefaultBackend("claude-code");
    expect(kind).toBe("claude-code");
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: shipped, defaultBackendKind: kind });
    const internals = host as unknown as Internals;
    expect(() => internals.requireBackend(kind)).toThrow('Runtime backend "claude-code" is not installed');
    await internals.activateHostExtensions();
    expect(internals.requireBackend(kind).kind).toBe(kind);
  });
});

describe("PiHost extension packages", () => {
  const loader = async () => ({
    extensions: [{
      extension: { id: "acme.pkg", name: "Package", activate(context: { registerCommand(name: string, handler: () => unknown): void }) { context.registerCommand("ping", () => "pong"); } },
      package: { scope: "global" as const, directory: "/home/.tau/extensions/pkg", manifest: { id: "acme.pkg", name: "Package", host: "./host.ts" } },
      bundleHash: "aaaabbbbccccdddd",
      bundlePath: "/cache/acme.pkg-aaaabbbbccccdddd.cjs",
    }],
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
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: false, commands: [], isolation: "in-process" }]);
      // Granting it activates it.
      await host.grantExtension("acme.pkg", true);
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"], isolation: "in-process" }]);
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
      expect(restarted.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"], isolation: "in-process" }]);
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
          extensions: [{
            extension: { id: "acme.pkg", name: "Package", permissions: manifest.permissions, activate(context: { registerCommand(name: string, handler: () => unknown): void }) { context.registerCommand("ping", () => "pong"); } },
            package: pkg,
            bundleHash: "aaaabbbbccccdddd",
            bundlePath: "/cache/acme.pkg-aaaabbbbccccdddd.cjs",
          }],
          ungranted: [],
          errors: [],
          skipped: [],
        };
      };
      const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [], hostExtensionPackages: gated, grantsFilePath });
      await (host as unknown as Internals).activateHostExtensions();
      expect(imported).toBe(0);
      // Never imported, so the summary carries the manifest's isolation: the default worker.
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: false, commands: [], isolation: "worker" }]);

      await host.grantExtension("acme.pkg", true);
      expect(imported).toBe(1);
      expect(host.listHostExtensions()).toEqual([{ id: "acme.pkg", name: "Package", active: true, commands: ["ping"], isolation: "in-process" }]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
