// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { UiToolRun } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { observatoryExtension } from "./desktop.js";

const toolRun = (name: string, args: Record<string, unknown>): UiToolRun =>
  ({ id: name, name, args, status: "done", startedAt: 0, endedAt: 1 });

describe("Signals desktop extension", () => {
  it("presents a shell run by the command it ran", () => {
    const { registry } = createKitHarness();
    registry.activate(observatoryExtension);

    expect(registry.presentTool(toolRun("bash", { command: "npm test" }))).toMatchObject({ glyph: "$", title: "bash", tone: "shell", detail: "npm test" });
    expect(registry.presentTool(toolRun("powershell", {}))).toMatchObject({ tone: "shell", detail: "shell command" });
    // A tool no renderer claims keeps core's own presentation.
    expect(registry.presentTool(toolRun("read", { path: "a.ts" })).tone).not.toBe("shell");
  });
});
