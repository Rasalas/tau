import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "./extension-system";

describe("ExtensionRegistry contribution selectors", () => {
  it("keeps sorted contribution references stable between reads", () => {
    const registry = new ExtensionRegistry();
    registry.addKnown({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", glyph: "p", Component: () => null });
    } });
    registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", glyph: "p", Component: () => null });
    } });
    expect(registry.getPanels()).toBe(registry.getPanels());
  });
});
