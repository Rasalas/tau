// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Archive, Bot, ChartColumn, GitPullRequest } from "lucide-react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient, type FakeHostClient } from "../renderer/test-support/fake-host-client";
import { createRendererServices } from "../renderer/renderer-services";
import { createMemoryStorage, getClientStorage, setClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

/** A phone-sized viewport, which is what makes the layout compact. The screen is the window's unless a test says otherwise. */
function setViewport(width: number, height = 844, screenSize = { width, height }): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  Object.defineProperty(window.screen, "width", { value: screenSize.width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: screenSize.height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
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

const SPENT = { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_200, costUsd: 0.42, turns: 1 };
const THREADS = [thread("t-a", "Rename the store", 30), { ...thread("t-b", "Ship the web client", 20), usage: SPENT }, thread("t-c", "Fix the flaky test", 10)];
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

/** A phone opens on its list; a tap on a row shows that thread's chat. */
async function openChat(title = "Rename the store"): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: `Open thread ${title}` }));
  await screen.findByRole("button", { name: "Back to threads" });
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
    // One word for a question on every client, the desktop rail's too.
    expect(rows[0].querySelector(".thread-status-age")?.textContent).toBe("Question");
    // The desktop rail's triplet: a question in amber behind a help glyph.
    expect(rows[0].querySelector(".thread-status-age.status-waiting > svg")).toBeTruthy();
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

  it("stops a running thread from its sheet, without opening it; the row itself has no stop button", async () => {
    const client = renderHome();
    await screen.findByRole("list", { name: "Threads" });
    client.emit(running("t-b"));
    await waitFor(() => expect(rowNamed("Ship the web client").dataset.status).toBe("running"));
    expect(within(rowNamed("Ship the web client")).queryByRole("button", { name: /^Stop /u })).toBeNull();
    fireEvent.contextMenu(rowNamed("Ship the web client").querySelector(".swipe-row")!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Ship the web client" })).getByRole("button", { name: "Stop the run" }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "abort")).toBe(true));
    expect(client.calls.find((call) => call.method === "abort")?.args[0]).toBe("t-b");
  });

  it("shows a run that started before it connected as Working, timed from the host's start", async () => {
    const startedAt = Date.now() - 134_000;
    renderCompactClient({ bootstrap: async () => {
      const bootstrap = await bootstrapWith(THREADS, { home: true })();
      return { ...bootstrap, threadIndex: { ...bootstrap.threadIndex, runs: { "t-c": startedAt } } };
    } });
    const list = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0].dataset.status).toBe("running"));
    const badge = within(list).getAllByRole("listitem")[0].querySelector(".thread-status-age.status-working");
    // The desktop rail's words and clock: "Working 2:14", not the seconds since this page loaded.
    expect(badge?.textContent).toMatch(/^Working2:1[45]$/u);
  });

  it("keeps the host's start of a run the host reports as started again, as after an automatic retry", async () => {
    const client = renderHome();
    const list = await screen.findByRole("list", { name: "Threads" });
    const startedAt = Date.now() - 79_000;
    client.emit({ type: "agent-status", sessionId: "t-c", running: true, startedAt });
    client.emit({ type: "agent-status", sessionId: "t-c", running: true, startedAt });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0].dataset.status).toBe("running"));
    expect(within(list).getAllByRole("listitem")[0].querySelector(".thread-status-age")?.textContent).toMatch(/^Working1:(19|20)$/u);
  });

  it("answers a Pi confirm on the thread that is open", async () => {
    const client = renderCompactClient();
    await openChat();
    client.emit({ type: "extension-ui-prompt", sessionId: "t-a", prompt: { id: "q7", sessionId: "t-a", kind: "confirm", title: "Run the migration?" } });
    await screen.findByText("Run the migration?");
    // The phone draws it as the design's approval card: its head, and Approve in the card.
    expect(screen.getByRole("region", { name: /^Approval/u })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Answer in text…");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "answerExtensionUi")).toBe(true));
    const answer = client.calls.find((call) => call.method === "answerExtensionUi");
    expect(answer?.args).toEqual(["q7", { confirmed: true }]);
  });

  it("keeps the model and its reasoning level in the phone's footer, the rest behind its menu", async () => {
    const base = bootstrapWith(THREADS);
    const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    renderCompactClient({ bootstrap: async () => {
      const boot = await base();
      return { ...boot, catalog: { ...boot.catalog, models: [luna], model: luna, thinkingLevel: "medium", thinkingLevels: ["off", "medium", "high"] } };
    } });
    await openChat();
    const footer = document.querySelector<HTMLElement>(".composer-toolbar")!;
    expect(within(footer).getByLabelText("Select model: GPT-5.6 Luna").textContent).toContain("GPT-5.6 Luna");
    expect(within(footer).getByLabelText("Reasoning: Medium").textContent).toBe("Medium");
    expect(within(footer).queryByText(/\$/u)).toBeNull();
  });

  it("sends a prompt from the composer at the bottom", async () => {
    const client = renderCompactClient();
    await openChat();
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(true));
    expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toBe("ship it");
  });

  it("draws no workspace dock and no thread column: this client cannot", async () => {
    renderCompactClient();
    await openChat();
    expect(document.querySelector(".instrument-dock")).toBeNull();
    expect(document.querySelector(".session-rail")).toBeNull();
  });

  it("settles a thread with a full swipe and brings it back from the settled shelf", async () => {
    renderHome();
    await screen.findByRole("list", { name: "Threads" });
    swipe(rowNamed("Fix the flaky test").querySelector(".swipe-row")!, 380, 60);
    // The shelf starts open under its count, right after the active threads, as the design draws it.
    const toggle = await screen.findByRole("button", { name: "Settled · 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Settled · 1");
    expect(screen.queryByRole("list", { name: "Settled threads" })).toBeNull();
    fireEvent.click(toggle);
    const shelf = screen.getByRole("list", { name: "Settled threads" });
    expect(within(shelf).getByText("Fix the flaky test")).toBeTruthy();
    expect(rowNamed("Fix the flaky test").dataset.settled).toBe("true");
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
    // The row leaves the cost out, as the desktop rail does; a phone has no hover card, so the sheet says it.
    expect(sheet.querySelector(".action-sheet-summary")?.textContent).toBe("Cost $0.42");
    expect(rowNamed("Ship the web client").textContent).not.toContain("$0.42");
    fireEvent.click(within(sheet).getByRole("button", { name: "Archive thread" }));
    await waitFor(() => expect(archived).toEqual(["t-b"]));
    expect(screen.queryByRole("dialog", { name: "Ship the web client" })).toBeNull();
  });

  it("tells a kit when its list covers the thread, and the order that list shows", async () => {
    const seen: Array<{ covered?: boolean; order?: readonly string[] }> = [];
    const looking: DesktopExtension = {
      id: "test.looking",
      name: "Looking probe",
      activate(plugin) {
        plugin.registerCommand({ id: "probe.look", label: "Look", group: "Thread", surfaces: ["thread-row", "thread-title"], run: (actions) => {
          seen.push({ covered: actions.activeThread()?.covered, order: actions.threadListOrder?.() });
        } });
      },
    };
    renderCompactClient({}, [looking]);
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.contextMenu(rowNamed("Ship the web client").querySelector(".swipe-row")!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Ship the web client" })).getByRole("button", { name: "Look" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ covered: true, order: ["t-a", "t-b", "t-c"] });

    // A settled thread keeps its place, so a kit that plans after the settle still finds it.
    swipe(rowNamed("Ship the web client").querySelector(".swipe-row")!, 380, 60);
    await screen.findByRole("button", { name: "Settled · 1" });
    await openChat();
    fireEvent.click(document.querySelector(".thread-title-trigger")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Look" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({ covered: undefined, order: ["t-a", "t-b", "t-c"] });
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
    await openChat();
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
    await openChat();
    // Two panels keep their glyphs in the bar (design 1n); a third would fold into More.
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Review" })).getByRole("button", { name: "Show agents" }));
    expect(await within(await screen.findByRole("dialog", { name: "Agents" })).findByText("agents panel body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Review" })).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review" })).toBeNull());
  });

  it("finds a thread from the search popover and starts a new one from the floating button", async () => {
    const client = renderCompactClient();
    const home = await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(home).getByRole("button", { name: "Search threads" }));
    const field = await screen.findByRole("searchbox", { name: "Search threads" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.change(field, { target: { value: "nothing like it" } });
    expect(screen.getByRole("status").textContent).toContain("No thread matches");
    fireEvent.change(field, { target: { value: "flaky" } });
    fireEvent.click(within(screen.getByRole("list", { name: "Search results" })).getByRole("button", { name: /Fix the flaky test/u }));
    await waitFor(() => expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-c.json"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Threads" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    const again = await screen.findByRole("region", { name: "Threads" });
    expect(within(again).getAllByRole("button", { name: "New thread" })).toHaveLength(1);
    expect(within(again).getByRole("button", { name: "New thread" }).className).toBe("touch-fab");
  });

  it("opens Settings from the bottom navigation as a list of sections, a page after a tap, and back", async () => {
    renderCompactClient();
    await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(settings.dataset.view).toBe("sections");
    // A main page: the bar is under it and there is no Close.
    expect(within(settings).getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(within(settings).queryByRole("button", { name: "Close settings" })).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: /^About Tau/u }));
    expect(settings.dataset.view).toBe("page");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "All settings" }));
    expect(settings.dataset.view).toBe("sections");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Threads" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
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
    const threads = await screen.findByRole("region", { name: "Threads" });
    // The list's title stays "Threads"; the host is named in More.
    expect(within(threads).queryByText("Studio Mac")).toBeNull();
    fireEvent.click(within(threads).getByRole("button", { name: "More" }));
    expect(await screen.findByText("On Studio Mac")).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hosts" }));
    expect(switched).toEqual(["hosts"]);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Hosts" })).toBeNull());
  });

  it("goes back from a chat to the list with the button in its bar", async () => {
    renderCompactClient();
    await openChat();
    expect(screen.queryByRole("region", { name: "Threads" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    const home = await screen.findByRole("region", { name: "Threads" });
    expect(within(home).getByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(true);
  });
});

/** The new thread's sheet (K98): the project in context leads it; a tap starts the draft there. */
async function pickFirstProject(expected: string): Promise<HTMLElement> {
  const sheet = await screen.findByRole("dialog", { name: "New thread in" });
  const options = within(sheet).getAllByRole("option");
  expect(options[0]!.querySelector("strong")?.textContent).toBe(expected);
  expect(options[0]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(options[0]!);
  return sheet;
}

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

  it("asks for the project in a sheet, the one the host last worked in first and / last", async () => {
    renderHome([], TWO_PROJECTS);
    fireEvent.click(within(await screen.findByRole("region", { name: "Threads" })).getByRole("button", { name: "New thread" }));
    const sheet = await screen.findByRole("dialog", { name: "New thread in" });
    expect(sheet.className).toContain("touch-sheet");
    expect(within(sheet).getAllByRole("option").map((option) => option.querySelector("strong")?.textContent)).toEqual(["project", "other", "/"]);
    // The search waits for a tap: a keyboard would cover the list.
    expect(document.activeElement).not.toBe(within(sheet).getByRole("textbox", { name: "Search projects" }));
    await pickFirstProject("project");
    expect(await screen.findByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Threads" })).toBeNull();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(false);
  });

  it("goes straight to adding a project when the host knows none but /", async () => {
    renderCompactClient({ bootstrap: bootstrapWith([], { home: true, projects: [{ path: "/", name: "/", lastOpenedAt: 1 }] }) });
    const home = await screen.findByRole("region", { name: "Threads" });
    expect(within(home).getByText("No threads yet")).toBeTruthy();
    fireEvent.click(within(home).getByRole("button", { name: "New thread" }));
    expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
    // No draft until a project is chosen: the start page stays.
    expect(screen.getByRole("region", { name: "Threads" })).toBeTruthy();
  });

  it("narrows the list to one project, starts the new thread there, and shows all again", async () => {
    const other = { ...thread("t-o", "Tune the other one", 50), projectPath: "/other", projectName: "other" };
    renderCompactClient({ bootstrap: bootstrapWith([...THREADS, other], { home: true, projects: TWO_PROJECTS }) });
    const home = await screen.findByRole("region", { name: "Threads" });
    // An icon in the header, between search and More, as on the desktop rail; no row over the list.
    const filter = within(home).getByRole("button", { name: "Filter threads by project" });
    expect(filter.closest(".touch-browser-header")).toBeTruthy();
    expect(home.querySelector(".touch-project-filter-button")).toBeNull();
    fireEvent.click(filter);
    const sheet = await screen.findByRole("dialog", { name: "Show threads of" });
    expect(within(sheet).getByRole("button", { name: /^All projects/u }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: /^project/u }));
    await waitFor(() => expect(within(home).queryByRole("button", { name: "Open thread Tune the other one" })).toBeNull());
    expect(within(home).getByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    fireEvent.click(within(home).getByRole("button", { name: "Filter threads by project: project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Show threads of" })).getByRole("button", { name: /^All projects/u }));
    expect(await within(home).findByRole("button", { name: "Open thread Tune the other one" })).toBeTruthy();

    // `other` was busy last, but the filter names the project offered first.
    fireEvent.click(within(home).getByRole("button", { name: "Filter threads by project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Show threads of" })).getByRole("button", { name: /^project/u }));
    fireEvent.click(within(home).getByRole("button", { name: "New thread" }));
    await pickFirstProject("project");
    expect(await screen.findByRole("button", { name: "Change project, current project project" })).toBeTruthy();
  });
});

