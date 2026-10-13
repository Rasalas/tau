// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";
import { SettingsPageSections } from "./page-sections";
import { SettingsScreen } from "./SettingsScreen";
import { SettingRow, SettingsSection } from "./settings-layout";

afterEach(cleanup);

const row = (title: string) => () => <SettingsSection title={title}><SettingRow id={`setting-${title.toLowerCase().replace(/\W+/gu, "-")}`} title={title} /></SettingsSection>;

/** An extension's page that draws what other extensions attach to it, and another that attaches. */
function registryWithSections() {
  const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
  registry.activate({
    id: "host.ext",
    name: "Host",
    activate(plugin) {
      plugin.registerSettingsPage({
        id: "host.page", label: "Host page", group: "tools",
        Component: ({ onNotify }) => <div className="settings-page"><SettingsSection title="Its own"><SettingRow title="Its own row" /></SettingsSection><SettingsPageSections page="host.page" onNotify={onNotify} /><SettingsPageSections page="host.page" advanced onNotify={onNotify} /></div>,
      });
    },
  });
  registry.activate({
    id: "guest.ext",
    name: "Guest",
    activate(plugin) {
      plugin.registerSettingsSection({ id: "guest.late", page: "host.page", order: 20, rows: [{ id: "setting-late-section", label: "Late section", keywords: ["tardy"] }], Component: row("Late section") });
      plugin.registerSettingsSection({ id: "guest.early", page: "host.page", order: 10, replaces: ["guest.old-page"], Component: row("Early section") });
      plugin.registerSettingsSection({ id: "guest.hidden", page: "host.page", advanced: true, rows: [{ id: "setting-folded-section", label: "Folded section" }], Component: row("Folded section") });
      plugin.registerSettingsSection({ id: "guest.carded", page: "host.page", card: "rail", Component: row("Carded section") });
    },
  });
  registry.activate({
    id: "lost.ext",
    name: "Lost",
    activate(plugin) {
      plugin.registerSettingsSection({ id: "lost.section", page: "no.such.page", replaces: ["lost.old-page"], rows: [{ id: "setting-lost-row", label: "Lost row" }], Component: row("Lost section") });
    },
  });
  return registry;
}

/** Extensions that attach to the pages core draws sections on. */
// Connections reads its list from the host first; its own tests draw it.
const CORE_PAGES = ["extensions", "inspector", "threads", "general", "runtimes"] as const;

function registryForCorePages() {
  const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
  registry.activate({
    id: "guest.core",
    name: "Guest",
    activate(plugin) {
      for (const page of CORE_PAGES) plugin.registerSettingsSection({ id: `guest.${page}`, page, rows: [{ id: `setting-on-${page}`, label: `On ${page}` }], Component: row(`Section on ${page}`) });
      plugin.registerSettingsSection({ id: "guest.folded", page: "extensions", advanced: true, Component: row("Folded on extensions") });
    },
  });
  return registry;
}

function renderScreen(page: string, from = registryWithSections) {
  const onSetPage = vi.fn();
  const registry = from();
  function Harness() {
    const [current, setCurrent] = useState(page);
    return <SettingsScreen page={current} registry={registry} onSetPage={(next) => { onSetPage(next); setCurrent(next); }} onClose={vi.fn()} onNotify={vi.fn()} />;
  }
  render(<TestProviders><Harness /></TestProviders>);
  return { onSetPage, registry, screen: screen.getByRole("dialog", { name: "Settings" }) };
}

describe("sections attached to a page of core", () => {
  for (const page of CORE_PAGES) {
    it(`are drawn on ${page}${page === "extensions" ? ", the folded ones under Advanced" : ""}`, async () => {
      const { screen: dialog } = renderScreen(page, registryForCorePages);
      expect(await within(dialog).findByRole("heading", { level: 2, name: `Section on ${page}` })).toBeTruthy();
      if (page !== "extensions") return;
      const fold = dialog.querySelector<HTMLDetailsElement>("details.settings-advanced")!;
      expect(within(fold).getByRole("heading", { level: 2, name: "Folded on extensions" })).toBeTruthy();
    });
  }
});

describe("sections attached to another extension's page", () => {
  it("are drawn in order after the page's own, the carded ones left to the page, and the advanced ones in a fold of their own", () => {
    const { screen: dialog } = renderScreen("host.page");
    const headings = within(dialog.querySelector<HTMLElement>(".settings-content")!).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Its own", "Early section", "Late section", "Folded section"]);
    expect(within(dialog).queryByText("Carded section")).toBeNull();
    const fold = dialog.querySelector<HTMLDetailsElement>("details.settings-advanced")!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole("heading", { level: 2, name: "Folded section" })).toBeTruthy();
  });

  it("make the page they took over open theirs, for an old link and an old anchor", async () => {
    const { onSetPage, screen: dialog } = renderScreen("guest.old-page#setting-late-section");
    await waitFor(() => expect(onSetPage).toHaveBeenLastCalledWith("host.page"));
    expect(within(dialog).getByRole("heading", { level: 1, name: "Host page" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-late-section"));
  });

  it("open the fold around a row they hold when a link names it", async () => {
    renderScreen("host.page#setting-folded-section");
    await waitFor(() => expect(document.querySelector<HTMLDetailsElement>("details.settings-advanced")!.open).toBe(true));
  });

  it("are found by the search on the page they joined", () => {
    const { onSetPage, screen: dialog } = renderScreen("general");
    const search = within(dialog).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "tardy" } });
    const result = within(dialog).getByRole("option", { name: /Late section/u });
    expect(result.textContent).toContain("Host page");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("host.page#setting-late-section");
  });

  it("are drawn on their own extension's page where the page they joined is not there, and found there", async () => {
    const { screen: dialog } = renderScreen("extensions/lost.ext");
    expect(await within(dialog).findByRole("heading", { level: 2, name: "Lost section" })).toBeTruthy();
    cleanup();
    const again = renderScreen("general");
    const search = within(again.screen).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "lost row" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(again.onSetPage).toHaveBeenCalledWith("extensions/lost.ext#setting-lost-row");
  });

  it("send the page they took over to their own extension's page where the page they joined is not there", async () => {
    const { onSetPage, screen: dialog } = renderScreen("lost.old-page");
    await waitFor(() => expect(onSetPage).toHaveBeenLastCalledWith("extensions/lost.ext"));
    expect(await within(dialog).findByRole("heading", { level: 2, name: "Lost section" })).toBeTruthy();
  });
});
