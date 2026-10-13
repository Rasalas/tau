import { describe, expect, it } from "vitest";
import { extensionOfPage, extensionPage, isSettingsNavGroup, parentSettingsPage, parseSettingsTarget, runtimeOfPage, runtimePage, settingsNavGroupOpen, settingsNavGroups, settingsTarget } from "./settings-nav";

describe("settings links", () => {
  it("names a page, an extension's page and a row on a page", () => {
    expect(parseSettingsTarget("general#setting-show-costs")).toEqual({ page: "general", anchor: "setting-show-costs" });
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

describe("links to rows that moved", () => {
  it("lands a row of General that went to Threads or Connections on its new page, and one that stayed on General", () => {
    expect(parseSettingsTarget("general#setting-run-on")).toEqual({ page: "threads", anchor: "setting-run-on" });
    expect(parseSettingsTarget("general#setting-command-line")).toEqual({ page: "connections", anchor: "setting-command-line" });
    expect(parseSettingsTarget("general#setting-trace-tabs")).toEqual({ page: "general", anchor: "setting-trace-tabs" });
    // A link that names another page than the one the row left is not touched.
    expect(parseSettingsTarget("threads#setting-run-on")).toEqual({ page: "threads", anchor: "setting-run-on" });
  });

  it("lands the terminal's font row, once Appearance's, on Terminal", () => {
    expect(parseSettingsTarget("appearance#setting-appearance-terminal-font")).toEqual({ page: "terminal.settings", anchor: "setting-terminal-font" });
    expect(parseSettingsTarget("terminal.settings#setting-terminal-font")).toEqual({ page: "terminal.settings", anchor: "setting-terminal-font" });
  });
});

describe("links to the pages that became Runtimes", () => {
  it("lands the older Models, Pi and Providers pages on Runtimes", () => {
    expect(parseSettingsTarget("models#setting-thinking-level")).toEqual({ page: "runtimes/pi", anchor: "setting-default-thinking" });
    expect(parseSettingsTarget("models#setting-default-model")).toEqual({ page: "runtimes/pi", anchor: "setting-default-model" });
    expect(parseSettingsTarget("pi#setting-startup-model")).toEqual({ page: "runtimes/pi", anchor: "setting-default-model" });
    expect(parseSettingsTarget("pi#setting-max-retries")).toEqual({ page: "runtimes/pi", anchor: "setting-retries" });
    expect(parseSettingsTarget("providers")).toEqual({ page: "runtimes" });
    expect(parseSettingsTarget("providers#runtime-models-codex@work")).toEqual({ page: "runtimes/codex@work", anchor: "runtime-models-codex@work" });
    expect(parseSettingsTarget("runtimes#runtime-permissions")).toEqual({ page: "runtimes", anchor: "runtime-permissions" });
  });

  it("names a runtime under the list of runtimes", () => {
    expect(runtimePage("codex@work")).toBe("runtimes/codex@work");
    expect(runtimeOfPage("runtimes/codex@work")).toBe("codex@work");
    expect(runtimeOfPage("runtimes")).toBeUndefined();
    expect(parentSettingsPage("runtimes/codex")).toBe("runtimes");
  });
});

describe("the section column's groups", () => {
  it("orders each group by `order`, leaves empty groups out and puts a page without a group under App", () => {
    const groups = settingsNavGroups([
      { id: "b", label: "B", group: "app", order: 10 },
      { id: "a", label: "A", group: "app", order: 0 },
      { id: "x", label: "X" },
      { id: "t", label: "T", group: "tools" },
      { id: "i", label: "I", group: "diagnostics" },
    ]);
    expect(groups.map((group) => [group.id, group.label, group.items.map((item) => item.id)])).toEqual([
      ["app", "App", ["a", "b", "x"]],
      ["tools", "Tools", ["t"]],
      ["diagnostics", "Diagnostics", ["i"]],
    ]);
  });

  it("still places a page by the name its group had before", () => {
    const groups = settingsNavGroups([
      { id: "g", label: "G", group: "general" },
      { id: "t", label: "T", group: "threads" },
      { id: "r", label: "R", group: "remote" },
      { id: "e", label: "E", group: "extensions" },
    ]);
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([["app", ["g", "e"]], ["agents", ["t"]], ["machines", ["r"]]]);
    expect(isSettingsNavGroup("remote")).toBe(true);
    expect(isSettingsNavGroup("toString")).toBe(false);
  });

  it("keeps App and Agents open and folds the others until they hold the page or the user opens them", () => {
    const [app, projects] = settingsNavGroups([{ id: "a", label: "A", group: "app" }, { id: "p", label: "P", group: "projects" }]);
    expect(settingsNavGroupOpen(app!, "p", {})).toBe(true);
    expect(settingsNavGroupOpen(projects!, "a", {})).toBe(false);
    expect(settingsNavGroupOpen(projects!, "p", {})).toBe(true);
    expect(settingsNavGroupOpen(projects!, "a", { projects: true })).toBe(true);
    expect(settingsNavGroupOpen(projects!, "p", { projects: false })).toBe(false);
  });
});
