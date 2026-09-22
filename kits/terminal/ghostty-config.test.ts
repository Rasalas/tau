import { describe, expect, it } from "vitest";
import { ghosttyConfigPaths, ghosttyFontDefaults, parseGhosttyLine, readGhosttyFont } from "./ghostty-config.js";

/** A file system of strings; anything not listed is missing. */
function files(entries: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    read: (path: string) => {
      reads.push(path);
      return entries[path];
    },
  };
}

describe("parseGhosttyLine", () => {
  it("reads key and value with or without spaces and strips one pair of quotes", () => {
    expect(parseGhosttyLine("font-family = \"JetBrains Mono\"")).toEqual({ key: "font-family", value: "JetBrains Mono" });
    expect(parseGhosttyLine("font-size=16")).toEqual({ key: "font-size", value: "16" });
    expect(parseGhosttyLine("  font-size =13.5  ")).toEqual({ key: "font-size", value: "13.5" });
    expect(parseGhosttyLine("font-family =")).toEqual({ key: "font-family", value: "" });
  });

  it("skips comments, blanks and lines without a key", () => {
    expect(parseGhosttyLine("# font-family = Menlo")).toBeUndefined();
    expect(parseGhosttyLine("   ")).toBeUndefined();
    expect(parseGhosttyLine("= value")).toBeUndefined();
    expect(parseGhosttyLine("just words")).toBeUndefined();
  });

  it("keeps a # after the value, because Ghostty has no trailing comments", () => {
    expect(parseGhosttyLine("background = #123abc")).toEqual({ key: "background", value: "#123abc" });
  });
});

describe("readGhosttyFont", () => {
  it("reads the user's font the way the shipped template writes it", () => {
    const fs = files({
      "/support/config": [
        "# Config syntax crash course",
        "font-family = \"JetBrains Mono\"",
        "font-size=16",
        "adjust-cell-height = -15%",
        "# font-size = 99",
      ].join("\n"),
    });
    expect(readGhosttyFont(["/xdg/ghostty/config", "/support/config"], fs.read, "/home")).toEqual({
      families: ["JetBrains Mono"], size: 16, files: ["/support/config"], problems: [],
    });
  });

  it("adds fallbacks for a repeated font-family and clears them on an empty value", () => {
    const fs = files({ "/a": "font-family = Iosevka\nfont-family = \"Symbols Nerd Font\"\n", "/b": "font-family =\nfont-family = Menlo\n" });
    expect(readGhosttyFont(["/a"], fs.read).families).toEqual(["Iosevka", "Symbols Nerd Font"]);
    expect(readGhosttyFont(["/a", "/b"], fs.read).families).toEqual(["Menlo"]);
  });

  it("lets a later file override the size and an empty value reset it", () => {
    const fs = files({ "/a": "font-size = 13", "/b": "font-size = 14.5", "/c": "font-size =" });
    expect(readGhosttyFont(["/a", "/b"], fs.read).size).toBe(14.5);
    expect(readGhosttyFont(["/a", "/c"], fs.read).size).toBeUndefined();
  });

  it("reports a size that is not a number and keeps the one before it", () => {
    const fs = files({ "/a": "font-size = 13\nfont-size = large" });
    const state = readGhosttyFont(["/a"], fs.read);
    expect(state.size).toBe(13);
    expect(state.problems).toEqual(["/a: font-size \"large\" is not a number"]);
  });

  it("follows config-file after the including file, relative to it, with ~ and optional includes", () => {
    const fs = files({
      "/cfg/ghostty/config": "config-file = fonts/main\nfont-family = Menlo\nfont-size = 11\nconfig-file = ?missing\nconfig-file = \"~/extra\"",
      "/cfg/ghostty/fonts/main": "font-size = 18",
      "/home/extra": "font-family = \"Fira Code\"",
    });
    const state = readGhosttyFont(["/cfg/ghostty/config"], fs.read, "/home");
    // The include is applied after its file, so its size wins over the line below it.
    expect(state).toEqual({
      families: ["Menlo", "Fira Code"],
      size: 18,
      files: ["/cfg/ghostty/config", "/cfg/ghostty/fonts/main", "/home/extra"],
      problems: [],
    });
  });

  it("names a required include that is missing and reads a cycle once", () => {
    const fs = files({ "/a": "config-file = /b\nconfig-file = /gone", "/b": "font-size = 12\nconfig-file = /a" });
    const state = readGhosttyFont(["/a"], fs.read);
    expect(state.files).toEqual(["/a", "/b"]);
    expect(state.size).toBe(12);
    expect(state.problems).toEqual(["/gone: not found"]);
  });

  it("stops following includes that nest too deeply", () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 14; index += 1) entries[`/f${index}`] = `config-file = /f${index + 1}`;
    const state = readGhosttyFont(["/f0"], files(entries).read);
    expect(state.files).toHaveLength(11);
    expect(state.problems).toEqual(["/f11: included too deeply"]);
  });
});

describe("ghosttyConfigPaths", () => {
  it("reads XDG first and Application Support after it on macOS", () => {
    expect(ghosttyConfigPaths({}, "/Users/me", "darwin")).toEqual([
      "/Users/me/.config/ghostty/config",
      "/Users/me/.config/ghostty/config.ghostty",
      "/Users/me/Library/Application Support/com.mitchellh.ghostty/config",
      "/Users/me/Library/Application Support/com.mitchellh.ghostty/config.ghostty",
    ]);
  });

  it("uses XDG_CONFIG_HOME when it is set, and skips Application Support elsewhere", () => {
    expect(ghosttyConfigPaths({ XDG_CONFIG_HOME: "/xdg" }, "/home/me", "linux")).toEqual(["/xdg/ghostty/config", "/xdg/ghostty/config.ghostty"]);
  });
});

describe("ghosttyFontDefaults", () => {
  it("answers with empty defaults when no config exists", () => {
    expect(ghosttyFontDefaults(() => undefined)).toEqual({ families: [], files: [], problems: [] });
  });
});
