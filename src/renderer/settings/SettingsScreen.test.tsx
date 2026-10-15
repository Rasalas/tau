// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { ExtensionInspection, HostSnapshot, TauConfig } from "../../shared/contracts";
import { withSetting, withoutSetting } from "../../shared/config-layers";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { SettingsScreen } from "./SettingsScreen";
import { AppPageContext } from "../app-page-context";
import { AppPageStore } from "../../workbench/app-page-store";
import { SettingsPageAction } from "./page-action";
import { SettingRow, Switch, useSetting } from "./settings-layout";
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

/** A row a project may override, as a kit adds to General's New threads card. */
function ProjectRule() {
  const rule = useSetting<boolean>("options.fixture.rule", { defaultValue: false, scope: "both", read: (raw) => (typeof raw === "boolean" ? raw : undefined) });
  return <SettingRow title="Project rule" setting={rule} control={<Switch label="Project rule" checked={rule.value} onChange={rule.set} />} />;
}

function registryWithProjectRule() {
  const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
  registry.activate({ id: "fixture.rules", name: "Rules", activate(context) {
    context.registerSettingsSection({ id: "fixture.rule", page: "general", Component: ProjectRule });
    context.registerSettingsSection({ id: "fixture.thread-rule", page: "general", card: "new-threads", Component: () => <SettingRow title="Thread rule" /> });
  } });
  return registry;
}

