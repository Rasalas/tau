import { describe, expect, it } from "vitest";
import { searchSettings, settingsSearchEntries } from "./settings-search";

const entries = settingsSearchEntries({
  pages: [{ id: "usage", label: "Usage", keywords: ["tokens", "spend by model"], extensionName: "Usage" }],
  extensions: [
    { id: "tau.workspace", name: "Workspace Kit", options: [{ label: "Compact rows in the thread rail" }] },
    { id: "tau.runtime-settings", name: "Runtime Controls", core: true },
  ],
  keybindings: [
    { commandId: "search.files", keys: "mod+p", label: "⌘P", commandLabel: "Go to file…" },
    { commandId: "runtime.model", keys: "mod+shift+m", label: "⇧⌘M", commandLabel: "Set model…" },
  ],
});

const ids = (query: string) => searchSettings(entries, query).map((entry) => entry.id);

describe("settings search", () => {
  it("finds a core row by a word it does not carry in its label", () => {
    expect(ids("vim")).toEqual(["defaults:Composer editing mode"]);
    expect(searchSettings(entries, "dark")[0]).toMatchObject({ page: "defaults", label: "Theme", section: "Defaults" });
  });

  it("finds a contributed page by its keywords and an extension's page by an option", () => {
    expect(ids("tokens")).toContain("page:usage");
    expect(ids("compact rows")).toEqual(["extension:tau.workspace"]);
    expect(ids("runtime controls")).toEqual([]);
  });

  it("finds a keybinding by its command, its chord or its id, and opens the Keybindings page filtered to it", () => {
    expect(searchSettings(entries, "go to file")).toEqual([expect.objectContaining({ page: "keybindings", filter: "search.files" })]);
    expect(ids("mod+p")).toEqual(["keybinding:mod+p"]);
    expect(ids("search.files")).toEqual(["keybinding:mod+p"]);
  });

  it("ranks a label that starts with the query first and a keybinding after every other match", () => {
    const found = ids("model");
    expect(found[0]).toBe("defaults:Model parameters");
    expect(found.indexOf("defaults:Default model")).toBeLessThan(found.indexOf("keybinding:mod+shift+m"));
    expect(found.at(-1)).toBe("keybinding:mod+shift+m");
  });

  it("needs every word of the query and answers nothing for an empty one", () => {
    expect(ids("font size")).toEqual(["defaults:Font size"]);
    expect(ids("font nothing")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("leaves keybindings out when it is asked for pages only", () => {
    const pagesOnly = settingsSearchEntries({ pages: [], extensions: [] });
    expect(searchSettings(pagesOnly, "keybindings").map((entry) => entry.id)).toEqual(["page:keybindings"]);
  });
});
