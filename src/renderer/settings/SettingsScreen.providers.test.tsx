// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";
import { ProviderCardBadgeReport } from "./provider-card-state";
import { SettingsScreen } from "./SettingsScreen";

afterEach(cleanup);

function registryWithCards(): ExtensionRegistry {
  const registry = new ExtensionRegistry({ invoke: async () => undefined }, { preferences: new PreferencesStore() });
  registry.activate({
    id: "acme.runtimes",
    name: "Runtimes",
    activate(plugin) {
      plugin.registerSettingsPage({ id: "late.card", label: "Late", runtime: "antigravity", order: 27, Component: () => <p>late body</p> });
      plugin.registerSettingsPage({
        id: "early.card", label: "Early", runtime: "claude-code", order: 25,
        Component: () => <><ProviderCardBadgeReport source="account" badge={{ label: "Needs sign-in", tone: "warn" }} /><ProviderCardBadgeReport source="program" badge={{ label: "Installed", tone: "success" }} /><p>early body</p></>,
      });
      plugin.registerSettingsPage({ id: "plain.page", label: "Plain", order: 30, Component: () => <p>plain body</p> });
    },
  });
  return registry;
}

function renderScreen(page: string, onSetPage = vi.fn()) {
  render(<TestProviders>
    <SettingsScreen page={page} registry={registryWithCards()} onSetPage={onSetPage} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
  </TestProviders>);
  return onSetPage;
}

describe("Settings → Providers", () => {
  it("collects every page that names a runtime into one Providers page, a card each in order", () => {
    const onSetPage = renderScreen("defaults");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryByText("Early")).toBeNull();
    expect(within(nav).queryByText("Late")).toBeNull();
    expect(within(nav).getByText("Plain")).toBeTruthy();
    fireEvent.click(within(nav).getByText("Providers"));
    expect(onSetPage).toHaveBeenCalledWith("providers");
    cleanup();

    renderScreen("providers");
    const cards = screen.getAllByRole("region");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Early", "Late"]);
    expect(within(cards[0]!).getByText("early body")).toBeTruthy();
  });

  it("heads each card with the runtime's name and the state its rows report, the program's first", () => {
    renderScreen("providers");
    const [early, late] = screen.getAllByRole("region");
    expect(within(early!).getByRole("heading", { name: "Early" })).toBeTruthy();
    expect([...early!.querySelectorAll(".provider-card-badges .tau-badge")].map((badge) => badge.textContent)).toEqual(["Installed", "Needs sign-in"]);
    expect(late!.querySelectorAll(".provider-card-badges .tau-badge")).toHaveLength(0);
  });

  it("opens Providers for a card's own id, so an old link to the page still lands, scrolled to that card", () => {
    const scrolled: string[] = [];
    // jsdom has no scrolling of its own.
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
    try {
      renderScreen("late.card");
      expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
      expect(scrolled).toEqual(["provider-card-late.card"]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });
});
