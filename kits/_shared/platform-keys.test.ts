import { describe, expect, it } from "vitest";
import { isMacClient, modEnterLabel, modKeyLabel } from "./platform-keys.js";

describe("platform key labels", () => {
  it("spells the modifier the way the platform's keyboard does", () => {
    expect(isMacClient("MacIntel")).toBe(true);
    expect(isMacClient("iPad")).toBe(true);
    expect(isMacClient("Win32")).toBe(false);
    expect(isMacClient("Linux x86_64")).toBe(false);
    expect(modKeyLabel(true)).toBe("⌘");
    expect(modKeyLabel(false)).toBe("Ctrl");
    expect(modEnterLabel(true)).toBe("⌘↵");
    expect(modEnterLabel(false)).toBe("Ctrl+↵");
  });
});
