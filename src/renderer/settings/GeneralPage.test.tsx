// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TestProviders } from "../test-support/test-providers";
import { GeneralPage } from "./GeneralPage";
import { SettingRow } from "./settings-layout";

afterEach(cleanup);

describe("Settings → General", () => {
  it("draws the composer and the transcript in cards, and a kit's rows in the cards they name", () => {
    render(<TestProviders><GeneralPage themeHere={false} sections={[
      { id: "kit.trace", card: "threads", order: 30, Component: () => <SettingRow title="Trace tabs" /> },
      { id: "kit.density", card: "appearance", order: 20, Component: () => <SettingRow title="Density" /> },
      { id: "kit.notify", card: "notify", order: 20, Component: () => <SettingRow title="A thread is done" /> },
      { id: "kit.loose", Component: () => <p>A section of its own</p> },
    ]} /></TestProviders>);
    const cards = screen.getAllByRole("region").map((card) => card.getAttribute("aria-label"));
    // The Threads card is drawn on Threads, and Quitting needs this machine's window.
    expect(cards).toEqual(["Appearance", "Notify me when", "Composer", "Transcript"]);
    const titles = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles("Appearance")).toEqual(["Density"]);
    expect(titles("Transcript")).toEqual(["Transcript detail", "Show costs"]);
    expect(titles("Composer")).toContain("Send with");
    expect(screen.queryByRole("heading", { level: 3, name: "Trace tabs" })).toBeNull();
    expect(screen.getByText("A section of its own")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
  });

  it("folds Reload files under Advanced and offers the theme only where Appearance is not there", () => {
    render(<TestProviders><GeneralPage themeHere /></TestProviders>);
    const fold = document.querySelector<HTMLDetailsElement>("details.settings-advanced")!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole("heading", { level: 3, name: "Reload files when they change" })).toBeTruthy();
    expect(within(screen.getByRole("radiogroup", { name: "Theme" })).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(within(screen.getByRole("region", { name: "Appearance" })).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Theme"]);
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
