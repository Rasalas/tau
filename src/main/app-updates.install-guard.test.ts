import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_GUARD_MS, installGuardPorts, installStillRunning, type InstallMarker } from "./app-updates.js";

function ports(marker: InstallMarker | undefined, shipIt: boolean, now = 1_000_000) {
  const clear = vi.fn();
  return { clear, ports: { read: () => marker, clear, shipItRunning: () => shipIt, now: () => now } };
}

describe("update install guard", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("steps aside while ShipIt installs the version the last quit was for", () => {
    const { ports: p, clear } = ports({ version: "0.7.32", at: 1_000_000 - 20_000, reopens: true }, true);
    expect(installStillRunning(p, "0.7.31")?.version).toBe("0.7.32");
    expect(clear).not.toHaveBeenCalled();
  });

  it("starts normally once the new version runs, ShipIt is gone, or the install took too long", () => {
    const fresh = { version: "0.7.32", at: 1_000_000 - 20_000, reopens: true };
    for (const [marker, shipIt, version] of [
      [fresh, true, "0.7.32"],
      [fresh, false, "0.7.31"],
      [{ version: "0.7.32", at: 1_000_000 - INSTALL_GUARD_MS - 1, reopens: false }, true, "0.7.31"],
    ] as const) {
      const { ports: p, clear } = ports(marker, shipIt);
      expect(installStillRunning(p, version)).toBeUndefined();
      expect(clear).toHaveBeenCalled();
    }
    expect(installStillRunning(ports(undefined, true).ports, "0.7.31")).toBeUndefined();
  });

  it("keeps the marker in userData and ignores a damaged one", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-install-guard-"));
    dirs.push(dir);
    const guard = installGuardPorts(dir, "de.tbuck.tau");
    expect(guard.read()).toBeUndefined();
    guard.write("0.7.32", false);
    expect(guard.read()).toMatchObject({ version: "0.7.32", reopens: false });
    expect(JSON.parse(readFileSync(join(dir, "update-installing.json"), "utf8")).version).toBe("0.7.32");
    guard.clear();
    expect(guard.read()).toBeUndefined();
    writeFileSync(join(dir, "update-installing.json"), "{");
    expect(guard.read()).toBeUndefined();
  });
});
