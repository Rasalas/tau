import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexHome, parseCodexConfig, readCodexConfiguredModel } from "./config.js";

describe("Codex config.toml", () => {
  it("reads the model and effort at the top of the file", () => {
    expect(parseCodexConfig('model = "gpt-5.6-luna"  # cheapest\nmodel_reasoning_effort = \'low\'\n\n[mcp_servers.x]\nmodel = "not-this"\n')).toEqual({ model: "gpt-5.6-luna", effort: "low" });
  });

  it("lets the chosen profile override them", () => {
    const toml = 'model = "gpt-5.6-sol"\nprofile = "cheap"\n\n[profiles.cheap]\nmodel = "gpt-5.6-luna"\n\n[profiles."other"]\nmodel_reasoning_effort = "high"\n';
    expect(parseCodexConfig(toml)).toEqual({ model: "gpt-5.6-luna" });
  });

  it("answers nothing for a file without them or no file at all", async () => {
    expect(parseCodexConfig("# empty\n[features]\nshell_tool = false\n")).toEqual({});
    const dir = await mkdtemp(join(tmpdir(), "tau-codex-config-"));
    try {
      await expect(readCodexConfiguredModel(dir)).resolves.toEqual({});
      await writeFile(join(dir, "config.toml"), 'model = "gpt-5.5"\n');
      await expect(readCodexConfiguredModel(dir)).resolves.toEqual({ model: "gpt-5.5" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds the home in CODEX_HOME", () => {
    expect(codexHome({ CODEX_HOME: "/shadow/codex" })).toBe("/shadow/codex");
  });
});
