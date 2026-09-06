import { describe, expect, it } from "vitest";
import { dmgPattern, parseArgs, pickDmg } from "./install-mac.mjs";

describe("install-mac", () => {
  it("parses the version and open flags", () => {
    expect(parseArgs([])).toEqual({ version: undefined, open: false, help: false });
    expect(parseArgs(["--version", "v0.1.1", "--open"])).toEqual({ version: "v0.1.1", open: true, help: false });
    expect(() => parseArgs(["--version"])).toThrow("--version needs a tag");
    expect(() => parseArgs(["--linux"])).toThrow("unknown flag");
  });

  it("picks the image that matches the architecture", () => {
    const names = ["Tau-0.1.2-arm64.dmg", "Tau-0.1.2-arm64.dmg.blockmap", "Tau-0.1.2.dmg", "Tau-0.1.2.dmg.blockmap", "Tau-0.1.2.AppImage"];
    expect(pickDmg(names, "arm64")).toBe("Tau-0.1.2-arm64.dmg");
    expect(pickDmg(names, "x64")).toBe("Tau-0.1.2.dmg");
    expect(() => pickDmg(["Tau-0.1.2.AppImage"], "arm64")).toThrow("expected one .dmg");
    expect(dmgPattern("arm64")).toBe("Tau-*-arm64.dmg");
  });
});
