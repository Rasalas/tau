// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { runPaletteCommand } from "../../src/renderer/test-support/palette.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";

function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setWindowWidth(1024); });

const thread = (id: string, index: number): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 100 - index, projectPath: "/project", projectName: "project", messageCount: 1,
});
const threads = [thread("a", 0), thread("b", 1)];

/** One labelled section, so jsdom draws every row without the virtual list. */
const organizer: ThreadRailOrganizer = {
  subscribe: () => () => undefined,
  getVersion: () => 1,
  sections: (list) => [{ id: "pinned", label: "Pinned", threads: [...list] }, { id: "active", threads: [] }],
  menu: () => [],
  runMenu: () => undefined,
  toggleSettled: () => undefined,
  dropLabel: () => undefined,
  drop: () => undefined,
};
const organizing: DesktopExtension = {
  id: "test.organizer",
  name: "Organizer",
  activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer(organizer)),
};

/** A thread's terminal as a stage tab, and a tool that maximizes onto the stage. */
const tools: DesktopExtension = {
  id: "test.tools",
  name: "Tools probe",
  activate(plugin) {
    plugin.registerStageTab({ kind: "test-terminal", title: () => "Terminal", render: () => <div>terminal output</div> });
    plugin.registerPanel({ id: "diffs", label: "Diffs", order: 1, maximizable: true, Component: () => <div>diff list</div> });
    plugin.registerPanel({ id: "notes", label: "Notes", order: 2, profiles: ["desktop", "web", "compact"], Component: () => <div>notes sheet</div> });
    plugin.registerCommand({ id: "test.terminal", label: "Open the test terminal", group: "Test", run: (actions) => { actions.openStageTab("test-terminal"); } });
  },
};

async function renderRail() {
  const switchSession = vi.fn(async (path: string) => {
    const id = threads.find((session) => session.path === path)?.id ?? "a";
    return {
      version: 1 as const,
      updates: [{ version: 1 as const, type: "thread-detail" as const, detail: { sessionId: id, messages: [], isStreaming: false, activeTools: [] } }],
    };
  });
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: threads },
      detail: { sessionId: "a", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "a", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub(),
    switchSession,
  });
  const view = renderApp(client, { extensions: [workspaceExtension, organizing, tools] });
  await screen.findByText("Thread b");
  const pick = (id: string) => fireEvent.click(document.querySelector<HTMLElement>(`[data-rail-thread="${id}"] .thread-main`)!);
  const center = () => view.container.querySelector(".workbench-center")?.className ?? "";
  return { pick, center, switchSession };
}

async function openTerminal(): Promise<HTMLElement> {
  await runPaletteCommand("Open the test terminal");
  return screen.findByRole("region", { name: "Stage" });
}

const selected = (stage: HTMLElement, name: string | RegExp) => within(stage).getByRole("tab", { name }).getAttribute("aria-selected");

