// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ExtensionInspection, HostSnapshot, TauConfig } from "../../shared/contracts";
import { withSetting, withoutSetting } from "../../shared/config-layers";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { SettingsScreen } from "./SettingsScreen";
import { AppPageContext } from "../app-page-context";
import { AppPageStore } from "../../workbench/app-page-store";
import { SettingsPageAction } from "./page-action";
import { CORE_PAGE_DESCRIPTIONS } from "./settings-nav";

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

function renderScreen(options: { page?: string; client?: ReturnType<typeof hostWithFiles>["client"]; onClose?: () => void; extensions?: string[]; registry?: ExtensionRegistry } = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onSetPage = vi.fn();
  const registry = options.registry ?? new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
  for (const name of options.extensions ?? []) registry.activate({ id: name.toLowerCase(), name, activate() {} });
  // The page is the caller's state, as the workbench keeps it.
  function Harness() {
    const [page, setPage] = useState(options.page ?? "defaults");
    return <SettingsScreen page={page} snapshot={snapshot} registry={registry} projects={[{ path: "/work/other", workspaceId: "ws-other", name: "other", lastOpenedAt: 1 }]} onSetPage={(next) => { onSetPage(next); setPage(next); }} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={onClose} onNotify={vi.fn()} />;
  }
  const view = render(<HostClientProvider client={options.client}>
    <TestProviders>
      <Harness />
    </TestProviders>
  </HostClientProvider>);
  return { ...view, onClose, onSetPage, registry, page: screen.getByRole("dialog", { name: "Settings" }) };
}

