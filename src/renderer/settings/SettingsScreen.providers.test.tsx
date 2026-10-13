// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TauConfig } from "../../shared/contracts";
import { withoutSetting } from "../../shared/config-layers";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
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
      plugin.registerSettingsPage({
        id: "late.card", label: "Late", runtime: "antigravity", order: 27,
        Component: () => <><ProviderCardBadgeReport source="account" badge={{ label: "Needs sign-in", tone: "warn" }} /><ProviderCardBadgeReport source="program" badge={{ label: "Installed", tone: "success" }} /><p>late body</p></>,
      });
      plugin.registerSettingsPage({ id: "early.card", label: "Early", runtime: "claude-code", order: 25, rows: [{ id: "setting-early-path", label: "Early program path" }], Component: () => <p id="setting-early-path" tabIndex={-1}>early body</p> });
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
    fireEvent.click(within(nav).getByRole("button", { name: "Extensions" }));
    expect(within(nav).getByText("Plain")).toBeTruthy();
    fireEvent.click(within(nav).getByText("Providers"));
    expect(onSetPage).toHaveBeenCalledWith("providers");
    cleanup();

    renderScreen("providers");
    const cards = screen.getAllByRole("region");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Early", "Late"]);
    expect(within(cards[0]!).getByText("early body")).toBeTruthy();
  });

  it("finds a card's rows in the Settings search and opens Providers at the row", () => {
    const onSetPage = renderScreen("general");
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "early program path" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("early.card#setting-early-path");
  });

  it("heads each card with the runtime's name and the state its rows report, the program's first", () => {
    renderScreen("providers");
    const [early, late] = screen.getAllByRole("region");
    expect(within(late!).getByRole("heading", { name: "Late" })).toBeTruthy();
    expect([...late!.querySelectorAll(".provider-card-badges .tau-badge")].map((badge) => badge.textContent)).toEqual(["Installed", "Needs sign-in"]);
    expect(early!.querySelectorAll(".provider-card-badges .tau-badge")).toHaveLength(0);
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

describe("Settings → Providers: turning a runtime on or off", () => {
  const snapshot = { cwd: "/work/app", workspaceId: "ws-app", projectLabel: "app", models: [], thinkingLevels: [], runtimeBackends: [{ kind: "claude-code", label: "Early" }, { kind: "antigravity", label: "Late" }] } as unknown as HostSnapshot;

  function renderWithFiles(files: { host: TauConfig; project: TauConfig }) {
    const client = createFakeHostClient({
      getConfigLayers: async (workspaceId) => (workspaceId ? { host: files.host, project: files.project, projectPath: "/work/app" } : { host: files.host }),
      updateConfig: async (patch, scope) => {
        const level = scope === "project" ? "project" : "host";
        // The host merges a record entry by entry.
        for (const [key, value] of Object.entries(patch)) files[level] = { ...files[level], [key]: { ...(files[level] as Record<string, object>)[key], ...value as object } };
        return {};
      },
      clearConfig: async (keys, scope) => {
        const level = scope === "project" ? "project" : "host";
        files[level] = keys.reduce(withoutSetting, files[level]);
        return { host: files.host, project: files.project };
      },
    });
    render(<HostClientProvider client={client}><TestProviders>
      <SettingsScreen page="providers" snapshot={snapshot} registry={registryWithCards()} projects={[{ path: "/work/app", workspaceId: "ws-app", name: "app", lastOpenedAt: 1 }]} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
    </TestProviders></HostClientProvider>);
    return screen.getByRole("dialog", { name: "Settings" });
  }

  it("gives each card a switch that is on until a level says otherwise, and writes the machine's level first", async () => {
    const files = { host: {} as TauConfig, project: {} as TauConfig };
    const page = renderWithFiles(files);
    const early = await within(page).findByRole("switch", { name: "Use Early" });
    expect(early.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(early);
    await waitFor(() => expect(files.host).toEqual({ runtimeEnabled: { "claude-code": false } }));
    await waitFor(() => expect(within(page).getByRole("switch", { name: "Use Early" }).getAttribute("aria-checked")).toBe("false"));
    const card = within(page).getByRole("region", { name: "Early" });
    expect(card.getAttribute("data-off")).toBe("");
    expect(within(card).getByText("Off")).toBeTruthy();
    expect(within(page).getByRole("switch", { name: "Use Late" }).getAttribute("aria-checked")).toBe("true");
  });

  it("writes a project's own entry over the machine's, in either direction, and resets it", async () => {
    const files = { host: { runtimeEnabled: { "claude-code": false } } as TauConfig, project: {} as TauConfig };
    const page = renderWithFiles(files);
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    fireEvent.click(within(page).getByRole("menuitemradio", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    const early = await within(page).findByRole("switch", { name: "Use Early" });
    await waitFor(() => expect(early.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(early);
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { "claude-code": true } }));
    expect(files.host).toEqual({ runtimeEnabled: { "claude-code": false } });
    await waitFor(() => expect(within(page).getByRole("switch", { name: "Use Early" }).getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(within(page).getByRole("switch", { name: "Use Late" }));
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { "claude-code": true, antigravity: false } }));
    const late = within(page).getByRole("region", { name: "Late" });
    expect(within(late).getByText("Off for app")).toBeTruthy();

    fireEvent.click(within(late).getByRole("button", { name: "Reset Late to inherited value" }));
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { "claude-code": true } }));
    await waitFor(() => expect(within(page).getByRole("switch", { name: "Use Late" }).getAttribute("aria-checked")).toBe("true"));
  });
});
