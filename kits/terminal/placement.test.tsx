// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopExtension } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import terminal from "./desktop.js";
import { terminalFont } from "./store.js";
import {
  TERMINAL_FONT_SERVICE, TERMINAL_HOST_EXTENSION_ID, TERMINAL_PANEL, TERMINAL_PLACEMENT_SETTING, terminalPlacement, type TerminalFontService,
} from "./protocol.js";

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

describe("Settings → Terminal", () => {
  it("is a row with the level the placement comes from, and moves the panel", () => {
    const { registry, preferences } = createKitHarness();
    registry.activate(terminal);
    const page = registry.getSettingsPages().find((entry) => entry.id === "terminal.settings")!;
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    expect(screen.getByRole("heading", { level: 3, name: "Show the terminal in" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Show the terminal in" })).getByRole("button", { name: "Drawer" }));
    expect(preferences.value(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING)).toBe("drawer");
    expect(registry.getPanels().find((panel) => panel.id === TERMINAL_PANEL)?.placement).toBe("drawer");
    cleanup();
    registry.deactivate(terminal.id);
  });
});

describe("the terminal font service", () => {
  it("publishes what the terminal draws with and writes the kit's settings", async () => {
    const ghostty = { families: ["JetBrains Mono, Menlo"], size: 13, files: ["/home/.config/ghostty/config"], problems: [] };
    const invoke = vi.fn(async (_extension: string, command: string) => command === "font" ? ghostty : command === "list" ? [] : undefined);
    const { registry, preferences } = createKitHarness(invoke);
    let service: TerminalFontService | undefined;
    const consumer: DesktopExtension = {
      id: "test.consumer",
      name: "Consumer",
      activate(plugin) {
        plugin.useService<TerminalFontService>(TERMINAL_FONT_SERVICE, (value) => {
          service = value;
          return () => { service = undefined; };
        });
      },
    };
    registry.activate(consumer);
    registry.activate(terminal);
    try {
      await vi.waitFor(() => expect(service?.getSnapshot().ghostty).toBeDefined());
      const first = service!.getSnapshot();
      expect(first).toMatchObject({
        family: "", size: "",
        resolved: { face: "JetBrains Mono", size: 13, familySource: "ghostty", sizeSource: "ghostty" },
        ghostty: { face: "JetBrains Mono", size: 13, files: ["/home/.config/ghostty/config"] },
        sizeRange: { min: 6, max: 32 },
      });
      expect(service!.getSnapshot()).toBe(first);

      const changed = vi.fn();
      const stop = service!.subscribe(changed);
      service!.set({ family: " Iosevka ", size: "15" });
      expect(preferences.value(TERMINAL_HOST_EXTENSION_ID, "fontFamily")).toBe("Iosevka");
      expect(service!.getSnapshot()).toMatchObject({ family: "Iosevka", size: "15", resolved: { face: "Iosevka", size: 15, familySource: "settings" } });
      expect(changed).toHaveBeenCalled();
      service!.set({ family: "", size: "" });
      expect(service!.getSnapshot().resolved.familySource).toBe("ghostty");
      stop();

      registry.deactivate(terminal.id);
      expect(service).toBeUndefined();
    } finally {
      terminalFont.setSettings({});
      terminalFont.setGhostty(undefined);
    }
  });
});
