import { describe, expect, it } from "vitest";
import { searchSettings, settingsSearchEntries } from "./settings-search";

const entries = settingsSearchEntries({
  pages: [
    { id: "usage", label: "Usage", keywords: ["tokens", "spend by model"], extensionName: "Usage" },
    { id: "look", label: "Look", rows: [{ id: "setting-look-density", label: "Density", keywords: ["compact"] }] },
  ],
  extensions: [
    { id: "tau.workspace", name: "Workspace Kit", options: [{ label: "Compact rows in the thread rail" }] },
    { id: "tau.runtime-settings", name: "Runtime Controls", core: true },
  ],
  keybindings: [
    { commandId: "search.files", keys: "mod+p", label: "⌘P", commandLabel: "Go to file…" },
    { commandId: "runtime.model", keys: "mod+shift+m", label: "⇧⌘M", commandLabel: "Set model…" },
    { commandId: "runtime.new-session", keys: "mod+n", label: "⌘N", commandLabel: "Create new thread" },
    { commandId: "terminal.new", keys: "mod+n", label: "⌘N", commandLabel: "New terminal" },
    { commandId: "terminal.new", keys: "mod+n", label: "⌘N", commandLabel: "New terminal" },
  ],
});

const ids = (query: string) => searchSettings(entries, query).map((entry) => entry.id);

describe("settings search", () => {
  it("finds a core row by a word it does not carry in its label", () => {
    expect(ids("vim")).toEqual(["general:Composer editing mode"]);
    expect(searchSettings(entries, "money")[0]).toMatchObject({ page: "general", label: "Show costs", section: "General", target: "setting-show-costs" });
    expect(searchSettings(entries, "vim")[0]?.target).toBe("setting-composer-editing-mode");
  });

  it("finds a contributed page by its keywords and an extension's page by an option", () => {
    expect(ids("tokens")).toContain("page:usage");
    expect(ids("compact rows")).toEqual(["extension:tau.workspace"]);
    expect(searchSettings(entries, "compact rows")[0]?.page).toBe("extensions/tau.workspace");
    expect(ids("runtime controls")).toEqual([]);
  });

  it("finds a keybinding by its command, its chord or its id, and opens the Keybindings page filtered to it", () => {
    expect(searchSettings(entries, "go to file")).toEqual([expect.objectContaining({ page: "keybindings", filter: "search.files" })]);
    expect(ids("mod+p")).toEqual(["keybinding:mod+p"]);
    expect(ids("search.files")).toEqual(["keybinding:mod+p"]);
    // One chord in two contexts is two results; the same binding twice is one.
    expect(ids("mod+n")).toEqual(["keybinding:mod+n", "keybinding:mod+n:terminal.new"]);
  });

  it("ranks a label that starts with the query first and a keybinding after every other match", () => {
    const found = ids("model");
    expect(found[0]).toBe("runtimes/pi:Default model");
    expect(found.indexOf("runtimes/pi:Default model")).toBeLessThan(found.indexOf("keybinding:mod+shift+m"));
    expect(found.at(-1)).toBe("keybinding:mod+shift+m");
  });

  it("needs every word of the query and answers nothing for an empty one", () => {
    expect(ids("show costs")).toEqual(["general:Show costs"]);
    expect(ids("costs nothing")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("finds the rows a contributed page named and scrolls to them", () => {
    expect(searchSettings(entries, "density")[0]).toMatchObject({ id: "look:setting-look-density", page: "look", section: "Look", target: "setting-look-density" });
    expect(ids("compact")).toContain("look:setting-look-density");
  });

  it("anchors every row of General, Pi's and About", () => {
    expect(searchSettings(entries, "temperature")[0]).toMatchObject({ page: "runtimes/pi", section: "Pi", target: "setting-temperature" });
    expect(searchSettings(entries, "reserve tokens")[0]).toMatchObject({ page: "runtimes/pi", label: "Room for the reply", target: "setting-room-for-the-reply" });
    expect(searchSettings(entries, "update track")[0]).toMatchObject({ page: "about", target: "setting-pre-release-builds" });
  });

  it("sends the rows of General's New threads and Threads cards to Threads", () => {
    const threads = settingsSearchEntries({
      pages: [],
      extensions: [],
      sections: [
        { page: "general", card: "new-threads", rows: [{ id: "setting-run-on", label: "Run on", keywords: ["machine"] }] },
        { page: "general", card: "threads", rows: [{ id: "setting-settle-automatically", label: "Settle automatically" }] },
        { page: "general", rows: [{ id: "setting-loose", label: "Loose row" }] },
      ],
    });
    expect(searchSettings(threads, "run on")[0]).toMatchObject({ page: "threads", section: "Threads", target: "setting-run-on" });
    expect(searchSettings(threads, "settle automatically")[0]).toMatchObject({ page: "threads", target: "setting-settle-automatically" });
    expect(searchSettings(threads, "loose row")[0]).toMatchObject({ page: "general" });
  });

  it("finds the rows a section named on a core page, and leaves out a section's rows on no fixed page", () => {
    const withSections = settingsSearchEntries({
      pages: [],
      extensions: [],
      sections: [
        { page: "connections", rows: [{ id: "setting-tailnet-https", label: "Tailnet HTTPS", keywords: ["funnel-serve"] }] },
        { page: "extension", rows: [{ id: "setting-nowhere", label: "Nowhere" }] },
      ],
    });
    expect(searchSettings(withSections, "tailnet https")[0]).toMatchObject({ page: "connections", section: "Connections", target: "setting-tailnet-https" });
    expect(searchSettings(withSections, "nowhere")).toEqual([]);
  });

  it("leaves keybindings out when it is asked for pages only", () => {
    const pagesOnly = settingsSearchEntries({ pages: [], extensions: [] });
    expect(searchSettings(pagesOnly, "keybindings").map((entry) => entry.id)).toEqual(["page:keybindings"]);
  });
});
