// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TauConfig } from "../../shared/contracts";
import { withSetting, withoutSetting } from "../../shared/config-layers";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { SettingsScreen } from "./SettingsScreen";

afterEach(cleanup);

const mac = /mac|iphone|ipad/iu.test(navigator.platform);
const snapshot = { cwd: "/work/app", workspaceId: "ws-app", projectLabel: "app", models: [], thinkingLevels: [] } as unknown as HostSnapshot;

/** A host whose two config files live in memory. */
function hostWithFiles() {
  const files: { host: TauConfig; project: TauConfig } = { host: {}, project: {} };
  const client = createFakeHostClient({
    getConfigLayers: async (workspaceId) => (workspaceId ? { host: files.host, project: files.project, projectPath: "/work/app" } : { host: files.host }),
    updateConfig: async (patch, scope) => {
      const level = scope === "project" ? "project" : "host";
      for (const [key, value] of Object.entries(patch)) files[level] = withSetting(files[level], key, value);
      return {};
    },
    clearConfig: async (keys, scope) => {
      const level = scope === "project" ? "project" : "host";
      files[level] = keys.reduce(withoutSetting, files[level]);
      return { host: files.host, project: files.project };
    },
  });
  return { files, client };
}

function renderScreen(options: { page?: string; client?: ReturnType<typeof hostWithFiles>["client"]; onClose?: () => void; extensions?: string[] } = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onSetPage = vi.fn();
  const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
  for (const name of options.extensions ?? []) registry.activate({ id: name.toLowerCase(), name, activate() {} });
  const view = render(<HostClientProvider client={options.client}>
    <TestProviders>
      <SettingsScreen page={options.page ?? "defaults"} snapshot={snapshot} registry={registry} projects={[{ path: "/work/other", workspaceId: "ws-other", name: "other", lastOpenedAt: 1 }]} onSetPage={onSetPage} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={onClose} onNotify={vi.fn()} />
    </TestProviders>
  </HostClientProvider>);
  return { ...view, onClose, onSetPage, page: screen.getByRole("dialog", { name: "Settings" }) };
}

describe("the Settings screen", () => {
  it("takes the whole window: a section column, a breadcrumb with the page, and a way back", () => {
    const { page, onClose } = renderScreen();
    expect(page.getAttribute("aria-modal")).toBe("true");
    expect(within(page).getByRole("navigation", { name: "Settings breadcrumb" }).textContent).toContain("Defaults");
    expect(within(page).getByRole("heading", { level: 1, name: "Defaults" })).toBeTruthy();
    fireEvent.click(within(page).getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back on Escape and on the chord that opened it, but clears a search first", () => {
    const { page, onClose } = renderScreen();
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "costs" } });
    fireEvent.keyDown(search, { key: "Escape", bubbles: true, cancelable: true });
    expect((search as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape", bubbles: true, cancelable: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    const chord = new KeyboardEvent("keydown", { key: ",", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    window.dispatchEvent(chord);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(chord.defaultPrevented).toBe(true);
  });

  it("walks the results with the arrow keys and opens one on Enter; / focuses the search", () => {
    const { page, onSetPage } = renderScreen();
    fireEvent.keyDown(window, { key: "/", bubbles: true, cancelable: true });
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "theme" } });
    const results = within(page).getAllByRole("option");
    expect(results[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("defaults");
  });

  it("scrolls to the row a search result names", async () => {
    const { page } = renderScreen();
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "show costs" } });
    fireEvent.click(within(page).getByRole("option", { name: /Show costs/u }));
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-show-costs"));
  });

  it("writes to this machine, overrides for a project from the breadcrumb and shows where a value comes from", async () => {
    const { files, client } = hostWithFiles();
    const { page } = renderScreen({ client });
    const scope = await within(page).findByRole("button", { name: /Settings apply to this machine/u });

    fireEvent.click(within(page).getByRole("switch", { name: "Show costs" }));
    await waitFor(() => expect(files.host).toEqual({ showCosts: false }));

    fireEvent.click(scope);
    fireEvent.click(within(page).getByRole("menuitem", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    const costs = await within(page).findByRole("button", { name: /Inherited from this machine/u });
    expect(costs).toBeTruthy();

    fireEvent.click(within(page).getByRole("switch", { name: "Show costs" }));
    await waitFor(() => expect(files.project).toEqual({ showCosts: true }));
    const overridden = await within(page).findByRole("button", { name: /Overridden for app/u });
    fireEvent.click(overridden);
    const origin = within(page).getByRole("dialog", { name: "Where this value comes from" });
    expect([...origin.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["ProjectOn", "This machineOff", "DefaultOn"]);
    fireEvent.click(within(origin).getByRole("button", { name: "Reset to inherited value" }));
    await waitFor(() => expect(files.project).toEqual({}));
  });

  it("keeps a machine-only row inert while a project is edited", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client });
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    fireEvent.click(within(page).getByRole("menuitem", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    const row = within(page).getByRole("switch", { name: "Keep the host running in the background" }).closest(".settings-row-control")!;
    expect(row.getAttribute("data-inert")).toBe("");
    expect(row.getAttribute("title")).toMatch(/setting of this machine/u);
  });

  it("turns watching Tau's files off and back to the default", async () => {
    const { files, client } = hostWithFiles();
    const { page } = renderScreen({ client });
    const watch = await within(page).findByRole("switch", { name: "Reload files when they change" });
    expect(watch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(watch);
    await waitFor(() => expect(files.host).toEqual({ extensions: { watch: false } }));
    fireEvent.click(within(watch.closest(".settings-row")! as HTMLElement).getByRole("button", { name: /Reset Reload files when they change/u }));
    await waitFor(() => expect(files.host).toEqual({}));
  });

  it("writes the update track to this machine, and hides it for a host elsewhere", async () => {
    const { files, client } = hostWithFiles();
    const { page } = renderScreen({ client });
    const track = await within(page).findByRole("group", { name: "Update track" });
    fireEvent.click(within(track).getByRole("button", { name: "Nightly" }));
    await waitFor(() => expect(files.host).toEqual({ updates: { channel: "nightly" } }));
    expect(within(track).getByRole("button", { name: "Nightly" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();

    const remote = createFakeHostClient({ hasCapability: () => false });
    const { page: remotePage } = renderScreen({ client: remote as ReturnType<typeof hostWithFiles>["client"] });
    await act(async () => undefined);
    expect(within(remotePage).queryByRole("group", { name: "Update track" })).toBeNull();
  });

  it("offers the scope only on pages that have project rows", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client, page: "keybindings" });
    await act(async () => undefined);
    expect(within(page).queryByRole("button", { name: /Settings apply to/u })).toBeNull();
  });
});

describe("the extension lists in the section column", () => {
  it("start folded, open on a click, and open by themselves around the page on screen", () => {
    const { page } = renderScreen({ extensions: ["Alpha", "Beta"] });
    const toggle = within(page).getByRole("button", { name: /· 2$/u });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(page).queryByRole("button", { name: "Alpha" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(page).getByRole("button", { name: "Alpha" })).toBeTruthy();
    cleanup();

    const onBeta = renderScreen({ extensions: ["Alpha", "Beta"], page: "beta" });
    expect(within(onBeta.page).getByRole("button", { name: /· 2$/u }).getAttribute("aria-expanded")).toBe("true");
    expect(within(onBeta.page).getByRole("button", { name: "Beta" }).getAttribute("aria-current")).toBe("page");
  });
});
