import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(merged.temperature).toBe(0.2);
    expect(merged.maxTokens).toBe(4096);
  });

  it("writes the settings Pi owns into Pi's own settings file", async () => {
    await manager.update({
      models: { default: "anthropic/claude-3-7-sonnet", thinkingLevel: "medium" },
      steeringMode: "all",
      compaction: { reserveTokens: 8192 },
    }, "global");

    const piRaw = JSON.parse(await readFile(join(tempDir, "pi", "settings.json"), "utf8"));
    expect(piRaw.defaultProvider).toBe("anthropic");
    expect(piRaw.defaultModel).toBe("claude-3-7-sonnet");
    expect(piRaw.defaultThinkingLevel).toBe("medium");
    expect(piRaw.steeringMode).toBe("all");
    expect(piRaw.compaction).toEqual({ reserveTokens: 8192 });

    // Nothing of it lands in Tau's own file: with no Tau-owned key in the patch
    // that file is not created at all.
    await expect(readFile(globalPath, "utf8")).rejects.toThrow();

    // It reads back through the same merge as a hand-written Pi setting.
    const config = await manager.read();
    expect(config.models?.default).toBe("anthropic/claude-3-7-sonnet");
    expect(config.models?.thinkingLevel).toBe("medium");
    expect(config.steeringMode).toBe("all");
    expect(config.compaction?.reserveTokens).toBe(8192);
  });

  it("keeps the Pi settings a user wrote by hand when it writes one key", async () => {
    const piDir = join(tempDir, "pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "settings.json"), JSON.stringify({
      theme: "nord",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4",
      packages: ["pi-skills"],
      someUnknownPiKey: 42,
    }), "utf8");

    await manager.update({ quietStartup: true }, "global");

    const raw = JSON.parse(await readFile(join(piDir, "settings.json"), "utf8"));
    expect(raw.quietStartup).toBe(true);
    expect(raw.packages).toEqual(["pi-skills"]);
    expect(raw.someUnknownPiKey).toBe(42);
    expect(raw.defaultProvider).toBe("anthropic");
    expect(raw.defaultModel).toBe("claude-sonnet-4");
  });

  it("writes a project-scoped Pi setting into the project's own .pi folder", async () => {
    await manager.update({ defaultProjectTrust: "never" }, "project", projectDir);

    const raw = JSON.parse(await readFile(join(projectDir, ".pi", "settings.json"), "utf8"));
    expect(raw.defaultProjectTrust).toBe("never");
    // A patch with no Tau-owned key must not create Tau's project config.
    await expect(readFile(join(projectDir, ".tau", "config.json"), "utf8")).rejects.toThrow();
  });

  it("lets Pi's own file win over a hand-written value in Tau's config", async () => {
    // A config written before Tau stopped accepting Pi-owned keys.
    await writeFile(globalPath, JSON.stringify({ steeringMode: "all", theme: "dark" }), "utf8");
    const piDir = join(tempDir, "pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "settings.json"), JSON.stringify({ steeringMode: "one-at-a-time" }), "utf8");

    const config = await manager.read();
    expect(config.steeringMode).toBe("one-at-a-time");
    expect(config.theme).toBe("dark");
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

  describe("levels", () => {
    it("reads the host and project files apart, without the keys Pi owns", async () => {
      await manager.update({ showCosts: false, values: { "tau.appearance.density": "compact" } }, "global");
      await manager.update({ transcriptDetail: "everything", values: { "tau.appearance.density": "comfortable" } }, "project", projectDir);
      await writeFile(globalPath, JSON.stringify({ ...JSON.parse(await readFile(globalPath, "utf8")), compaction: { enabled: false } }), "utf8");

      const layers = await manager.readLayers(projectDir);
      expect(layers.host).toEqual({ showCosts: false, values: { "tau.appearance.density": "compact" } });
      expect(layers.project).toEqual({ transcriptDetail: "everything", values: { "tau.appearance.density": "comfortable" } });
      expect(layers.projectPath).toBe(projectDir);
      expect(await manager.readLayers()).toEqual({ host: layers.host });
    });

    it("clears a project override so the host's value shows through again", async () => {
      await manager.update({ values: { "ext.mode": "a", "ext.other": "x" }, showCosts: true }, "global");
      await manager.update({ values: { "ext.mode": "b" }, showCosts: false }, "project", projectDir);
      expect((await manager.read(projectDir)).values?.["ext.mode"]).toBe("b");

      const layers = await manager.clear(["values.ext.mode", "showCosts"], "project", projectDir);
      expect(layers.project).toEqual({});
      const merged = await manager.read(projectDir);
      expect(merged.values).toEqual({ "ext.mode": "a", "ext.other": "x" });
      expect(merged.showCosts).toBe(true);
    });

    it("never clears a key Pi owns, and leaves a file it did not change alone", async () => {
      await writeFile(globalPath, JSON.stringify({ steeringMode: "all", showCosts: false }), "utf8");
      await manager.clear(["steeringMode"], "global");
      expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ steeringMode: "all", showCosts: false });
      await manager.clear(["showCosts"], "project", projectDir);
      await expect(readFile(join(projectDir, ".tau", "config.json"), "utf8")).rejects.toThrow();
    });

    it("keeps hostBackground and threads.continueAfterRestart, which the patch used to drop", async () => {
      await manager.update({ hostBackground: true, threads: { continueAfterRestart: true } }, "global");
      await manager.update({ threads: { continueAfterRestart: false } }, "project", projectDir);
      expect((await manager.read()).hostBackground).toBe(true);
      expect((await manager.read()).threads?.continueAfterRestart).toBe(true);
      expect((await manager.read(projectDir)).threads?.continueAfterRestart).toBe(false);
    });

    it("round-trips the update channel on the host level and clears it back to the default", async () => {
      await manager.update({ updates: { channel: "nightly" } }, "global");
      expect(JSON.parse(await readFile(globalPath, "utf8")).updates).toEqual({ channel: "nightly" });
      expect((await manager.read()).updates?.channel).toBe("nightly");
      expect((await manager.readLayers()).host.updates).toEqual({ channel: "nightly" });
      await manager.update({ updates: { channel: "beta" as never } }, "global");
      expect((await manager.read()).updates?.channel).toBe("nightly");
      const layers = await manager.clear(["updates.channel"], "global");
      expect(layers.host.updates).toBeUndefined();
      expect((await manager.read()).updates).toBeUndefined();
    });

    it("keeps the quit confirmations key by key and drops a mode it does not know", async () => {
      await manager.update({ confirm: { quit: "double-press" } }, "global");
      await manager.update({ confirm: { quitWhileRunning: false } }, "global");
      expect((await manager.read()).confirm).toEqual({ quit: "double-press", quitWhileRunning: false });
      await manager.update({ confirm: { quit: "never" as never } }, "global");
      expect((await manager.read()).confirm?.quit).toBe("double-press");
      await manager.clear(["confirm.quit"], "global");
      expect((await manager.read()).confirm).toEqual({ quitWhileRunning: false });
    });

    it("keeps the picker's model preferences per runtime and level, and clears one runtime's", async () => {
      await manager.update({ modelPreferences: { pi: { hidden: ["openai/o4-mini"] }, codex: { order: ["openai/gpt-5.6-luna"] } } }, "global");
      await manager.update({ modelPreferences: { codex: { hidden: ["openai/gpt-5.6-sol"] } } }, "global");
      await manager.update({ modelPreferences: { pi: { hidden: [] }, bad: { hidden: "x" } as never } }, "project", projectDir);
      expect((await manager.read()).modelPreferences).toEqual({ pi: { hidden: ["openai/o4-mini"] }, codex: { hidden: ["openai/gpt-5.6-sol"] } });
      expect((await manager.read(projectDir)).modelPreferences).toEqual({ pi: {}, codex: { hidden: ["openai/gpt-5.6-sol"] } });
      const layers = await manager.clear(["modelPreferences.pi"], "project", projectDir);
      expect(layers.project?.modelPreferences).toBeUndefined();
    });
  });
});
