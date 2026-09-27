import { describe, expect, it } from "vitest";
import type { UiToolRun } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { claudeCodeExtension } from "./desktop.js";
import { isAgentSdkTool, presentAgentSdkTool } from "./tool-presentation.js";

const call = (name: string, args: Record<string, unknown>, partial: Partial<UiToolRun> = {}): UiToolRun =>
  ({ id: "toolu_1", name, args, status: "done", startedAt: 1_000, endedAt: 2_000, ...partial });

describe("the Agent SDK runtime's tools", () => {
  it("names the command, the file or the pattern a call was about", () => {
    expect(presentAgentSdkTool(call("Bash", { command: "npm test", description: "Run the tests", timeout: 60_000 })))
      .toEqual({ glyph: "$", title: "Bash", tone: "shell", detail: "npm test" });
    expect(presentAgentSdkTool(call("Read", { file_path: "/repo/src/a.ts", limit: 40 }))).toMatchObject({ tone: "read", detail: "/repo/src/a.ts" });
    expect(presentAgentSdkTool(call("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }))).toMatchObject({ tone: "write", detail: "/repo/a.ts" });
    expect(presentAgentSdkTool(call("Grep", { pattern: "TODO", path: "src" }))).toMatchObject({ detail: "TODO" });
  });

  it("leaves Pi's own tools and unknown shapes to other renderers", () => {
    expect(isAgentSdkTool(call("bash", { command: "ls" }))).toBe(false);
    expect(isAgentSdkTool(call("Bash", {}))).toBe(false);
    expect(isAgentSdkTool(call("Bash", { command: "ls" }))).toBe(true);
  });

  it("claims the runtime's calls in the transcript once the kit is active", () => {
    const { registry } = createKitHarness();
    const bash = call("Bash", { command: "ls missing", description: "List a folder", timeout: 5_000 }, { status: "error", output: "Exit code 1" });
    registry.activate(claudeCodeExtension);
    expect(registry.presentTool(bash)).toMatchObject({ title: "Bash", detail: "ls missing" });
  });
});
