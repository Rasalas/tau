// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Archive, Bot } from "lucide-react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient, type FakeHostClient } from "../renderer/test-support/fake-host-client";
import { createRendererServices } from "../renderer/renderer-services";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

/** A phone-sized viewport, which is what makes the layout compact. */
function setViewport(width: number, height = 844): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

const archived: string[] = [];
/** A kit that claims the compact client: a panel for the title bar's sheets, an action on any thread row. */
const probe: DesktopExtension = {
  id: "test.compact",
  name: "Compact probe",
  activate(plugin) {
    plugin.registerPanel({ id: "probe-agents", label: "Agents", Icon: Bot, profiles: ["desktop", "web", "compact"], Component: () => <p>agents panel body</p> });
    plugin.registerPanel({ id: "probe-files", label: "Files", profiles: ["desktop"], Component: () => <p>files panel body</p> });
    plugin.registerCommand({ id: "probe.archive", label: "Archive thread", group: "Thread", surfaces: ["thread-row"], Icon: Archive, run: (_actions, context) => { archived.push(context?.threadId ?? "none"); } });
  },
};

function thread(id: string, title: string, modifiedAt: number): UiSession {
  return { id, path: `/sessions/${id}.json`, title, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 2 };
}

const THREADS = [thread("t-a", "Rename the store", 30), thread("t-b", "Ship the web client", 20), thread("t-c", "Fix the flaky test", 10)];
/** The session a host opens at start: in the index, with nothing written in it yet. */
const BLANK: UiSession = { ...thread("t-new", "", 40), projectPath: "/", projectName: "/", messageCount: 0 };
type ProjectEntry = { path: string; name: string; lastOpenedAt: number };
const PROJECTS: ProjectEntry[] = [{ path: "/project", name: "project", lastOpenedAt: 1 }];

/** `t-a` open with a message in it; `home` puts the host on its blank session in `/`, as an app opened from the Finder did. */
function bootstrapWith(sessions: UiSession[], { home = false, projects = PROJECTS }: { home?: boolean; projects?: ProjectEntry[] } = {}) {
  const active = home ? BLANK.id : "t-a";
  return async () => ({
    version: 1 as const,
    threadIndex: { projects, sessions: home ? [...sessions, BLANK] : sessions },
    detail: { sessionId: active, messages: home ? [] : [{ id: "m1", role: "user" as const, text: "Rename it", timestamp: 1 }], isStreaming: false, activeTools: [] },
    catalog: { sessionId: active, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
    project: { cwd: home ? "/" : "/project" },
  });
}

function renderCompactClient(overrides: Parameters<typeof createFakeHostClient>[0] = {}, extensions: DesktopExtension[] = []): FakeHostClient {
  const client = createFakeHostClient({ bootstrap: bootstrapWith(THREADS), ...overrides });
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  render(<WebWorkbench
    client={client}
    storage={storage}
    services={createRendererServices(extensions)}
    environment={webClientEnvironment("compact")}
  />);
  return client;
}

/** A finger dragging a row from `from` to `to`, in client x. */
function swipe(target: Element, from: number, to: number): void {
  fireEvent.pointerDown(target, { pointerType: "touch", pointerId: 7, button: 0, clientX: from, clientY: 20 });
  for (const x of [from - 12, (from + to) / 2, to]) fireEvent.pointerMove(target, { pointerType: "touch", pointerId: 7, clientX: x, clientY: 22 });
  fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 7, clientX: to, clientY: 22 });
}

/** A phone that connects while no thread is open. */
function renderHome(extensions: DesktopExtension[] = [], projects = PROJECTS): FakeHostClient {
  return renderCompactClient({ bootstrap: bootstrapWith(THREADS, { home: true, projects }) }, extensions);
}

const rowNamed = (title: string) => screen.getByRole("button", { name: `Open thread ${title}` }).closest("li") as HTMLElement;

const running = (sessionId: string): HostEvent => ({ type: "agent-status", sessionId, running: true });

// The Workbench loads the Settings screen as a chunk of its own. Loaded here, outside the tests,
// its first import on a busy machine does not count against findByRole's wait.
beforeAll(async () => { await import("../renderer/settings/SettingsScreen"); });
beforeEach(() => { installPointerEvents(); setViewport(400); archived.length = 0; });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); window.history.replaceState(null, "", "/"); });

