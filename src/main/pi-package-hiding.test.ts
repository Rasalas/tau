import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { hidePiPackages } from "./pi-package-hiding.js";

const replaces = (source: string) => source.startsWith("npm:replaced");

/** Settings files in a scratch agent dir and project, never the real ones. */
function manager(global: unknown[], project: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), "tau-pkg-hide-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: global }));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: project }));
  return { settings: SettingsManager.create(cwd, agentDir), globalFile: join(agentDir, "settings.json") };
}

describe("hidePiPackages", () => {
  it("drops replaced packages from both scopes, in string and object form", () => {
    const { settings } = manager(["npm:replaced@1", "npm:kept", { source: "npm:replaced" }], [{ source: "npm:replaced@2" }, "npm:other"]);
    hidePiPackages(settings, [replaces]);
    expect(settings.getGlobalSettings().packages).toEqual(["npm:kept"]);
    expect(settings.getProjectSettings().packages).toEqual(["npm:other"]);
  });

  it("changes nothing without a replacement", () => {
    const { settings } = manager(["npm:replaced"]);
    hidePiPackages(settings, []);
    expect(settings.getGlobalSettings().packages).toEqual(["npm:replaced"]);
  });

  it("puts hidden entries back when the manager writes", async () => {
    const { settings, globalFile } = manager(["npm:replaced@1", "npm:kept"]);
    hidePiPackages(settings, [replaces]);
    settings.setPackages(["npm:kept", "npm:added"]);
    await settings.flush();
    expect(JSON.parse(readFileSync(globalFile, "utf8")).packages).toEqual(["npm:kept", "npm:added", "npm:replaced@1"]);
  });
});