function renderScreen(options: { page?: string; client?: ReturnType<typeof hostWithFiles>["client"]; onClose?: () => void; extensions?: string[]; registry?: ExtensionRegistry; projects?: ComponentProps<typeof SettingsScreen>["projects"]; threads?: ComponentProps<typeof SettingsScreen>["threads"] } = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onSetPage = vi.fn();
  const registry = options.registry ?? registryWithProjectRule();
  for (const name of options.extensions ?? []) registry.activate({ id: name.toLowerCase(), name, activate() {} });
  // The page is the caller's state, as the workbench keeps it.
  function Harness() {
    const [page, setPage] = useState(options.page ?? "defaults");
    return <SettingsScreen page={page} snapshot={snapshot} registry={registry} projects={options.projects ?? [{ path: "/work/other", workspaceId: "ws-other", name: "other", lastOpenedAt: 1 }]} threads={options.threads ?? []} onSetPage={(next) => { onSetPage(next); setPage(next); }} onClose={onClose} onNotify={vi.fn()} />;
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
      <SettingsScreen page="general" snapshot={snapshot} registry={new ExtensionRegistry(undefined, { preferences: new PreferencesStore() })} onSetPage={vi.fn()} onClose={onClose} onNotify={vi.fn()} />
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
    fireEvent.change(search, { target: { value: "costs" } });
    const results = within(page).getAllByRole("option");
    expect(results[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("general#setting-show-costs");
  });

  it("focuses the search on the find chord, also from another field, but not while a chord is recorded", () => {
    const { page } = renderScreen();
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    const field = document.createElement("input");
    page.appendChild(field);
    field.focus();
    const find = (target: EventTarget, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key: "f", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };

    expect(find(field).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);

    field.focus();
    // The other platform's modifier, a shifted or alt chord and plain F leave the keyboard alone.
    for (const init of [{ metaKey: !mac, ctrlKey: mac }, { shiftKey: true }, { altKey: true }, { metaKey: false, ctrlKey: false }]) {
      expect(find(field, init).defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(field);

    field.setAttribute(KEYBINDING_CAPTURE_ATTRIBUTE, "");
    expect(find(field).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
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

    fireEvent.click(within(page).getByRole("switch", { name: "Project rule" }));
    await waitFor(() => expect(files.host).toEqual({ options: { "fixture.rule": true } }));

    fireEvent.click(scope);
    fireEvent.click(within(page).getByRole("menuitemradio", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    const rule = await within(page).findByRole("button", { name: /Inherited from this machine/u });
    expect(rule).toBeTruthy();

    fireEvent.click(within(page).getByRole("switch", { name: "Project rule" }));
    await waitFor(() => expect(files.project).toEqual({ options: { "fixture.rule": false } }));
    const overridden = await within(page).findByRole("button", { name: /Overridden for app/u });
    fireEvent.click(overridden);
    const origin = within(page).getByRole("dialog", { name: "Where this value comes from" });
    expect([...origin.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["ProjectOff", "This machineOn", "DefaultOff"]);
    fireEvent.click(within(origin).getByRole("button", { name: "Reset to inherited value" }));
    await waitFor(() => expect(files.project).toEqual({}));
  });

  it("keeps machine-wide rows in sight but inert, with the reason, while a project is edited", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client });
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    fireEvent.click(within(page).getByRole("menuitemradio", { name: /app/u }));
    await within(page).findByRole("button", { name: /Settings apply to app/u });
    for (const name of ["Reload files when they change", "Ask before quitting while threads work"]) {
      const row = within(page).getByRole("switch", { name }).closest(".settings-row")!;
      expect(row.querySelector(".settings-row-control")!.getAttribute("data-inert")).toBe("");
      expect(row.querySelector(".settings-row-control")!.getAttribute("data-tooltip")).toBe("Applies to the whole machine.");
      expect(row.querySelector(".settings-row-lock")!.textContent).toBe("Applies to the whole machine.");
    }
    // Rows that are no setting of Tau's config lock the same way; the project row stays live.
    expect(within(page).getByRole("combobox", { name: "Send with" }).closest(".settings-row-control")!.hasAttribute("data-inert")).toBe(true);
    expect(within(page).getByRole("switch", { name: "Project rule" }).closest(".settings-row-control")!.hasAttribute("data-inert")).toBe(false);
  });

  it("offers a project only where a row can hold one", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client, registry: new ExtensionRegistry(undefined, { preferences: new PreferencesStore() }) });
    await act(async () => undefined);
    // General's own rows are all machine-wide or personal: nothing to choose.
    expect(within(page).queryByRole("button", { name: /Settings apply to/u })).toBeNull();
  });

  it("lists each project of this machine once, without the root or another machine's projects, and tells equal names apart", async () => {
    const { client } = hostWithFiles();
    const project = (path: string, workspaceId: string, name = path.split("/").at(-1)!) => ({ path, workspaceId, name, lastOpenedAt: 1 });
    const { page } = renderScreen({
      client,
      projects: [
        project("/", "ws-root"),
        project("/Users/me/code/git-nrw", "ws-a"),
        project("/Users/me/code/git-nrw", "ws-a-again"),
        project("/Users/me/old/git-nrw", "ws-b"),
        project("/home/rex/git-nrw", "ws-rex", "git-nrw"),
        project("/Users/me/tau", "ws-tau"),
      ],
      threads: [{ id: "t1", path: "/s/t1", title: "On rex", modifiedAt: 1, projectPath: "/home/rex/git-nrw", workspaceId: "ws-rex", projectName: "git-nrw", messageCount: 1, backendKind: "machine", machine: { id: "rex", name: "rex" } }],
    });
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    const entries = within(page).getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(entries).toEqual([
      expect.stringContaining("This machine"),
      expect.stringMatching(/^app/u),
      expect.stringMatching(/^git-nrw~\/code$/u),
      expect.stringMatching(/^git-nrw~\/old$/u),
      expect.stringMatching(/^tau$/u),
    ]);
  });

  it("offers each other machine, and edits its own settings there instead of this machine's", async () => {
    const { files, client } = hostWithFiles();
    const rex: { host: TauConfig } = { host: { extensions: { watch: true } } };
    const calls: unknown[][] = [];
    const reaching = createFakeHostClient({
      ...Object.fromEntries(Object.entries(client).filter(([, value]) => typeof value === "function")),
      listEnvironments: async () => ({ shown: "mac", secureStorage: true, environments: [
        { id: "mac", name: "mac", local: true, status: "connected", threads: [], threadCount: 0, projects: [] },
        { id: "rex", name: "rex", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
        { id: "nas", name: "nas", local: false, status: "offline", threads: [], threadCount: 0, projects: [] },
        { id: "lab", name: "lab", local: false, status: "connected", readOnly: true, threads: [], threadCount: 0, projects: [] },
      ] }),
      getEnvironmentConfig: async () => ({ host: rex.host }),
      updateEnvironmentConfig: async (machine: string, patch: TauConfig) => { calls.push(["update", machine, patch]); rex.host = { ...rex.host, ...patch }; return {}; },
      clearEnvironmentConfig: async (machine: string, keys: string[]) => { calls.push(["clear", machine, keys]); rex.host = keys.reduce(withoutSetting, rex.host); return {}; },
    });
    const { page } = renderScreen({ client: reaching as ReturnType<typeof hostWithFiles>["client"] });
    fireEvent.click(await within(page).findByRole("button", { name: /Settings apply to this machine/u }));
    const items = await within(page).findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^This machine/u), "rex", "nasNot reachable", "labRead only", expect.stringMatching(/^app/u), "other",
    ]);
    expect(within(page).getByRole("menuitemradio", { name: /nas/u }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(within(page).getByRole("menuitemradio", { name: /rex/u }));
    await within(page).findByRole("button", { name: /Settings apply to rex/u });
    const watching = await within(page).findByRole("switch", { name: "Reload files when they change" });
    await waitFor(() => expect(watching.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(watching);
    await waitFor(() => expect(calls).toEqual([["update", "rex", { extensions: { watch: false } }]]));
    expect(files.host).toEqual({});
    // Personal looks apply on every machine, so they are not offered a second time; a device's own choice is not rex's.
    const costs = within(page).getByRole("switch", { name: "Show costs" }).closest(".settings-row")!;
    expect(costs.querySelector(".settings-row-lock")!.textContent).toBe("Personal: applies on every machine.");
    expect(within(page).getByRole("combobox", { name: "Send with" }).closest(".settings-row-control")!.hasAttribute("data-inert")).toBe(true);
    // Projects belong to this machine.
    expect(within(page).queryByRole("switch", { name: "Project rule" })).toBeTruthy();
    expect(within(page).getByRole("switch", { name: "Project rule" }).closest(".settings-row-control")!.hasAttribute("data-inert")).toBe(false);

    fireEvent.click(within(page).getByRole("button", { name: /Settings apply to rex/u }));
    fireEvent.click(within(page).getByRole("menuitemradio", { name: /lab/u }));
    await within(page).findByRole("button", { name: /Settings apply to lab/u });
    const locked = within(page).getByRole("switch", { name: "Reload files when they change" }).closest(".settings-row-control")!;
    expect(locked.getAttribute("data-tooltip")).toMatch(/lab paired this window Read only/u);
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

  it("turns Pi's default model inert with the reason on a device paired Read only", async () => {
    const readOnly = createFakeHostClient({ isReadOnly: () => true });
    const { page } = renderScreen({ client: readOnly as ReturnType<typeof hostWithFiles>["client"], page: "models" });
    const model = (await within(page).findByRole("textbox", { name: "Default model" })).closest(".settings-row-control");
    expect(model?.hasAttribute("data-inert")).toBe(true);
    expect(model?.getAttribute("data-tooltip")).toMatch(/^Read only/u);
  });

  it("draws the rows kits add to New threads on Threads, and Tau's own beside them", async () => {
    const { page } = renderScreen({ page: "threads" });
    const cards = within(page).getAllByRole("region").map((card) => card.getAttribute("aria-label"));
    expect(cards).toEqual(["New threads", "While a thread runs"]);
    expect(within(within(page).getByRole("region", { name: "New threads" })).getByRole("heading", { level: 3, name: "Thread rule" })).toBeTruthy();
    expect(within(within(page).getByRole("region", { name: "While a thread runs" })).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Continue threads after restarts", "Wakes during a turn"]);
    expect(within(page).queryByRole("switch", { name: "Project rule" })).toBeNull();
    await act(async () => undefined);
  });

  it("offers the scope only on pages that have project rows", async () => {
    const { client } = hostWithFiles();
    const { page } = renderScreen({ client, page: "keybindings" });
    await act(async () => undefined);
    expect(within(page).queryByRole("button", { name: /Settings apply to/u })).toBeNull();
  });
});

describe("the section column", () => {
  const withPages = () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    registry.activate({ id: "fixture.pages", name: "Pages", activate(context) {
      context.registerSettingsPage({ id: "look", label: "Look", group: "general", order: 5, Component: () => null });
      context.registerSettingsPage({ id: "shell", label: "Shell", group: "projects", Component: () => null });
      context.registerSettingsPage({ id: "loose", label: "Loose", Component: () => null });
    } });
    return registry;
  };

  it("groups core's pages with the ones kits add, each where its group says", () => {
    const { page } = renderScreen({ registry: withPages() });
    const groups = within(within(page).getByRole("navigation", { name: "Settings sections" })).getAllByRole("group");
    const listed = () => groups.map((group) => [group.getAttribute("aria-label"), within(group).getAllByRole("button").map((button) => button.textContent)]);
    // App and Agents are open; the rest folded under their headings, nothing lost. A page without a group follows App's own.
    expect(listed()).toEqual([
      ["App", ["General", "Look", "Keybindings", "Extensions", "Loose"]],
      ["Agents", ["Runtimes", "Threads"]],
      ["Projects", ["Projects"]],
      ["Machines", ["Machines"]],
    ]);
    for (const heading of ["Projects", "Machines"]) fireEvent.click(within(page).getByRole("button", { name: heading }));
    expect(listed()).toEqual([
      ["App", ["General", "Look", "Keybindings", "Extensions", "Loose"]],
      ["Agents", ["Runtimes", "Threads"]],
      ["Projects", ["Projects", "Shell"]],
      ["Machines", ["Machines", "Connections"]],
    ]);
    fireEvent.click(within(page).getByRole("button", { name: "Projects" }));
    expect(within(page).queryByRole("button", { name: "Shell" })).toBeNull();
  });

  it("stands Diagnostics at the foot, above About Tau, and no longer lists Models, Providers or Pi", () => {
    const { page } = renderScreen({ page: "inspector" });
    const foot = page.querySelector<HTMLElement>(".settings-nav-footer")!;
    expect(within(foot).getByRole("button", { name: /^Diagnostics/u }).getAttribute("aria-current")).toBe("page");
    expect(within(foot).getByRole("button", { name: /^About Tau/u })).toBeTruthy();
    const nav = within(page).getByRole("navigation", { name: "Settings sections" });
    for (const gone of ["Models", "Providers", "Pi", "Inspector"]) expect(within(nav).queryByRole("button", { name: gone })).toBeNull();
    expect(within(page).getByRole("heading", { level: 1, name: "Diagnostics" })).toBeTruthy();
  });

  it("opens the folded group that holds the page on screen", () => {
    const { page } = renderScreen({ page: "shell", registry: withPages() });
    const projects = within(page).getByRole("group", { name: "Projects" });
    expect(within(projects).getByRole("button", { name: "Projects" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(projects).getByRole("button", { name: "Shell" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens Settings with the groups folded as they were left", () => {
    const first = renderScreen();
    const machines = () => within(within(document.body).getByRole("group", { name: "Machines" })).getByRole("button", { name: "Machines" });
    // Folds live as long as the window, so an earlier test may have left this one either way.
    const was = machines().getAttribute("aria-expanded");
    fireEvent.click(within(first.page).getByRole("button", { name: "Machines" }));
    cleanup();
    renderScreen();
    expect(machines().getAttribute("aria-expanded")).toBe(was === "true" ? "false" : "true");
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
    expect(within(within(onBeta.page).getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Extensions" }).getAttribute("aria-current")).toBe("page");
    expect(page).toBeTruthy();
  });

  it("opens a row that left General on the page that holds it now", async () => {
    renderScreen({ page: "general#setting-continue-threads-after-restarts" });
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-continue-threads-after-restarts"));
    expect(screen.getByRole("heading", { level: 1, name: "Threads" })).toBeTruthy();
  });
});

describe("the page head", () => {
  const pages = () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    registry.activate({ id: "fixture.pages", name: "Pages", activate(context) {
      context.registerSettingsPage({
        id: "look", label: "Look", description: "How the zebra stripes are drawn.", group: "general", scope: "both",
        Component: () => <div className="settings-page"><SettingsPageAction><button type="button">Add stripes</button></SettingsPageAction><ProjectRule /></div>,
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
    expect(within(page.querySelector<HTMLElement>(".settings-page")!).getByRole("switch", { name: "Project rule" })).toBeTruthy();
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
      <SettingsScreen page="extensions" stacked view="page" registry={new ExtensionRegistry(undefined, { preferences: new PreferencesStore() })} onSetPage={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
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
  it.each([false, true])("opens an anchored updates link from the section list with controlled view %s", async (controlled) => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    const onSetPage = vi.fn();
    function Harness() {
      const [page, setPage] = useState("about");
      const [view, setView] = useState<"sections" | "page">("sections");
      return <>
        <button type="button" onClick={() => setPage("about#setting-check-for-updates")}>Open updates</button>
        <SettingsScreen
          page={page}
          stacked
          {...(controlled ? { view, onViewChange: setView } : {})}
          registry={registry}
          onSetPage={(next) => { onSetPage(next); setPage(next); }}
          onClose={vi.fn()}
          onNotify={vi.fn()}
        />
      </>;
    }
    render(<HostClientProvider client={undefined}><TestProviders><Harness /></TestProviders></HostClientProvider>);
    const settings = screen.getByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(settings.getAttribute("data-view")).toBe("sections"));
    fireEvent.click(screen.getByRole("button", { name: "Open updates" }));
    await waitFor(() => expect(settings.getAttribute("data-view")).toBe("page"));
    await waitFor(() => expect(onSetPage).toHaveBeenCalledWith("about"));
    expect(settings.querySelector(".settings-content")?.getAttribute("data-page")).toBe("about");
    expect(settings.querySelector("#setting-check-for-updates")).toBeTruthy();
  });

  it("lists the sections as cards with their values, leaves the keys out, and says where keys live", async () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile: "compact" });
    await registry.activate({ id: "test.machines", name: "Machines", activate(context) {
      context.registerSettingsPage({ id: "test.machines", label: "Machines", group: "general", order: -1, profiles: ["compact"], useSummary: () => "2 online", Component: () => null });
    } });
    const phoneSnapshot = { ...snapshot, runtimeBackends: [{ kind: "pi", label: "Pi" }] } as unknown as HostSnapshot;
    render(<HostClientProvider client={undefined}><TestProviders>
      <SettingsScreen page="general" stacked view="sections" snapshot={phoneSnapshot} registry={registry} nav={<nav aria-label="Main" />} onSetPage={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
    </TestProviders></HostClientProvider>);
    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    const machines = within(sections).getAllByRole("button", { name: /^Machines/u }).find((button) => button.querySelector(".settings-nav-value"));
    expect(machines?.querySelector(".settings-nav-value")?.textContent).toBe("2 online");
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
    expect(await within(page).findByText(/loads compiled code into Tau.s own process/u)).toBeTruthy();
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
