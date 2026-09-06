// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { UiToolRun } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { computerUsePresentationExtension, presentComputerUse } from "./desktop.js";

const toolRun = (name: string, args: Record<string, unknown>): UiToolRun =>
  ({ id: name, name, args, status: "done", startedAt: 0, endedAt: 1 });

describe("Computer Use presentation", () => {
  it("names the operation, tells perception from action and hides the driver's JSON", () => {
    expect(presentComputerUse("computer_use_get_window_state", { pid: 42, window_id: 7 })).toEqual({
      glyph: "◉", title: "Window state", tone: "read", detail: "window 7 · pid 42", output: "hidden",
    });
    expect(presentComputerUse("computer_use_launch_app", { name: "Safari" })).toMatchObject({
      glyph: "↗", title: "Launch app", tone: "write", detail: "Safari",
    });
    expect(presentComputerUse("computer_use_page", { action: "click_element", url: "https://example.com" })).toMatchObject({
      detail: "https://example.com",
    });
    expect(presentComputerUse("computer_use_click", {}).detail).toBe("desktop");
  });

  it("claims every computer-use tool and nothing else", () => {
    const { registry } = createKitHarness();
    registry.activate(computerUsePresentationExtension);

    expect(registry.presentTool(toolRun("computer_use_zoom", {}))).toMatchObject({ title: "Zoom", output: "hidden" });
    expect(registry.presentTool(toolRun("read", { path: "a.ts" })).output).not.toBe("hidden");
  });
});