describe("picking a thread in the rail while the centre shows tabs", () => {
  it("brings the chat tab forward for another thread and for the one on screen, and keeps the terminal open", async () => {
    setWindowWidth(1000);
    const { pick, center, switchSession } = await renderRail();
    const stage = await openTerminal();
    expect(selected(stage, "Chat")).toBe("false");
    expect(selected(stage, /Terminal/)).toBe("true");

    pick("b");
    expect(selected(stage, "Chat")).toBe("true");
    expect(center()).toContain("chat-focused");
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/b.jsonl"));
    expect(within(stage).getByRole("tab", { name: /Terminal/ })).toBeTruthy();

    fireEvent.click(within(stage).getByRole("tab", { name: /Terminal/ }));
    expect(selected(stage, "Chat")).toBe("false");
    pick("b");
    expect(selected(stage, "Chat")).toBe("true");
    await waitFor(() => expect(switchSession).toHaveBeenCalledTimes(2));
  });

  it("keeps a maximized tool maximized and only changes the front tab", async () => {
    setWindowWidth(1728);
    const { pick, center } = await renderRail();
    fireEvent.click(await screen.findByRole("button", { name: "Diffs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Maximize Diffs" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    expect(selected(stage, "Chat")).toBe("false");

    pick("a");
    expect(selected(stage, "Chat")).toBe("true");
    expect(within(stage).getByRole("button", { name: "Show chat beside the stage" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(stage).getByRole("tab", { name: /Diffs/ })).toBeTruthy();
    expect(center()).toContain("compact");
  });

  it("leaves the stage alone where the chat is beside it", async () => {
    setWindowWidth(1728);
    const { pick, center } = await renderRail();
    const stage = await openTerminal();
    expect(center()).not.toContain("compact");
    pick("b");
    expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
    expect(selected(stage, /Terminal/)).toBe("true");

    // Narrowed afterwards, the stage keeps its own tab in front, not the chat.
    act(() => setWindowWidth(1000));
    expect(center()).toContain("compact");
    expect(selected(stage, "Chat")).toBe("false");
  });
});

/** Beside Workspace Kit's Files, the test's panel is one of two sheets: they fold into the title bar's More menu. */
async function openSheet(label: string): Promise<void> {
  fireEvent.click(within(document.querySelector<HTMLElement>(".title-bar")!).getByRole("button", { name: "More" }));
  fireEvent.click(within(await screen.findByRole("menu", { name: "Panels" })).getByRole("menuitemcheckbox", { name: label }));
}

describe("picking a thread on a phone", () => {
  it("opens the chat, not the panel sheet that was open, even for the thread on screen", async () => {
    setWindowWidth(390);
    const { switchSession } = await renderRail();
    await openSheet("Notes");
    expect(await screen.findByRole("dialog", { name: "Notes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open thread Thread a" }));
    expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/a.jsonl"));
  });
});

const composerFocused = () => document.activeElement === document.querySelector(".conversation-column textarea");
const startScreenShown = () => screen.queryByRole("heading", { name: "What do you want to build?" }) !== null;

async function pickProjectWithEnter(): Promise<void> {
  const picker = await screen.findByRole("dialog", { name: "Search projects" });
  fireEvent.keyDown(within(picker).getByRole("textbox", { name: "Search projects" }), { key: "Enter", bubbles: true, cancelable: true });
}

function pressNewThreadShortcut(): void {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key: "n", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
}

describe("starting a new thread while the centre shows tabs", () => {
  it("brings the draft's chat forward and focuses its composer from the shortcut, the rail, the palette, the title bar and the start card", async () => {
    setWindowWidth(1000);
    await renderRail();
    const stage = await openTerminal();

    const starts: Array<() => Promise<void>> = [
      async () => { pressNewThreadShortcut(); await pickProjectWithEnter(); },
      async () => { fireEvent.click(screen.getByRole("button", { name: "New thread" })); await pickProjectWithEnter(); },
      async () => { await runPaletteCommand("Create new thread"); await pickProjectWithEnter(); },
      async () => { fireEvent.click(await screen.findByRole("button", { name: "New thread in project" })); },
    ];
    for (const start of starts) {
      fireEvent.click(within(stage).getByRole("tab", { name: /Terminal/ }));
      (document.activeElement as HTMLElement | null)?.blur();
      expect(selected(stage, "Chat")).toBe("false");

      await start();
      expect(selected(stage, "Chat")).toBe("true");
      expect(startScreenShown()).toBe(true);
      expect(composerFocused()).toBe(true);
      expect(within(stage).getByRole("tab", { name: /Terminal/ })).toBeTruthy();
    }

    // The start card's project button sits in the chat itself.
    fireEvent.click(within(stage).getByRole("tab", { name: "Chat" }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByRole("button", { name: /^Change project/ }));
    await pickProjectWithEnter();
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
  });

  it("keeps a maximized tool maximized", async () => {
    setWindowWidth(1728);
    await renderRail();
    fireEvent.click(await screen.findByRole("button", { name: "Diffs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Maximize Diffs" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    expect(selected(stage, "Chat")).toBe("false");

    pressNewThreadShortcut();
    await pickProjectWithEnter();
    expect(selected(stage, "Chat")).toBe("true");
    expect(within(stage).getByRole("button", { name: "Show chat beside the stage" }).getAttribute("aria-pressed")).toBe("true");
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
  });
});

describe("starting a new thread on a phone", () => {
  it("opens the draft's chat over the list and drops the panel sheet", async () => {
    setWindowWidth(390);
    await renderRail();
    await openSheet("Notes");
    expect(await screen.findByRole("dialog", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));

    const [fab] = await screen.findAllByRole("button", { name: "New thread" });
    fireEvent.click(fab!);
    expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
  });
});
