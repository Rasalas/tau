// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TestProviders } from "../test-support/test-providers";
import { GeneralPage } from "./GeneralPage";
import { SettingRow } from "./settings-layout";

afterEach(cleanup);

describe("Settings → General", () => {
  it("draws the design's cards, a kit's rows in the card they name, and Tau's own settings in cards of their own", () => {
    render(<TestProviders><GeneralPage themeHere={false} sections={[
      { id: "kit.trace", card: "threads", order: 30, Component: () => <SettingRow title="Trace tabs" /> },
      { id: "kit.settle", card: "threads", order: 10, Component: () => <SettingRow title="Settle automatically" /> },
      { id: "kit.density", card: "appearance", order: 20, Component: () => <SettingRow title="Density" /> },
    ]} /></TestProviders>);
    const cards = screen.getAllByRole("region").map((card) => card.getAttribute("aria-label"));
    // Notify me when and New threads have no rows here, so they are left out.
    expect(cards).toEqual(["Appearance", "Threads", "Composer", "Window"]);
    const titles = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles("Appearance")).toEqual(["Theme", "Density", "Show costs"]);
    expect(titles("Threads")).toEqual(["Settle automatically", "Trace tabs"]);
    expect(within(screen.getByRole("radiogroup", { name: "Theme" })).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(titles("Composer")).toContain("Send with");
  });

  it("names the chord that cycles the transcript detail as it is bound, and none when it is not", () => {
    const help = () => screen.getByRole("button", { name: /^About Transcript detail/u }).getAttribute("data-tooltip") ?? "";
    const { rerender } = render(<TestProviders><GeneralPage themeHere={false} detailShortcut="Ctrl+Alt+T" /></TestProviders>);
    expect(help()).toContain("Ctrl+Alt+T cycles them for the thread on screen.");
    expect(help()).not.toContain("⇧");
    rerender(<TestProviders><GeneralPage themeHere={false} /></TestProviders>);
    expect(help()).toMatch(/timestamps\.$/u);
  });

  it("says Shift, not a Mac glyph, off macOS", () => {
    render(<TestProviders><GeneralPage themeHere={false} /></TestProviders>);
    // jsdom's navigator.platform is empty, so this is the Ctrl side.
    expect(screen.getByRole("button", { name: /^About Send with/u }).getAttribute("data-tooltip")).toBe("While a turn runs, the send key queues a follow-up and Ctrl+Return steers the turn (Ctrl+Shift+Return when Ctrl+Return sends).");
  });
});
