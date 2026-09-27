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

  it("a compact client splits into list and thread only on a tablet at least 720 px wide", () => {
    // Phones, upright and on their side: the screen's short side decides, not the window.
    expect(compactFormFor("compact", 390, 390)).toBe("single");
    expect(compactFormFor("compact", 844, 390)).toBe("single");
    expect(compactFormFor("compact", 956, 440)).toBe("single");
    // iPad upright, on its side, and an iPad mini.
    expect(compactFormFor("compact", 820, 820)).toBe("split");
    expect(compactFormFor("compact", 1180, 820)).toBe("split");
    expect(compactFormFor("compact", 744, 744)).toBe("split");
    // Slide Over and a narrow Split View are phones.
    expect(compactFormFor("compact", 375, 820)).toBe("single");
    expect(compactFormFor("compact", 592, 820)).toBe("single");
    // A desktop window narrowed below 720 px is compact, and never splits.
    expect(compactFormFor("desktop", 1400, 900)).toBe("single");
  });

  it("keeps a split through small changes of width", () => {
    // The threshold from single, and the lower one once split.
    expect(compactFormFor("compact", 719, 820, "single")).toBe("single");
    expect(compactFormFor("compact", 720, 820, "single")).toBe("split");
    expect(compactFormFor("compact", 700, 820, "split")).toBe("split");
    expect(compactFormFor("compact", 680, 820, "split")).toBe("split");
    expect(compactFormFor("compact", 679, 820, "split")).toBe("single");
  });

  it("widens a compact desktop window again only past the band", () => {
    expect(layoutProfileFor("desktop", 719, "desktop")).toBe("compact");
    expect(layoutProfileFor("desktop", 720, "desktop")).toBe("desktop");
    expect(layoutProfileFor("desktop", 740, "compact")).toBe("compact");
    expect(layoutProfileFor("desktop", 760, "compact")).toBe("desktop");
  });

  it("gives the split's thread list a third of the width, within bounds", () => {
    expect(compactSidebarWidth(720)).toBe(280);
    expect(compactSidebarWidth(1024)).toBe(328);
    expect(compactSidebarWidth(1366)).toBe(380);
  });
});