describe("a new thread's draft in the phone's list", () => {
  const composer = () => screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement;
  async function startDraft(): Promise<HTMLElement> {
    const home = await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(home).getByRole("button", { name: "New thread" }));
    await screen.findByRole("button", { name: "Back to threads" });
    return home;
  }
  const back = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    return await screen.findByRole("region", { name: "Threads" });
  };

  it("closes a draft nobody wrote in on the way back to the list", async () => {
    renderHome();
    await startDraft();
    const home = await back();
    expect(within(home).queryByRole("button", { name: /^Open draft / })).toBeNull();
  });

  it("keeps a draft with text above the active threads, opens it again with a tap, and discards it from its sheet", async () => {
    renderHome();
    await startDraft();
    fireEvent.change(composer(), { target: { value: "Sketch the onboarding" } });
    const home = await back();
    const row = within(home).getByRole("button", { name: "Open draft Sketch the onboarding" });
    const rows = within(within(home).getByRole("list", { name: "Threads" })).getAllByRole("listitem");
    expect(rows[0]?.contains(row)).toBe(true);
    expect(within(row).getByText("draft")).toBeTruthy();

    fireEvent.click(row);
    await screen.findByRole("button", { name: "Back to threads" });
    expect(composer().value).toBe("Sketch the onboarding");

    const again = await back();
    fireEvent.click(within(again).getByRole("button", { name: "Actions for draft Sketch the onboarding" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Sketch the onboarding" })).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(within(again).queryByRole("button", { name: /^Open draft / })).toBeNull());
  });

  it("opens the draft's sheet on a long press on its title", async () => {
    renderHome();
    await startDraft();
    fireEvent.change(composer(), { target: { value: "Press me" } });
    const home = await back();
    const title = within(home).getByRole("button", { name: "Open draft Press me" }).querySelector(".thread-title")!;
    fireEvent.pointerDown(title, { pointerType: "touch", pointerId: 3, button: 0, clientX: 40, clientY: 20 });
    expect(await screen.findByRole("dialog", { name: "Press me" }, { timeout: 2_000 })).toBeTruthy();
  });

  it("takes no swipe: a draft is never thrown away by a gesture", async () => {
    renderHome();
    await startDraft();
    fireEvent.change(composer(), { target: { value: "Keep me" } });
    const home = await back();
    const item = within(home).getByRole("button", { name: "Open draft Keep me" }).closest("li") as HTMLElement;
    swipe(item.querySelector(".swipe-row")!, 300, 20);
    expect(within(home).getByRole("button", { name: "Open draft Keep me" })).toBeTruthy();
  });

  it("stays out of the list order a settle moves along", async () => {
    let order: readonly string[] | undefined;
    const reader: DesktopExtension = { id: "test.order", name: "Order", activate(plugin) {
      plugin.registerCommand({ id: "test.read-order", label: "Read order", group: "Thread", surfaces: ["thread-row"], run: (actions) => { order = actions.threadListOrder?.(); } });
    } };
    renderCompactClient({ bootstrap: bootstrapWith(THREADS, { home: true }) }, [reader]);
    await startDraft();
    fireEvent.change(composer(), { target: { value: "Not a thread yet" } });
    const home = await back();
    expect(within(home).getByRole("button", { name: "Open draft Not a thread yet" })).toBeTruthy();
    fireEvent.contextMenu(rowNamed("Ship the web client").querySelector(".swipe-row")!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Ship the web client" })).getByRole("button", { name: "Read order" }));
    await waitFor(() => expect(order).toEqual(["t-a", "t-b", "t-c"]));
  });
});

describe("the compact client on a tablet", () => {
  beforeEach(() => setViewport(1024, 768));

  it("shows only the branch under the tablet's thread title", async () => {
    const base = bootstrapWith(THREADS);
    const model = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    renderCompactClient({ bootstrap: async () => {
      const boot = await base();
      return { ...boot, project: { ...boot.project, label: "feat/tablet" }, catalog: { ...boot.catalog, models: [model], model } };
    } });
    const branch = await screen.findByText("feat/tablet");
    const details = branch.closest(".thread-details")!;
    expect(details.textContent).toBe("feat/tablet");
    expect(details.querySelector(".thread-detail-branch svg")).toBeTruthy();
    expect(details.querySelector(".thread-detail-model, .thread-detail-turn")).toBeNull();
    expect(await screen.findByLabelText("Select model: GPT-5.6 Luna")).toBeTruthy();
  });

  it("resizes the sidebar by touch and remembers its width across narrower windows", async () => {
    renderCompactClient();
    const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
    const width = () => (document.querySelector(".app-shell") as HTMLElement).style.getPropertyValue("--sidebar-width");
    fireEvent.pointerDown(handle, { pointerType: "touch", pointerId: 7, button: 0, clientX: 328 });
    fireEvent.pointerMove(document, { pointerType: "touch", pointerId: 7, clientX: 500 });
    fireEvent.pointerUp(document, { pointerType: "touch", pointerId: 7, clientX: 500 });
    expect(width()).toBe("500px");
    expect(getClientStorage()?.get(STORAGE_KEYS.sidebarWidth)).toBe("500");
    act(() => setViewport(700, 768, { width: 1024, height: 768 }));
    expect(width()).toBe("380px");
    expect(getClientStorage()?.get(STORAGE_KEYS.sidebarWidth)).toBe("500");
    act(() => setViewport(1024, 768));
    expect(width()).toBe("500px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe("328px");
    expect(document.body.classList.contains("resizing-col")).toBe(false);
  });

  it("offers the project of the thread beside the list first, or the filtered one", async () => {
    // `other` is where the host last worked; the thread on screen is in `project`.
    const projects: ProjectEntry[] = [{ path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 99 }];
    renderCompactClient({ bootstrap: bootstrapWith(THREADS, { projects }) });
    const sidebar = await screen.findByRole("navigation", { name: "Thread list" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "New thread" }));
    await pickFirstProject("project");
    expect(await screen.findByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull());

    fireEvent.click(within(sidebar).getByRole("button", { name: "Filter threads by project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Show threads of" })).getByRole("button", { name: /^other/u }));
    // The header's button; the empty list offers one too.
    fireEvent.click(within(sidebar).getAllByRole("button", { name: "New thread" })[0]!);
    await pickFirstProject("other");
    expect(await screen.findByRole("button", { name: "Change project, current project other" })).toBeTruthy();
  });

  it("lists a new thread's draft in the sidebar as soon as it opens, and drops it when left empty", async () => {
    renderCompactClient();
    const sidebar = await screen.findByRole("navigation", { name: "Thread list" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "New thread" }));
    const row = await within(sidebar).findByRole("button", { name: "Open draft New thread" });
    expect(row.getAttribute("aria-current")).toBe("true");
    fireEvent.change(screen.getByPlaceholderText(/Ask anything/u), { target: { value: "Tablet idea" } });
    expect(await within(sidebar).findByRole("button", { name: "Open draft Tablet idea" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Ask anything/u), { target: { value: "" } });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Open thread Ship the web client" }));
    await waitFor(() => expect(within(sidebar).queryByRole("button", { name: /^Open draft / })).toBeNull());
  });

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

  it("keeps the question on the open row beside its thread", async () => {
    // `t-a` is the thread the host holds open.
    const client = renderCompactClient();
    const sidebar = await screen.findByRole("navigation", { name: "Thread list" });
    client.emit({ type: "extension-ui-prompt", sessionId: "t-a", prompt: { id: "q2", sessionId: "t-a", kind: "confirm", title: "Write the file?" } });
    const row = () => within(sidebar).getByRole("button", { name: "Open thread Rename the store" }).closest("li") as HTMLElement;
    await waitFor(() => expect(row().dataset.status).toBe("waiting"));
    expect(row().dataset.active).toBe("true");
    // The row has no hover actions, so the stylesheet leaves its state visible after the tap (see ThreadRow.test).
    expect(row().querySelector(".thread-row-actions")).toBeNull();
    expect(row().querySelector(".thread-status-age.status-waiting")?.textContent).toBe("Question");
  });

  it("stays one screen wide on a phone turned sideways", async () => {
    setViewport(844, 390);
    renderCompactClient();
    await screen.findByRole("button", { name: "Threads" });
    expect(screen.queryByRole("navigation", { name: "Thread list" })).toBeNull();
    expect(document.querySelector(".app-shell")?.classList.contains("touch-split")).toBe(false);
  });

  const split = () => document.querySelector(".app-shell")?.classList.contains("touch-split");

  it("stays a tablet when a keyboard or the system takes height, and within the width band", async () => {
    renderCompactClient();
    await screen.findByRole("navigation", { name: "Thread list" });
    // An on-screen keyboard over a landscape iPad, as a window that reports its height shrinking.
    act(() => setViewport(1024, 380, { width: 1024, height: 768 }));
    expect(split()).toBe(true);
    // A few pixels under the threshold: still the tablet's layout.
    act(() => setViewport(700, 768, { width: 1024, height: 768 }));
    expect(split()).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    // Slide Over is a phone, and wide again is a tablet.
    act(() => setViewport(375, 768, { width: 1024, height: 768 }));
    expect(split()).toBe(false);
    act(() => setViewport(1024, 768));
    expect(split()).toBe(true);
  });

  it("keeps its layout while the page is hidden, and decides again once it is shown", async () => {
    renderCompactClient();
    await screen.findByRole("navigation", { name: "Thread list" });
    try {
      act(() => setVisibility("hidden"));
      // iOS resizes an app in the background for its snapshots.
      act(() => setViewport(375, 768, { width: 1024, height: 768 }));
      expect(split()).toBe(true);
      act(() => setViewport(1024, 768));
      act(() => setVisibility("visible"));
      expect(split()).toBe(true);
    } finally {
      setVisibility("visible");
    }
  });

  it("opens a compact panel as a stage tab beside the chat, where a phone opens a sheet", async () => {
    renderCompactClient({}, [probe]);
    await screen.findByRole("navigation", { name: "Thread list" });
    expect(document.querySelector(".panel-rail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show stage" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Agents" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    // Only what claims the compact client: a desktop-only panel is not there.
    expect(within(stage).queryByRole("button", { name: "Files" })).toBeNull();
    expect(await within(stage).findByText("agents panel body")).toBeTruthy();
    expect(within(stage).getByRole("tab", { name: /Agents/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    const tool = await screen.findByRole("button", { name: "Agents" });
    expect(tool.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tool);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
    const folded = await screen.findByRole("button", { name: "Agents" });
    expect(folded.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(folded);
    expect(await screen.findByRole("region", { name: "Stage" })).toBeTruthy();
  });
});

describe("a touch keyboard", () => {
  it("writes a newline on return; the button sends", async () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const client = renderCompactClient();
      await openChat();
      const textarea = await screen.findByRole("textbox");
      expect(textarea.getAttribute("placeholder")).toBe("Ask anything, or hand it work…");
      // The on-screen keyboard is up (TouchLayer marks it from the visual viewport).
      document.body.setAttribute("data-keyboard", "");
      fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await act(async () => { await Promise.resolve(); });
      expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toBe("ship it"));
    } finally {
      document.body.removeAttribute("data-keyboard");
      vi.unstubAllGlobals();
    }
  });

  it("sends on return from a hardware keyboard, with no on-screen keyboard over the page", async () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const client = renderCompactClient();
      await openChat();
      const textarea = await screen.findByRole("textbox");
      fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
      expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
      await act(async () => { await Promise.resolve(); });
      expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(false);
      fireEvent.keyDown(textarea, { key: "Enter" });
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

  it("writes the open thread into the address, and none on the list", async () => {
    renderCompactClient();
    await screen.findByRole("region", { name: "Threads" });
    expect(new URL(window.location.href).searchParams.get("thread")).toBeNull();
    await openChat();
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("thread")).toBe("t-a"));
  });
});

/** Pages as the Usage and Review kits register them: one a phone may show, with a view; one it may not. */
const pageProbe: DesktopExtension = {
  id: "test.pages",
  name: "Pages probe",
  activate(plugin) {
    plugin.registerPage({
      id: "probe.usage", label: "Usage", Icon: ChartColumn, order: 20, profiles: ["desktop", "web", "compact"],
      Component: ({ params, navigate }) => params.detail
        ? <p>usage detail</p>
        : <button type="button" onClick={() => navigate({ detail: true }, { label: "Prices" })}>Show prices</button>,
    });
    plugin.registerPage({ id: "probe.requests", label: "Pull requests", Icon: GitPullRequest, order: 10, profiles: ["desktop", "compact"], Component: () => <p>requests body</p> });
    plugin.registerPage({ id: "probe.desk", label: "Desk only", profiles: ["desktop"], Component: () => <p>desk body</p> });
  },
};

const bar = () => screen.queryByRole("navigation", { name: "Main" });
const tab = (label: string) => within(bar()!).getByRole("button", { name: label });
const param = (name: string) => new URL(window.location.href).searchParams.get(name);

describe("a phone's home and bottom navigation", () => {
  it("has the bar on its list: Threads, the pages a phone may show in their order, Settings", async () => {
    renderCompactClient({}, [pageProbe]);
    await screen.findByRole("region", { name: "Threads" });
    await waitFor(() => expect(within(bar()!).getAllByRole("button").map((button) => button.textContent)).toEqual(["Threads", "Pull requests", "Usage", "Settings"]));
    expect(tab("Threads").getAttribute("aria-current")).toBe("page");
  });

  it("shows a chat as a sub-page without the bar; the system's back returns to the list", async () => {
    renderCompactClient({}, [pageProbe]);
    await openChat();
    expect(bar()).toBeNull();
    await waitFor(() => expect(param("thread")).toBe("t-a"));
    act(() => window.history.back());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
    await waitFor(() => expect(param("thread")).toBeNull());
    expect(bar()).toBeTruthy();
    // The same thread again: a new entry, and the button leaves it as back would.
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
    await waitFor(() => expect(param("thread")).toBeNull());
  });

  it("puts the list under a chat a link opened, so back lands on the list", async () => {
    window.history.replaceState(null, "", "/?thread=t-c");
    const client = renderCompactClient({}, [pageProbe]);
    await waitFor(() => expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-c.json"));
    await screen.findByRole("button", { name: "Back to threads" });
    act(() => window.history.back());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
    expect(param("thread")).toBeNull();
  });

  it("opens a page from the bar as a main page; a view it steps into hides the bar, and back steps out", async () => {
    renderCompactClient({}, [pageProbe]);
    await screen.findByRole("region", { name: "Threads" });
    await waitFor(() => expect(bar()).toBeTruthy());
    fireEvent.click(tab("Usage"));
    const page = await screen.findByRole("region", { name: "Usage" });
    expect(param("page")).toBe("probe.usage");
    await waitFor(() => expect(within(page).getByRole("navigation", { name: "Main" })).toBeTruthy());
    expect(tab("Usage").getAttribute("aria-current")).toBe("page");
    // A main page has no back of its own.
    expect(within(page).queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(within(page).getByRole("button", { name: "Show prices" }));
    expect(await within(page).findByText("usage detail")).toBeTruthy();
    expect(bar()).toBeNull();
    act(() => window.history.back());
    expect(await within(page).findByRole("button", { name: "Show prices" })).toBeTruthy();
    await waitFor(() => expect(bar()).toBeTruthy());

    // Another destination takes the page's place; back still leads home.
    fireEvent.click(tab("Pull requests"));
    expect(await screen.findByText("requests body")).toBeTruthy();
    await waitFor(() => expect(param("page")).toBe("probe.requests"));
    act(() => window.history.back());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("requests body")).toBeNull());
    expect(param("page")).toBeNull();
  });

  it("leaves a Settings section by the system's back, then Settings", async () => {
    renderCompactClient({}, [pageProbe]);
    await screen.findByRole("region", { name: "Threads" });
    await waitFor(() => expect(bar()).toBeTruthy());
    fireEvent.click(tab("Settings"));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(param("settings")).toBe(""));
    fireEvent.click(within(settings).getByRole("button", { name: /^About Tau/u }));
    await waitFor(() => expect(param("settings")).toBe("about"));
    expect(bar()).toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(settings.dataset.view).toBe("sections"));
    expect(bar()).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
  });

  it("opens a page a link names over the list", async () => {
    window.history.replaceState(null, "", "/?page=probe.usage");
    renderCompactClient({}, [pageProbe]);
    expect(await screen.findByRole("region", { name: "Usage" })).toBeTruthy();
    act(() => window.history.back());
    expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Usage" })).toBeNull());
  });
});
