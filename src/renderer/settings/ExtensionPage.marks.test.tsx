// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { ExtensionGlyph, extensionMarks } from "./ExtensionPage";
import type { ExtensionEntry } from "./extension-catalog";

afterEach(cleanup);

const entry = (id: string, extra: Partial<ExtensionEntry> = {}): ExtensionEntry => ({ id, name: id, origin: "bundled", state: "on", locked: false, theme: false, permissions: [], ...extra });

describe("extension marks", () => {
  it("keeps a runtime kit's mark on a phone, where its settings page is not drawn", () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile: "compact" });
    registry.activate({
      id: "acme.runtime",
      name: "Runtime",
      activate(context) {
        context.registerSettingsPage({ id: "acme.runtime.settings", label: "Runtime", runtime: "acme", profiles: ["desktop"], Component: () => null });
        context.registerPanel({ id: "acme.bell", label: "Bell", Icon: Bell, profiles: ["desktop"], Component: () => null });
      },
    });
    expect(registry.getSettingsPages()).toEqual([]);
    expect(extensionMarks(registry).get("acme.runtime")).toEqual({ runtime: "acme" });
    registry.deactivate("acme.runtime");
    expect(extensionMarks(registry).get("acme.runtime")).toEqual({ runtime: "acme" });
  });

  it("falls back to the manifest's icon, and to Tau's own for a part of the window", async () => {
    const registry = new ExtensionRegistry();
    const marks = extensionMarks(registry, [
      entry("acme.search", { pkg: { id: "acme.search", name: "Search", icon: "Search", scope: "bundled" } as ExtensionEntry["pkg"] }),
      entry("tau.core", { origin: "app" }),
      entry("acme.plain"),
    ]);
    expect(marks.get("acme.search")).toEqual({ iconName: "Search" });
    expect(marks.get("tau.core")).toHaveProperty("Icon");
    expect(marks.get("acme.plain")).toBeUndefined();

    const view = render(<ExtensionGlyph name="Search" mark={marks.get("acme.search")} />);
    expect(view.container.querySelector("b")?.textContent).toBe("S");
    await view.findByText((_, element) => element?.tagName.toLowerCase() === "svg");
    expect(view.container.querySelector("b")).toBeNull();
  });
});
