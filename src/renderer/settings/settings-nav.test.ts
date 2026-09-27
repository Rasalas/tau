import { describe, expect, it } from "vitest";
import { extensionOfPage, extensionPage, parentSettingsPage, parseSettingsTarget, settingsNavGroups, settingsTarget } from "./settings-nav";

describe("settings links", () => {
  it("names a page, an extension's page and a row on a page", () => {
    expect(parseSettingsTarget("models#setting-thinking-level")).toEqual({ page: "models", anchor: "setting-thinking-level" });
    expect(parseSettingsTarget("extensions/tau.terminal")).toEqual({ page: "extensions/tau.terminal" });
    expect(settingsTarget("general", "setting-show-costs")).toBe("general#setting-show-costs");
    expect(settingsTarget("general")).toBe("general");
  });

  it("takes the older name of General and an empty link to General", () => {
    expect(parseSettingsTarget("defaults")).toEqual({ page: "general" });
    expect(parseSettingsTarget(undefined)).toEqual({ page: "general" });
    expect(parseSettingsTarget("")).toEqual({ page: "general" });
  });

  it("puts an extension's page under the list of extensions", () => {
    expect(extensionPage("acme.hello")).toBe("extensions/acme.hello");
    expect(extensionOfPage("extensions/acme.hello")).toBe("acme.hello");
    expect(extensionOfPage("extensions")).toBeUndefined();
    expect(parentSettingsPage("extensions/acme.hello")).toBe("extensions");
    expect(parentSettingsPage("general")).toBeUndefined();
  });
});

describe("the section column's groups", () => {
  it("orders each group by `order`, leaves empty groups out and puts a page without a group under Extensions", () => {
    const groups = settingsNavGroups([
      { id: "b", label: "B", group: "general", order: 10 },
      { id: "a", label: "A", group: "general", order: 0 },
      { id: "x", label: "X" },
      { id: "i", label: "I", group: "diagnostics" },
    ]);
    expect(groups.map((group) => [group.id, group.label, group.items.map((item) => item.id)])).toEqual([
      ["general", undefined, ["a", "b"]],
      ["extensions", "Extensions", ["x"]],
      ["diagnostics", "Diagnostics", ["i"]],
    ]);
  });
});