describe("the web client at 400 px", () => {
  it("lays itself out compactly and says which client it is", async () => {
    renderCompactClient();
    await waitFor(() => expect(document.body.dataset.profile).toBe("compact"));
    expect(document.body.dataset.client).toBe("compact");
  });

  it("follows the theme the user picks, from the stored one on, and hands the rest back to the system", async () => {
    const storage = createMemoryStorage();
    storage.set(STORAGE_KEYS.preferences, JSON.stringify({ theme: "light" }));
    setClientStorage(storage);
    const client = createFakeHostClient({ bootstrap: bootstrapWith(THREADS) });
    setHostClient(client);
    const services = createRendererServices();
    render(<WebWorkbench client={client} storage={storage} services={services} environment={webClientEnvironment("compact")} />);
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => services.preferences.setTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => services.preferences.setTheme("system"));
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("opens on the threads it is supervising, worst first", async () => {
    const client = renderHome();
    const list = await screen.findByRole("list", { name: "Threads" });
    client.emit(running("t-c"));
    client.emit({ type: "extension-ui-prompt", sessionId: "t-b", prompt: { id: "q1", sessionId: "t-b", kind: "confirm", title: "Delete the branch?" } });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0].textContent).toContain("Ship the web client"));
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.status)).toEqual(["waiting", "running", "done"]);
    expect(rows[0].textContent).toContain("Waiting");
    expect(within(rows[0]).getByRole("button", { name: "Open thread Ship the web client" }).getAttribute("aria-description")).toBe("Waiting for an answer");
    expect(rows[1].textContent).toContain("Fix the flaky test");
  });

  it("opens a thread with one tap", async () => {
    const client = renderHome();
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Open thread Rename the store" }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "switchSession")).toBe(true));
    expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-a.json");
  });

  it("stops a running thread without opening it", async () => {
    const client = renderHome();
    await screen.findByRole("list", { name: "Threads" });
    client.emit(running("t-b"));
    const stop = await screen.findByRole("button", { name: "Stop Ship the web client" });
    fireEvent.click(stop);
    await waitFor(() => expect(client.calls.some((call) => call.method === "abort")).toBe(true));
    expect(client.calls.find((call) => call.method === "abort")?.args[0]).toBe("t-b");
  });

  it("answers a Pi confirm on the thread that is open", async () => {
    const client = renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    client.emit({ type: "extension-ui-prompt", sessionId: "t-a", prompt: { id: "q7", sessionId: "t-a", kind: "confirm", title: "Run the migration?" } });
    await screen.findByText("Run the migration?");
    fireEvent.click(screen.getByRole("button", { name: /Yes/u }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "answerExtensionUi")).toBe(true));
    const answer = client.calls.find((call) => call.method === "answerExtensionUi");
    expect(answer?.args).toEqual(["q7", { confirmed: true }]);
  });

  it("sends a prompt from the composer at the bottom", async () => {
    const client = renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(true));
    expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toBe("ship it");
  });

  it("draws no workspace dock and no thread column: this client cannot", async () => {
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    expect(document.querySelector(".instrument-dock")).toBeNull();
    expect(document.querySelector(".session-rail")).toBeNull();
    // The list is reachable from the chrome once a thread is open, too.
    expect(screen.getByRole("button", { name: "Threads" })).toBeTruthy();
  });

  it("settles a thread with a full swipe and brings it back from the settled shelf", async () => {
    renderHome();
    await screen.findByRole("list", { name: "Threads" });
    swipe(rowNamed("Fix the flaky test").querySelector(".swipe-row")!, 380, 60);
    await waitFor(() => expect(rowNamed("Fix the flaky test").dataset.settled).toBe("true"));
    const shelf = screen.getByRole("list", { name: "Settled threads" });
    expect(within(shelf).getByText("Settled · 1")).toBeTruthy();
    // A short swipe only opens the tray; its primary action takes the thread back out.
    swipe(rowNamed("Fix the flaky test").querySelector(".swipe-row")!, 380, 330);
    fireEvent.click(within(rowNamed("Fix the flaky test")).getByRole("button", { name: /Un-settle/u }));
    await waitFor(() => expect(rowNamed("Fix the flaky test").dataset.settled).toBeUndefined());
  });

  it("lists every action on a long press, the kits' thread-row commands with the thread they name", async () => {
    renderHome([probe]);
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.contextMenu(rowNamed("Ship the web client").querySelector(".swipe-row")!);
    const sheet = await screen.findByRole("dialog", { name: "Ship the web client" });
    const labels = within(sheet).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(labels).toEqual(["Close", "Settle", "Pin", "Mark as unread", "Archive thread"]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Archive thread" }));
    await waitFor(() => expect(archived).toEqual(["t-b"]));
    expect(screen.queryByRole("dialog", { name: "Ship the web client" })).toBeNull();
  });

  it("puts a kit's glyph action in the swipe tray beside settle", async () => {
    renderHome([probe]);
    await screen.findByRole("list", { name: "Threads" });
    const row = rowNamed("Rename the store");
    const tray = row.querySelector(".swipe-tray") as HTMLElement;
    expect(within(tray).getAllByRole("button", { hidden: true }).map((button) => button.textContent)).toEqual(["Settle", "Archive"]);
    expect(tray.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens a panel that claims compact over the thread, and leaves the rest out", async () => {
    renderCompactClient({}, [probe]);
    await screen.findByRole("button", { name: "Threads" });
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    const sheet = await screen.findByRole("dialog", { name: "Agents" });
    expect(await within(sheet).findByText("agents panel body")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Agents" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agents" })).toBeNull());
  });

  it("opens and closes a sheet when a panel asks the workbench for a panel", async () => {
    const asking: DesktopExtension = {
      id: "test.asking",
      name: "Asking probe",
      activate(plugin) {
        plugin.registerPanel({ id: "probe-review", label: "Review", profiles: ["compact"], Component: ({ actions }) => <>
          <button type="button" onClick={() => actions.closePanel?.("probe-review")}>Done</button>
          <button type="button" onClick={() => actions.openPanel("probe-agents")}>Show agents</button>
        </> });
      },
    };
    renderCompactClient({}, [probe, asking]);
    await screen.findByRole("button", { name: "Threads" });
    // Two panels or more fold into the bar's More menu on a phone.
    const openFromMenu = async (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      fireEvent.click(within(await screen.findByRole("menu", { name: "Panels" })).getByRole("menuitemcheckbox", { name: label }));
    };
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    await openFromMenu("Review");
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Review" })).getByRole("button", { name: "Show agents" }));
    expect(await within(await screen.findByRole("dialog", { name: "Agents" })).findByText("agents panel body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(await screen.findByRole("menu", { name: "Panels" })).getByRole("menuitemcheckbox", { name: "Agents" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Review" }));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Panels" })).toBeNull());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Review" })).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review" })).toBeNull());
  });

  it("finds a thread from the search popover and starts a new one from the floating button", async () => {
    const client = renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const threads = await screen.findByRole("dialog", { name: "Threads" });
    fireEvent.click(within(threads).getByRole("button", { name: "Search threads" }));
    const field = await screen.findByRole("searchbox", { name: "Search threads" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.change(field, { target: { value: "nothing like it" } });
    expect(screen.getByRole("status").textContent).toContain("No thread matches");
    fireEvent.change(field, { target: { value: "flaky" } });
    fireEvent.click(within(screen.getByRole("list", { name: "Search results" })).getByRole("button", { name: /Fix the flaky test/u }));
    await waitFor(() => expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-c.json"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const again = await screen.findByRole("dialog", { name: "Threads" });
    expect(within(again).getAllByRole("button", { name: "New thread" })).toHaveLength(1);
    expect(within(again).getByRole("button", { name: "New thread" }).className).toBe("touch-fab");
  });

  it("opens Settings as a list of sections, a page after a tap, and back", async () => {
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const threads = await screen.findByRole("dialog", { name: "Threads" });
    fireEvent.click(within(threads).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(settings.dataset.view).toBe("sections");
    fireEvent.click(within(settings).getByRole("button", { name: "About" }));
    expect(settings.dataset.view).toBe("page");
    fireEvent.click(within(settings).getByRole("button", { name: "All settings" }));
    expect(settings.dataset.view).toBe("sections");
    fireEvent.click(within(settings).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  });

  it("names the host a native shell put on screen and runs the shell's own action from More", async () => {
    const client = createFakeHostClient({ bootstrap: bootstrapWith(THREADS) });
    const storage = createMemoryStorage();
    setHostClient(client);
    setClientStorage(storage);
    const switched: string[] = [];
    render(<WebWorkbench
      client={client}
      storage={storage}
      services={createRendererServices()}
      environment={{ ...webClientEnvironment("compact"), shell: { hostLabel: "Studio Mac", actions: [{ id: "hosts", label: "Hosts", run: () => switched.push("hosts") }] } }}
    />);
    await screen.findByRole("button", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const threads = await screen.findByRole("dialog", { name: "Threads" });
    // The list's title stays "Threads"; the host is named in More.
    expect(within(threads).queryByText("Studio Mac")).toBeNull();
    fireEvent.click(within(threads).getByRole("button", { name: "More" }));
    expect(await screen.findByText("On Studio Mac")).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hosts" }));
    expect(switched).toEqual(["hosts"]);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Hosts" })).toBeNull());
  });

  it("opens the thread list as a sheet from the title bar", async () => {
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const sheet = await screen.findByRole("dialog", { name: "Threads" });
    expect(within(sheet).getByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const reopened = await screen.findByRole("dialog", { name: "Threads" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close threads" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
  });
});

describe("a phone with no thread open", () => {
  const TWO_PROJECTS: ProjectEntry[] = [{ path: "/", name: "/", lastOpenedAt: 99 }, { path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 2 }];

  it("starts on its thread list, not on an empty composer in the host's folder", async () => {
    renderHome();
    const home = await screen.findByRole("region", { name: "Threads" });
    expect(within(home).getByRole("list", { name: "Threads" })).toBeTruthy();
    // The host's blank session is no thread of anybody's.
    expect(within(home).queryByRole("button", { name: "Open thread Untitled thread" })).toBeNull();
    expect(within(home).getByRole("button", { name: "New thread" }).className).toBe("touch-fab");
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(true);
  });

  it("starts a new thread in the project the host last worked in, never in /", async () => {
    renderHome([], TWO_PROJECTS);
    fireEvent.click(within(await screen.findByRole("region", { name: "Threads" })).getByRole("button", { name: "New thread" }));
    expect(await screen.findByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Threads" })).toBeNull();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(false);
  });

  it("asks for a project when the host knows none but /", async () => {
    renderCompactClient({ bootstrap: bootstrapWith([], { home: true, projects: [{ path: "/", name: "/", lastOpenedAt: 1 }] }) });
    const home = await screen.findByRole("region", { name: "Threads" });
    expect(within(home).getByText("No threads yet")).toBeTruthy();
    fireEvent.click(within(home).getByRole("button", { name: "New thread" }));
    expect(await screen.findByPlaceholderText("Search projects")).toBeTruthy();
    // No draft until a project is chosen: the start page stays.
    expect(screen.getByRole("region", { name: "Threads" })).toBeTruthy();
  });

  it("narrows the list to one project, starts the new thread there, and shows all again", async () => {
    const other = { ...thread("t-o", "Tune the other one", 50), projectPath: "/other", projectName: "other" };
    renderCompactClient({ bootstrap: bootstrapWith([...THREADS, other], { home: true, projects: TWO_PROJECTS }) });
    const home = await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(home).getByRole("button", { name: "Project: all projects. Change" }));
    const sheet = await screen.findByRole("dialog", { name: "Show threads of" });
    expect(within(sheet).getByRole("button", { name: /^All projects/u }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: /^project/u }));
    await waitFor(() => expect(within(home).queryByRole("button", { name: "Open thread Tune the other one" })).toBeNull());
    expect(within(home).getByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    fireEvent.click(within(home).getByRole("button", { name: "Show all projects" }));
    expect(await within(home).findByRole("button", { name: "Open thread Tune the other one" })).toBeTruthy();

    // `other` was busy last, but the filter names the project a new thread starts in.
    fireEvent.click(within(home).getByRole("button", { name: "Project: all projects. Change" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Show threads of" })).getByRole("button", { name: /^project/u }));
    fireEvent.click(within(home).getByRole("button", { name: "New thread" }));
    expect(await screen.findByRole("button", { name: "Change project, current project project" })).toBeTruthy();
  });
});

describe("the compact client on a tablet", () => {
  beforeEach(() => setViewport(1024, 768));

  it("keeps the thread list in a sidebar beside the thread, and the title bar folds it away", async () => {
    const client = renderCompactClient();
    const sidebar = await screen.findByRole("navigation", { name: "Thread list" });
    expect(document.querySelector(".app-shell")?.classList.contains("touch-split")).toBe(true);
    expect((document.querySelector(".app-shell") as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("328px");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Open thread Ship the web client" }));
    await waitFor(() => expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-b.json"));
    // The start screen's list would repeat the sidebar.
    expect(screen.queryByRole("region", { name: "Agent supervision" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(document.querySelector(".app-shell")?.classList.contains("sidebar-closed")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
  });

  it("stays one screen wide on a phone turned sideways", async () => {
    setViewport(844, 390);
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    expect(screen.queryByRole("navigation", { name: "Thread list" })).toBeNull();
    expect(document.querySelector(".app-shell")?.classList.contains("touch-split")).toBe(false);
  });
});

describe("a touch keyboard", () => {
  it("writes a newline on return; the button sends", async () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const client = renderCompactClient();
      await screen.findByRole("button", { name: "Threads" });
      const textarea = await screen.findByRole("textbox");
      expect(textarea.getAttribute("placeholder")).toBe("Direct the agent");
      fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await act(async () => { await Promise.resolve(); });
      expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toBe("ship it"));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the address of the open thread", () => {
  it("opens the thread a link names, once", async () => {
    window.history.replaceState(null, "", "/?thread=t-c");
    const client = renderCompactClient();
    await waitFor(() => expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-c.json"));
    expect(client.calls.filter((call) => call.method === "switchSession")).toHaveLength(1);
  });

  it("writes the open thread into the address", async () => {
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("thread")).toBe("t-a"));
  });
});