describe("the Settings screen", () => {
  it("takes the whole window: a section column, the page under its head, and a way back to the thread", () => {
    const { page, onClose } = renderScreen();
    expect(page.getAttribute("aria-modal")).toBe("true");
    // "defaults" is the older name of General. A page at the top has no breadcrumb.
    const head = page.querySelector<HTMLElement>(".settings-page-head")!;
    expect(within(head).getByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    // General is cards under its title alone (design 2i).
    expect(within(head).queryByText(CORE_PAGE_DESCRIPTIONS.general)).toBeNull();
    expect(within(page).queryByRole("navigation", { name: "Settings breadcrumb" })).toBeNull();
    // Above the search and under About: both go to the thread, past a page Settings was opened over.
    const backs = within(page).getAllByRole("button", { name: "Back to thread" });
    expect(backs).toHaveLength(2);
    for (const back of backs) fireEvent.click(back);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("goes back to the thread past the app page it was opened over, which Escape returns to", () => {
    const pages = new AppPageStore();
    pages.open("pull-requests");
    const onClose = vi.fn();
    render(<AppPageContext.Provider value={pages}><TestProviders>
      <SettingsScreen page="general" snapshot={snapshot} registry={new ExtensionRegistry(undefined, { preferences: new PreferencesStore() })} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={onClose} onNotify={vi.fn()} />
    </TestProviders></AppPageContext.Provider>);
    fireEvent.keyDown(window, { key: "Escape", bubbles: true, cancelable: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pages.getSnapshot()).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Back to thread" })[0]!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(pages.getSnapshot()).toBeUndefined();
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
    expect(onSetPage).toHaveBeenCalledWith("general#setting-theme");
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
    expect(row.getAttribute("data-tooltip")).toMatch(/setting of this machine/u);
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
    const { page } = renderScreen({ client, page: "about" });
    const track = await within(page).findByRole("switch", { name: "Pre-release builds" });
    fireEvent.click(track);
    await waitFor(() => expect(files.host).toEqual({ updates: { channel: "nightly" } }));
    expect(track.getAttribute("aria-checked")).toBe("true");
    cleanup();

    const remote = createFakeHostClient({ hasCapability: () => false });
    const { page: remotePage } = renderScreen({ client: remote as ReturnType<typeof hostWithFiles>["client"], page: "about" });
    await act(async () => undefined);
    expect(within(remotePage).queryByRole("switch", { name: "Pre-release builds" })).toBeNull();
  });

  it("turns the thread defaults inert with the reason on a device paired Read only", async () => {
    const readOnly = createFakeHostClient({ isReadOnly: () => true });
    const { page } = renderScreen({ client: readOnly as ReturnType<typeof hostWithFiles>["client"], page: "models" });
    await act(async () => undefined);
    const model = within(page).getByRole("button", { name: /No model selected/u }).closest(".settings-row-control");
    expect(model?.hasAttribute("data-inert")).toBe(true);
    expect(model?.getAttribute("data-tooltip")).toMatch(/^Read only/u);
    expect(within(page).getByText("This model does not think in levels").closest(".settings-row-control")?.hasAttribute("data-inert")).toBe(true);
  });

  it("offers the scope only on pages that have project rows", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client, page: "keybindings" });
    await act(async () => undefined);
    expect(within(page).queryByRole("button", { name: /Settings apply to/u })).toBeNull();
  });
});

describe("the section column", () => {
  it("groups core's pages with the ones kits add, each where its group says", () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    registry.activate({ id: "fixture.pages", name: "Pages", activate(context) {
      context.registerSettingsPage({ id: "look", label: "Look", group: "general", order: 5, Component: () => null });
      context.registerSettingsPage({ id: "shell", label: "Shell", group: "projects", Component: () => null });
      context.registerSettingsPage({ id: "loose", label: "Loose", Component: () => null });
    } });
    const { page } = renderScreen({ registry });
    const groups = within(within(page).getByRole("navigation", { name: "Settings sections" })).getAllByRole("group");
    const listed = () => groups.map((group) => [group.getAttribute("aria-label"), within(group).getAllByRole("button").map((button) => button.textContent)]);
    // The main pages open; the rest folded under their headings, nothing lost.
    expect(listed()).toEqual([
      ["Settings", ["General", "Look", "Models", "Runtimes", "Keybindings", "Connections"]],
      ["Threads", ["Threads"]],
      ["Projects", ["Projects"]],
      ["Extensions", ["Extensions"]],
      ["Diagnostics", ["Diagnostics"]],
    ]);
    for (const heading of ["Threads", "Projects", "Extensions", "Diagnostics"]) fireEvent.click(within(page).getByRole("button", { name: heading }));
    expect(listed()).toEqual([
      ["Settings", ["General", "Look", "Models", "Runtimes", "Keybindings", "Connections"]],
      ["Threads", ["Threads", "Pi"]],
      ["Projects", ["Projects", "Shell"]],
      ["Extensions", ["Extensions", "All extensions", "Loose"]],
      ["Diagnostics", ["Diagnostics", "Inspector"]],
    ]);
    fireEvent.click(within(page).getByRole("button", { name: "Threads" }));
    expect(within(page).queryByRole("button", { name: "Pi" })).toBeNull();
  });

  it("opens the folded group that holds the page on screen", () => {
    const { page } = renderScreen({ page: "inspector" });
    const diagnostics = within(page).getByRole("group", { name: "Diagnostics" });
    expect(within(diagnostics).getByRole("button", { name: "Diagnostics" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(diagnostics).getByRole("button", { name: "Inspector" }).getAttribute("aria-current")).toBe("page");
    expect(within(page).getByRole("button", { name: "Threads" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens Settings with the groups folded as they were left", () => {
    const first = renderScreen();
    const extensions = () => within(within(document.body).getByRole("group", { name: "Extensions" })).getByRole("button", { name: "Extensions" });
    // Folds live as long as the window, so an earlier test may have left this one either way.
    const was = extensions().getAttribute("aria-expanded");
    fireEvent.click(within(first.page).getByRole("button", { name: "Extensions" }));
    cleanup();
    renderScreen();
    expect(extensions().getAttribute("aria-expanded")).toBe(was === "true" ? "false" : "true");
  });

  it("opens a row a link names, and an extension's page by its older link", async () => {
    const { page } = renderScreen({ page: "general#setting-show-costs" });
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-show-costs"));
    cleanup();
    const onBeta = renderScreen({ extensions: ["Alpha", "Beta"], page: "beta" });
    expect(within(onBeta.page).getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
    const crumbs = within(onBeta.page).getByRole("navigation", { name: "Settings breadcrumb" });
    expect(within(crumbs).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Settings", "Extensions"]);
    fireEvent.click(within(crumbs).getByRole("button", { name: "Extensions" }));
    expect(onBeta.onSetPage).toHaveBeenLastCalledWith("extensions");
    expect(within(onBeta.page).getByRole("button", { name: "All extensions" }).getAttribute("aria-current")).toBe("page");
    expect(page).toBeTruthy();
  });
});

describe("the page head", () => {
  const pages = () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    registry.activate({ id: "fixture.pages", name: "Pages", activate(context) {
      context.registerSettingsPage({
        id: "look", label: "Look", description: "How the zebra stripes are drawn.", group: "general", scope: "both",
        Component: () => <div className="settings-page"><SettingsPageAction><button type="button">Add stripes</button></SettingsPageAction><p>Rows</p></div>,
      });
      context.registerSettingsPage({ id: "plain", label: "Plain", Component: () => <div className="settings-page"><h3>Plain</h3><p>Rows</p></div> });
    } });
    return registry;
  };

  it("gives a kit's page its title, its description, where it applies and its action at the right", async () => {
    const { page } = renderScreen({ registry: pages(), page: "look" });
    const head = page.querySelector<HTMLElement>(".settings-page-head")!;
    expect(within(head).getByRole("heading", { level: 1, name: "Look" })).toBeTruthy();
    expect(within(head).getByText("How the zebra stripes are drawn.")).toBeTruthy();
    expect(await within(head).findByRole("button", { name: /Settings apply to this machine/u })).toBeTruthy();
    // The page keeps its action's state; the head draws it.
    await waitFor(() => expect(within(head.querySelector<HTMLElement>(".settings-page-action")!).getByRole("button", { name: "Add stripes" })).toBeTruthy());
    expect(page.querySelector(".settings-page")!.textContent).toBe("Rows");
  });

  it("gives a page without a description its title alone", () => {
    const { page } = renderScreen({ registry: pages(), page: "plain" });
    const head = page.querySelector<HTMLElement>(".settings-page-head")!;
    expect(within(head).getByRole("heading", { level: 1, name: "Plain" })).toBeTruthy();
    expect(head.querySelector("p")).toBeNull();
  });

  it("finds a page by its description and shows the description under the result", () => {
    const { page } = renderScreen({ registry: pages() });
    fireEvent.change(within(page).getByRole("searchbox", { name: "Search settings" }), { target: { value: "zebra" } });
    const result = within(page).getByRole("option", { name: /Look/u });
    expect(result.textContent).toContain("How the zebra stripes are drawn.");
    fireEvent.change(within(page).getByRole("searchbox", { name: "Search settings" }), { target: { value: "licences software" } });
    expect(within(page).getByRole("option", { name: /About/u })).toBeTruthy();
  });

  it("puts the title in the bar on a phone, under a way back, and keeps the rest of the head on the page", () => {
    render(<HostClientProvider client={undefined}><TestProviders>
      <SettingsScreen page="extensions" stacked view="page" registry={new ExtensionRegistry(undefined, { preferences: new PreferencesStore() })} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
    </TestProviders></HostClientProvider>);
    const bar = document.querySelector<HTMLElement>(".settings-topbar")!;
    expect(within(bar).getByRole("heading", { level: 1, name: "Extensions" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "All settings" })).toBeTruthy();
    const head = document.querySelector<HTMLElement>(".settings-page-head")!;
    expect(within(head).queryByRole("heading")).toBeNull();
    expect(within(head).getByText(CORE_PAGE_DESCRIPTIONS.extensions)).toBeTruthy();
  });
});

describe("Settings on a phone (design 1s)", () => {
  it("lists the sections as cards with their values, leaves the keys out, and says where keys live", async () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile: "compact" });
    await registry.activate({ id: "test.machines", name: "Machines", activate(context) {
      context.registerSettingsPage({ id: "test.machines", label: "Machines", group: "general", order: -1, profiles: ["compact"], useSummary: () => "2 online", Component: () => null });
    } });
    const phoneSnapshot = { ...snapshot, runtimeBackends: [{ kind: "pi", label: "Pi" }] } as unknown as HostSnapshot;
    render(<HostClientProvider client={undefined}><TestProviders>
      <SettingsScreen page="general" stacked view="sections" snapshot={phoneSnapshot} registry={registry} nav={<nav aria-label="Main" />} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
    </TestProviders></HostClientProvider>);
    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(sections).getByRole("button", { name: /^Machines/u }).querySelector(".settings-nav-value")?.textContent).toBe("2 online");
    expect(within(sections).getByRole("button", { name: /^Runtimes/u }).textContent).toContain("Pi default");
    expect(within(sections).queryByRole("button", { name: /^Keybindings/u })).toBeNull();
    expect(within(sections).getByText(/Keys and sign-ins live on your machines/u)).toBeTruthy();
  });
});

const inspection = (overrides: Partial<ExtensionInspection>): ExtensionInspection => ({ versions: { tau: "0.7.6", pi: "1", api: "1.17.0" }, directories: [], packages: [], errors: [], skipped: [], ...overrides });

describe("Settings → Extensions", () => {
  it("lists every extension with what needs the user first, filters it and opens one", async () => {
    const client = createFakeHostClient({
      inspectExtensions: async () => inspection({
        packages: [
          { id: "alpha", name: "Alpha", version: "1.0.0", description: "Draws alpha things.", scope: "bundled", directory: "/kits/alpha", desktop: true, host: false, granted: true, permissions: [] },
          { id: "acme.waiting", name: "Waiting", scope: "global", directory: "/home/.tau/extensions/waiting", desktop: false, host: true, granted: false, permissions: ["network"] },
        ],
        errors: [{ path: "/home/.tau/extensions/old/tau-extension.json", message: "acme.old 2.0.0 needs extension API ^9.0.0, this Tau has 1.17.0", id: "acme.old", name: "Old", version: "2.0.0", incompatible: true }],
      }),
    });
    const { page } = renderScreen({ client: client as ReturnType<typeof hostWithFiles>["client"], extensions: ["Alpha", "Beta"], page: "extensions" });
    const attention = await within(page).findByRole("region", { name: "Needs attention" });
    expect(within(attention).getAllByRole("listitem").map((row) => row.querySelector("strong")?.textContent)).toEqual(["Old", "Waiting"]);
    expect(within(attention).getByText(/needs extension API/u)).toBeTruthy();
    const bundled = within(page).getByRole("region", { name: "Bundled with Tau" });
    expect(within(bundled).getByText("Draws alpha things.")).toBeTruthy();

    fireEvent.click(within(page).getByRole("radio", { name: /Turned off/u }));
    expect(within(page).getByText(/None in this list/u)).toBeTruthy();
    fireEvent.click(within(page).getByRole("radio", { name: /^All/u }));
    fireEvent.change(within(page).getByRole("searchbox", { name: "Filter extensions" }), { target: { value: "alpha" } });
    expect(page.querySelectorAll(".extension-row")).toHaveLength(1);

    fireEvent.click(within(page).getByRole("switch", { name: "Turn off Alpha" }));
    expect(within(page).getByRole("switch", { name: "Turn on Alpha" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(page).getByRole("button", { name: /Alpha/u }));
    // Its own head names it once, beside its mark, under the breadcrumb.
    expect(within(page).getAllByRole("heading", { name: "Alpha" })).toEqual([within(page).getByRole("heading", { level: 1, name: "Alpha" })]);
    expect(within(page).getByRole("navigation", { name: "Settings breadcrumb" })).toBeTruthy();
    expect(within(page).getByText("Bundled with Tau")).toBeTruthy();
  });

  it("asks for approval on a waiting package's page and says why an incompatible one does not run", async () => {
    const grantExtension = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      grantExtension,
      inspectExtensions: async () => inspection({
        packages: [{ id: "acme.waiting", name: "Waiting", scope: "global", directory: "/w", desktop: false, host: true, granted: false, permissions: ["network", "native"], isolation: "worker" }],
        errors: [{ path: "/o/tau-extension.json", message: "acme.old 2.0.0 needs extension API ^9.0.0, this Tau has 1.17.0", id: "acme.old", name: "Old", incompatible: true }],
      }),
    });
    const { page } = renderScreen({ client: client as ReturnType<typeof hostWithFiles>["client"], page: "extensions/acme.waiting" });
    // The approval and the permission list render on separate updates; wait for each.
    const allow = await within(page).findByRole("button", { name: "Allow and turn on" });
    expect(await within(page).findByText("Reach the network")).toBeTruthy();
    expect(await within(page).findByText(/loads compiled code into the host process/u)).toBeTruthy();
    fireEvent.click(allow);
    await waitFor(() => expect(grantExtension).toHaveBeenCalledWith("acme.waiting", true));
    cleanup();

    const old = renderScreen({ client: client as ReturnType<typeof hostWithFiles>["client"], page: "extensions/acme.old" });
    const problem = await within(old.page).findByRole("alert");
    expect(problem.textContent).toMatch(/does not run on this version of Tau/u);
    expect(problem.textContent).toMatch(/Update Tau/u);
    expect(within(old.page).queryByRole("switch")).toBeNull();
  });

  it("says so when an extension's page names nothing that is there", async () => {
    const { page } = renderScreen({ client: createFakeHostClient({}) as ReturnType<typeof hostWithFiles>["client"], page: "extensions/gone.away" });
    expect(await within(page).findByText("This extension is not here any more")).toBeTruthy();
    fireEvent.click(within(page.querySelector<HTMLElement>(".settings-content")!).getByRole("button", { name: "All extensions" }));
    expect(within(page).getByRole("heading", { level: 1, name: "Extensions" })).toBeTruthy();
  });
});
