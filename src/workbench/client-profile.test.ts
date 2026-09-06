import { describe, expect, it } from "vitest";
import { browserClientProfile, layoutProfileFor, parseClientProfile } from "./client-profile";

describe("client profile selection", () => {
  it("a browser claims web, or compact when it starts narrow", () => {
    expect(browserClientProfile(1200)).toBe("web");
    expect(browserClientProfile(400)).toBe("compact");
    expect(browserClientProfile(719)).toBe("compact");
    expect(browserClientProfile(720)).toBe("web");
  });

  it("an explicit profile beats the width", () => {
    expect(browserClientProfile(400, "web")).toBe("web");
    expect(browserClientProfile(1200, "compact")).toBe("compact");
    expect(browserClientProfile(1200, "nonsense")).toBe("web");
    expect(parseClientProfile("desktop")).toBe("desktop");
    expect(parseClientProfile(null)).toBeUndefined();
  });

  it("the layout, unlike the claim, follows the current width on every client", () => {
    expect(layoutProfileFor("desktop", 1400)).toBe("desktop");
    expect(layoutProfileFor("desktop", 400)).toBe("compact");
    expect(layoutProfileFor("web", 400)).toBe("compact");
    expect(layoutProfileFor("compact", 1400)).toBe("compact");
  });
});
