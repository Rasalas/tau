import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostConfigManager } from "./host-config.js";

describe("HostConfigManager", () => {
  let tempDir: string;
  let globalPath: string;
  let projectDir: string;
  let manager: HostConfigManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tau-config-test-"));
    globalPath = join(tempDir, "global-config.json");
    projectDir = join(tempDir, "project");
    manager = new HostConfigManager({
      globalFilePath: globalPath,
      projectFilePath: (cwd) => join(cwd, ".tau", "config.json"),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty config when neither global nor project config exists", async () => {
    const config = await manager.read();
    expect(config).toEqual({});
  });

  it("writes and reads global configuration", async () => {
    await manager.update({ theme: "dark", showCosts: false }, "global");
    const config = await manager.read();
    expect(config.theme).toBe("dark");
    expect(config.showCosts).toBe(false);
  });

  it("merges project configuration over global configuration", async () => {
    await manager.update({ theme: "light", showCosts: true, transcriptDetail: "focused" }, "global");
    await manager.update({ transcriptDetail: "everything" }, "project", projectDir);

    const merged = await manager.read(projectDir);
    expect(merged.theme).toBe("light");
    expect(merged.showCosts).toBe(true);
    expect(merged.transcriptDetail).toBe("everything");
  });

  it("merges options and values records recursively", async () => {
    await manager.update({ options: { "ext.a": true, "ext.b": false } }, "global");
    await manager.update({ options: { "ext.b": true, "ext.c": true } }, "project", projectDir);

    const merged = await manager.read(projectDir);
    expect(merged.options).toEqual({
      "ext.a": true,
      "ext.b": true,
      "ext.c": true,
    });
  });

  it("reads configuration synchronously with readSync", async () => {
    await manager.update({ theme: "dark", prewarm: false }, "global");
    const syncConfig = manager.readSync();
    expect(syncConfig.theme).toBe("dark");
    expect(syncConfig.prewarm).toBe(false);
  });
});
