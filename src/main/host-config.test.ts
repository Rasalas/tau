import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      piAgentDir: join(tempDir, "pi"),
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

  it("merges keybindings and dotfile parameters properly", async () => {
    await manager.update({
      keybindings: { "workbench.focus-composer": "mod+1" },
      fontFamily: "Monaco",
      fontSize: 13,
      density: "compact",
      temperature: 0.7,
      maxTokens: 4096,
    }, "global");

    await manager.update({
      keybindings: { "workbench.focus-stage": "mod+3" },
      temperature: 0.2,
    }, "project", projectDir);

    const merged = await manager.read(projectDir);
    expect(merged.keybindings).toEqual({
      "workbench.focus-composer": "mod+1",
      "workbench.focus-stage": "mod+3",
    });
    expect(merged.fontFamily).toBe("Monaco");
    expect(merged.fontSize).toBe(13);
    expect(merged.density).toBe("compact");
    expect(merged.temperature).toBe(0.2);
    expect(merged.maxTokens).toBe(4096);
  });

  it("merges models and model presets properly", async () => {
    await manager.update({
      models: {
        default: "anthropic/claude-3-7-sonnet",
        thinkingLevel: "medium",
        presets: {
          fast: { model: "google/gemini-2.5-flash", temperature: 0.1 },
        },
      },
    }, "global");

    await manager.update({
      models: {
        thinkingLevel: "high",
        presets: {
          deep: { model: "anthropic/claude-3-7-sonnet", thinking: "high" },
        },
      },
    }, "project", projectDir);

    const merged = await manager.read(projectDir);
    expect(merged.models?.default).toBe("anthropic/claude-3-7-sonnet");
    expect(merged.models?.thinkingLevel).toBe("high");
    expect(merged.models?.presets?.fast).toEqual({ model: "google/gemini-2.5-flash", temperature: 0.1 });
    expect(merged.models?.presets?.deep).toEqual({ model: "anthropic/claude-3-7-sonnet", thinking: "high" });
  });

  describe("sanitizePatch (defence-in-depth against unknown keys)", () => {
    it("does not write unknown keys to the config file (Tau #06)", async () => {
      await manager.update({ theme: "dark", unknownKey: "should-not-appear" } as never, "global");
      const raw = JSON.parse(await readFile(globalPath, "utf8"));
      expect(raw.theme).toBe("dark");
      expect(raw.unknownKey).toBeUndefined();
    });

    it("does not write a wrong-typed known field to the config file (Tau #06)", async () => {
      // Start with a valid value so we can verify it is unchanged.
      await manager.update({ theme: "light" }, "global");
      // Now pass a wrong type for `showCosts`; it must be silently dropped.
      await manager.update({ showCosts: "yes" } as never, "global");
      const raw = JSON.parse(await readFile(globalPath, "utf8"));
      expect(raw.showCosts).toBeUndefined();
      // The valid field must survive the second update.
      expect(raw.theme).toBe("light");
    });

  });

  it("inherits configuration from Pi CLI settings when tau config is absent", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const piDir = join(tempDir, "pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4",
        defaultThinkingLevel: "low",
        theme: "nord",
        temperature: 0.7,
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        defaultTools: ["bash", "edit", "write"],
        shellPath: "/bin/zsh",
        shellCommandPrefix: "source ~/.zshrc",
        npmCommand: ["mise", "exec", "--", "npm"],
        quietStartup: true,
        defaultProjectTrust: "always",
      }),
      "utf8",
    );

    const config = await manager.read();
    expect(config.models?.default).toBe("anthropic/claude-sonnet-4");
    expect(config.models?.thinkingLevel).toBe("low");
    expect(config.theme).toBe("nord");
    expect(config.temperature).toBe(0.7);
    expect(config.compaction).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(config.retry).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
    expect(config.steeringMode).toBe("one-at-a-time");
    expect(config.followUpMode).toBe("all");
    expect(config.defaultTools).toEqual(["bash", "edit", "write"]);
    expect(config.shellPath).toBe("/bin/zsh");
    expect(config.shellCommandPrefix).toBe("source ~/.zshrc");
    expect(config.npmCommand).toEqual(["mise", "exec", "--", "npm"]);
    expect(config.quietStartup).toBe(true);
    expect(config.defaultProjectTrust).toBe("always");

    const syncConfig = manager.readSync();
    expect(syncConfig.models?.default).toBe("anthropic/claude-sonnet-4");
    expect(syncConfig.theme).toBe("nord");
    expect(syncConfig.compaction?.reserveTokens).toBe(16384);

    // Project Pi settings override global Pi settings
    const projectPiDir = join(projectDir, ".pi");
    await mkdir(projectPiDir, { recursive: true });
    await writeFile(
      join(projectPiDir, "settings.json"),
      JSON.stringify({
        defaultModel: "custom-local",
        defaultThinkingLevel: "high",
        compaction: { reserveTokens: 8192 },
      }),
      "utf8",
    );

    const projectMerged = await manager.read(projectDir);
    expect(projectMerged.models?.default).toBe("custom-local");
    expect(projectMerged.models?.thinkingLevel).toBe("high");
    expect(projectMerged.theme).toBe("nord"); // inherited from global Pi
    expect(projectMerged.compaction?.reserveTokens).toBe(8192);

    // Tau project config overrides Pi settings
    await manager.update({ theme: "tau-dark" }, "project", projectDir);
    const tauOverride = await manager.read(projectDir);
    expect(tauOverride.theme).toBe("tau-dark");
  });
});

