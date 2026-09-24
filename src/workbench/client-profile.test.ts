import { describe, expect, it } from "vitest";
import { browserClientProfile, compactFormFor, compactSidebarWidth, layoutProfileFor, parseClientProfile } from "./client-profile";

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

  it("a touch screen claims compact at any width, unless the address says otherwise", () => {
    expect(browserClientProfile(1024, null, true)).toBe("compact");
    expect(browserClientProfile(1024, "web", true)).toBe("web");
  });

  it("a compact client splits into list and thread only when it is tablet-sized", () => {
    expect(compactFormFor("compact", 390, 844)).toBe("single");
    expect(compactFormFor("compact", 844, 390)).toBe("single");
    expect(compactFormFor("compact", 820, 1180)).toBe("split");
    expect(compactFormFor("compact", 720, 600)).toBe("split");
    // A desktop window narrowed below 720 px is compact, and never splits.
    expect(compactFormFor("desktop", 1400, 900)).toBe("single");
  });

  it("gives the split's thread list a third of the width, within bounds", () => {
    expect(compactSidebarWidth(720)).toBe(280);
    expect(compactSidebarWidth(1024)).toBe(328);
    expect(compactSidebarWidth(1366)).toBe(380);
  });
});
