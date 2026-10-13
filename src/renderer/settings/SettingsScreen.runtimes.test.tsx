// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TauConfig, UiModel, UiRuntimeCatalog } from "../../shared/contracts";
import { withoutSetting } from "../../shared/config-layers";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ProviderCardBadgeReport } from "./provider-card-state";
import { SettingsScreen } from "./SettingsScreen";

afterEach(cleanup);

const PERMISSIONS_ROW = "runtime-permissions";

const snapshot = {
  cwd: "/work/app",
  workspaceId: "ws-app",
  projectLabel: "app",
  models: [],
  thinkingLevels: [],
  defaultBackendKind: "pi",
  runtimeBackends: [
    { kind: "pi", label: "Pi" },
    { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.48.2", latest: "0.49.0" } },
    { kind: "cursor", label: "Cursor Agent", version: { tool: "cursor-agent" } },
  ],
} as unknown as HostSnapshot;

const catalog = (kind: string, providers: string[], status?: UiRuntimeCatalog["status"]): UiRuntimeCatalog => ({
  kind,
  models: providers.map((provider, index) => ({ provider, id: `${kind}-${index}`, name: `${kind} ${index}` }) as UiModel),
  thinkingLevels: {},
  ...(status ? { status } : {}),
});

/** A host whose config files live in memory and whose catalogs answer; kits' calls are recorded: the page's buttons must make none. */
function setup(options: { page?: string; section?: boolean; stacked?: boolean; config?: TauConfig; host?: TauConfig } = {}) {
  const hostCalls: unknown[][] = [];
  const registry = new ExtensionRegistry({ invoke: async (...args: unknown[]) => { hostCalls.push(args); return undefined; } }, { preferences: new PreferencesStore() });
  registry.activate({
    id: "acme.runtimes",
    name: "Runtimes",
    activate(plugin) {
      plugin.registerSettingsPage({
        id: "codex.settings", label: "Codex", runtime: "codex", order: 1,
        runtimeRows: { program: "setting-codex-program", addInstance: "setting-codex-setup-add" },
        rows: [{ id: "setting-codex-program", label: "Codex CLI" }],
        Component: () => <><ProviderCardBadgeReport source="account" badge={{ label: "Needs sign-in", tone: "warn" }} /><ProviderCardBadgeReport source="program" badge={{ label: "Installed", tone: "success" }} /><p id="setting-codex-program" tabIndex={-1}>codex card</p></>,
      });
      plugin.registerSettingsPage({ id: "cursor.settings", label: "Cursor Agent", runtime: "cursor", order: 2, runtimeRows: { program: "setting-cursor-program" }, Component: () => <p>cursor card</p> });
      plugin.registerSettingsPage({ id: "plain.page", label: "Plain", order: 30, Component: () => <p>plain body</p> });
      if (options.section) {
        plugin.registerSettingsSection({ id: "acme.permissions", page: "runtimes", rows: [{ id: PERMISSIONS_ROW, label: "Before a runtime may…" }], Component: () => <section id={PERMISSIONS_ROW}>permission cards</section> });
      }
    },
  });
  const files: { host: TauConfig; project: TauConfig } = { host: options.host ?? {}, project: {} };
  const client = createFakeHostClient({
    runtimeCatalogs: async () => [catalog("pi", ["anthropic", "openai", "anthropic"]), catalog("codex", ["openai"]), catalog("cursor", [], "not-installed")],
    getConfig: async () => options.config ?? {},
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
  const preferences = new PreferencesStore();
  const onSetPage = vi.fn();
  const onNotify = vi.fn();
  // The page is the caller's state, as the workbench keeps it.
  function Harness() {
    const [page, setPage] = useState(options.page ?? "runtimes");
    return <SettingsScreen
      page={page} snapshot={snapshot} registry={registry}
      projects={[{ path: "/work/app", workspaceId: "ws-app", name: "app", lastOpenedAt: 1 }]}
      onSetPage={(next) => { onSetPage(next); setPage(next); }}
      onClose={vi.fn()} onNotify={onNotify}
      {...(options.stacked ? { stacked: true, view: "page" as const } : {})}
    />;
  }
  render(<HostClientProvider client={client}>
    <TestProviders preferences={preferences}>
      <Harness />
    </TestProviders>
  </HostClientProvider>);
  return { hostCalls, files, preferences, onSetPage, onNotify, page: screen.getByRole("dialog", { name: "Settings" }) };
}

const list = () => screen.getByRole("list", { name: "Runtimes" });
const item = (name: RegExp) => within(list()).getByRole("button", { name });

describe("Settings → Runtimes", () => {
  it("lists every runtime with its state, and shows the default one beside the list", async () => {
    const { page } = setup();
    const head = page.querySelector<HTMLElement>(".settings-page-head")!;
    expect(within(head).getByRole("heading", { level: 1, name: "Runtimes" })).toBeTruthy();
    expect(within(item(/^Pi/u)).getByText("Built in")).toBeTruthy();
    expect(item(/^Codex/u).textContent).toContain("0.48.2 → 0.49.0");
    expect(item(/^Codex/u).textContent).toContain("Update available");
    expect(await within(item(/Cursor Agent/u)).findByText("Not installed")).toBeTruthy();
    expect(within(item(/^Pi/u)).getByRole("img", { name: "New threads start here" })).toBeTruthy();
    expect(within(page).getByRole("region", { name: "Pi" })).toBeTruthy();
    expect(within(page).queryByRole("region", { name: "Codex" })).toBeNull();
  });

  it("opens a runtime from the list as runtimes/<kind>, under the same title, with its kit's rows and state", () => {
    const { page, onSetPage } = setup();
    fireEvent.click(item(/^Codex/u));
    expect(onSetPage).toHaveBeenLastCalledWith("runtimes/codex");
    const detail = within(page).getByRole("region", { name: "Codex" });
    expect(within(detail).getByText("codex card")).toBeTruthy();
    expect(within(detail).getByRole("heading", { level: 2, name: "Codex" })).toBeTruthy();
    expect([...detail.querySelectorAll(".runtime-badges .tau-badge")].map((badge) => badge.textContent)).toEqual(["Installed", "Needs sign-in"]);
    expect(within(page.querySelector<HTMLElement>(".settings-page-head")!).getByRole("heading", { level: 1, name: "Runtimes" })).toBeTruthy();
    expect(within(page).queryByRole("navigation", { name: "Settings breadcrumb" })).toBeNull();
    expect(within(page.querySelector<HTMLElement>(".settings-nav")!).getByRole("button", { name: "Runtimes" }).getAttribute("aria-current")).toBe("page");
  });

  it("makes a runtime the default for new threads on this client", () => {
    const { preferences, onNotify } = setup({ page: "runtimes/codex" });
    const detail = screen.getByRole("region", { name: "Codex" });
    fireEvent.click(within(detail).getByRole("button", { name: "Start new threads on Codex" }));
    expect(preferences.getSnapshot().newThreadRuntime).toBe("codex");
    expect(onNotify).toHaveBeenCalledWith("New threads start on Codex.");
    expect(within(detail).getByRole("button", { name: "New threads start on Codex" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(item(/^Codex/u)).getByRole("img", { name: "New threads start here" })).toBeTruthy();
  });

  it("scrolls to the program row on the kit's card for Update and Install, and runs nothing itself", async () => {
    const { hostCalls, onSetPage } = setup({ page: "runtimes/codex" });
    fireEvent.click(within(screen.getByRole("region", { name: "Codex" })).getByRole("button", { name: "Update Codex" }));
    expect(onSetPage).toHaveBeenCalledWith("runtimes/codex#setting-codex-program");
    cleanup();
    const second = setup({ page: "runtimes/cursor" });
    fireEvent.click(await within(screen.getByRole("region", { name: "Cursor Agent" })).findByRole("button", { name: "Install Cursor Agent" }));
    expect(second.onSetPage).toHaveBeenCalledWith("runtimes/cursor#setting-cursor-program");
    expect(hostCalls).toEqual([]);
    expect(second.hostCalls).toEqual([]);
  });

  it("adds an instance as another setup of a program whose card offers one", () => {
    const { onSetPage, hostCalls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([expect.stringContaining("Codex")]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Codex/u }));
    expect(onSetPage).toHaveBeenCalledWith("runtimes/codex#setting-codex-setup-add");
    expect(hostCalls).toEqual([]);
  });

  it("draws the kits' sections below the runtimes, and a link to the access row stays on the page", () => {
    const { onSetPage, page } = setup({ page: `runtimes#${PERMISSIONS_ROW}`, section: true });
    expect(within(page).getByText("permission cards")).toBeTruthy();
    expect(onSetPage).toHaveBeenCalledWith("runtimes");
  });

  it("finds the default runtime's row in the search, on Runtimes", () => {
    const { page, onSetPage } = setup({ page: "general" });
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "runtime for new threads" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("runtimes#setting-runtime-for-new-threads");
  });

  it("finds a kit card's rows and opens that runtime at the row", () => {
    const { page, onSetPage } = setup({ page: "general" });
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "codex cli" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("codex.settings#setting-codex-program");
    expect(onSetPage).toHaveBeenLastCalledWith("runtimes/codex");
  });
});

describe("links to the pages that became Runtimes", () => {
  it.each([
    ["codex.settings", "runtimes/codex"],
    ["providers", "runtimes"],
    ["providers#runtime-models-cursor", "runtimes/cursor"],
    ["pi", "runtimes/pi"],
    ["models", "runtimes/pi"],
  ])("opens %s as %s", (from, to) => {
    const { onSetPage } = setup({ page: from });
    expect(onSetPage).toHaveBeenLastCalledWith(to);
  });

  it("scrolls to the row a link names, on the runtime that holds it, and opens the fold around it", async () => {
    setup({ page: "models#setting-thinking-level", config: { models: { thinkingLevel: "high" } } });
    await waitFor(() => expect(document.getElementById("setting-default-thinking")).toBeTruthy());
    cleanup();

    setup({ page: "pi#setting-reserve-tokens", config: {} });
    await waitFor(() => expect(document.getElementById("setting-room-for-the-reply")).toBeTruthy());
    await waitFor(() => expect(document.querySelector<HTMLDetailsElement>("details.settings-advanced")!.open).toBe(true));
  });
});

describe("Settings → Runtimes: Pi", () => {
  it("holds Pi's default model and thinking, and folds the expert values under Advanced", async () => {
    const { page } = setup({ page: "runtimes/pi", config: { models: { default: "anthropic/claude-x", thinkingLevel: "medium" } } });
    const detail = within(page).getByRole("region", { name: "Pi" });
    expect(await within(detail).findByRole("heading", { level: 3, name: "Default model" })).toBeTruthy();
    expect(within(detail).getByRole("heading", { level: 3, name: "Default thinking" })).toBeTruthy();
    expect(within(detail).queryByRole("heading", { level: 3, name: "Startup model" })).toBeNull();
    const fold = detail.querySelector<HTMLDetailsElement>("details.settings-advanced")!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole("heading", { level: 3, name: "Room for the reply" })).toBeTruthy();
    expect(within(fold).getByRole("heading", { level: 3, name: "Retries" })).toBeTruthy();
    expect(within(fold).getByRole("heading", { level: 3, name: "First wait" })).toBeTruthy();
    expect(within(fold).getByRole("heading", { level: 3, name: "Temperature" })).toBeTruthy();
  });

  it("opens the fold for a search result inside it", async () => {
    const { page, onSetPage } = setup({ page: "general", config: {} });
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "reserve tokens" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("runtimes/pi#setting-room-for-the-reply");
    await waitFor(() => expect(document.querySelector<HTMLDetailsElement>("details.settings-advanced")!.open).toBe(true));
  });

  it("says another runtime's default is its own choice", () => {
    setup({ page: "runtimes/codex" });
    const detail = screen.getByRole("region", { name: "Codex" });
    expect(within(detail).getByRole("heading", { level: 3, name: "Default model" })).toBeTruthy();
    expect(within(detail).getByText("Runtime's choice")).toBeTruthy();
    expect(detail.querySelector("details.settings-advanced")).toBeNull();
  });
});

describe("Settings → Runtimes on a phone", () => {
  it("is the list alone, and a runtime opens under it with its name in the bar and a way back", () => {
    const { page, onSetPage } = setup({ stacked: true });
    expect(within(page).queryByRole("region", { name: "Pi" })).toBeNull();
    fireEvent.click(item(/^Codex/u));
    expect(onSetPage).toHaveBeenLastCalledWith("runtimes/codex");
    expect(screen.queryByRole("list", { name: "Runtimes" })).toBeNull();
    expect(within(page).getByRole("region", { name: "Codex" })).toBeTruthy();
    expect(within(page.querySelector<HTMLElement>(".settings-topbar")!).getByRole("heading", { level: 1, name: "Codex" })).toBeTruthy();
    fireEvent.click(within(page).getByRole("button", { name: "Back to Runtimes" }));
    expect(onSetPage).toHaveBeenLastCalledWith("runtimes");
    expect(screen.getByRole("list", { name: "Runtimes" })).toBeTruthy();
  });
});

describe("Settings → Runtimes: turning a runtime on or off", () => {
  it("gives each runtime a switch that is on until a level says otherwise, and writes the machine's level first", async () => {
    const { files, page } = setup({ page: "runtimes/cursor" });
    const cursor = await within(list()).findByRole("switch", { name: "Use Cursor Agent" });
    expect(cursor.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(cursor);
    await waitFor(() => expect(files.host).toEqual({ runtimeEnabled: { cursor: false } }));
    await waitFor(() => expect(within(list()).getByRole("switch", { name: "Use Cursor Agent" }).getAttribute("aria-checked")).toBe("false"));
    const detail = within(page).getByRole("region", { name: "Cursor Agent" });
    expect(detail.querySelector("[data-off]")).toBeTruthy();
    expect(within(detail).getByText("Off")).toBeTruthy();
    expect(within(list()).getByRole("switch", { name: "Use Codex" }).getAttribute("aria-checked")).toBe("true");
  });

  it("writes a project's own entry over the machine's, and resets it from the runtime's head", async () => {
    const { files, page } = setup({ page: "runtimes/codex", host: { runtimeEnabled: { cursor: false } } as TauConfig });
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    fireEvent.click(within(page).getByRole("menuitemradio", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    const cursor = await within(list()).findByRole("switch", { name: "Use Cursor Agent" });
    await waitFor(() => expect(cursor.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(cursor);
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { cursor: true } }));
    expect(files.host).toEqual({ runtimeEnabled: { cursor: false } });

    const detail = within(page).getByRole("region", { name: "Codex" });
    fireEvent.click(within(detail).getByRole("switch", { name: "Use Codex" }));
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { cursor: true, codex: false } }));
    expect(within(detail).getByText("Off for app")).toBeTruthy();

    fireEvent.click(within(detail).getByRole("button", { name: "Reset Codex to inherited value" }));
    await waitFor(() => expect(files.project).toEqual({ runtimeEnabled: { cursor: true } }));
  });
});
