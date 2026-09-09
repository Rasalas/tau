import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPromptOverrides } from "./system-prompt-resolver.js";

describe("discoverPromptOverrides", () => {
  let testDir: string;
  let fakeHome: string;
  let fakeAgent: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tau-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fakeHome = join(testDir, "home");
    fakeAgent = join(testDir, "agent");
    mkdirSync(join(testDir, "project"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeAgent, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns empty overrides when no prompt files exist", () => {
    const projectCwd = join(testDir, "project");
    const result = discoverPromptOverrides(projectCwd, fakeAgent, fakeHome);
    expect(result.customPrompt).toBeUndefined();
    expect(result.appendPrompts).toEqual([]);
    expect(result.contextFiles).toEqual([]);
  });

  it("discovers .tau/system-prompt.md in project workspace", () => {
    const projectCwd = join(testDir, "project");
    const tauDir = join(projectCwd, ".tau");
    mkdirSync(tauDir, { recursive: true });
    writeFileSync(join(tauDir, "system-prompt.md"), "You are Tau Agent.");

    const result = discoverPromptOverrides(projectCwd, fakeAgent, fakeHome);
    expect(result.customPrompt).toEqual({
      path: join(tauDir, "system-prompt.md"),
      content: "You are Tau Agent.",
    });
  });

  it("prioritizes project .tau/system-prompt.md over user home ~/.tau/system-prompt.md", () => {
    const projectCwd = join(testDir, "project");
    const projectTauDir = join(projectCwd, ".tau");
    mkdirSync(projectTauDir, { recursive: true });
    writeFileSync(join(projectTauDir, "system-prompt.md"), "Project prompt");

    const userTauDir = join(fakeHome, ".tau");
    mkdirSync(userTauDir, { recursive: true });
    writeFileSync(join(userTauDir, "system-prompt.md"), "User prompt");

    const result = discoverPromptOverrides(projectCwd, fakeAgent, fakeHome);
    expect(result.customPrompt?.content).toBe("Project prompt");
  });

  it("falls back to user home ~/.tau/system-prompt.md when project has none", () => {
    const projectCwd = join(testDir, "project");
    const userTauDir = join(fakeHome, ".tau");
    mkdirSync(userTauDir, { recursive: true });
    writeFileSync(join(userTauDir, "system-prompt.md"), "User prompt");

    const result = discoverPromptOverrides(projectCwd, fakeAgent, fakeHome);
    expect(result.customPrompt?.content).toBe("User prompt");
  });

  it("discovers project append prompts and context files", () => {
    const projectCwd = join(testDir, "project");
    const projectTauDir = join(projectCwd, ".tau");
    mkdirSync(projectTauDir, { recursive: true });
    writeFileSync(join(projectTauDir, "append-system-prompt.md"), "Always write TypeScript.");
    writeFileSync(join(projectTauDir, "AGENTS.md"), "# Project Rules");

    const result = discoverPromptOverrides(projectCwd, fakeAgent, fakeHome);
    expect(result.appendPrompts).toEqual([
      {
        path: join(projectTauDir, "append-system-prompt.md"),
        content: "Always write TypeScript.",
      },
    ]);
    expect(result.contextFiles).toEqual([
      {
        path: join(projectTauDir, "AGENTS.md"),
        content: "# Project Rules",
      },
    ]);
  });
});
