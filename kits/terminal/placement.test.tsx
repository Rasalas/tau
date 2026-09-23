// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import terminal from "./desktop.js";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PANEL, TERMINAL_PLACEMENT_SETTING, terminalPlacement } from "./protocol.js";

describe("terminal placement", () => {
  it("reads anything but drawer as the dock", () => {
    expect(terminalPlacement("drawer")).toBe("drawer");
    expect(terminalPlacement(undefined)).toBe("dock");
    expect(terminalPlacement("bottom")).toBe("dock");
  });

  it("moves the panel between dock and drawer when the setting changes, maximizable in both", () => {
    const { registry, preferences } = createKitHarness();
    registry.activate(terminal);
    const placed = () => registry.getPanels().filter((panel) => panel.id === TERMINAL_PANEL).map((panel) => [panel.placement, panel.maximizable]);
    expect(placed()).toEqual([["dock", true]]);
    preferences.setValue(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, "drawer");
    expect(placed()).toEqual([["drawer", true]]);
    preferences.setValue(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, "dock");
    expect(placed()).toEqual([["dock", true]]);
    registry.deactivate(terminal.id);
    expect(placed()).toEqual([]);
  });
});
