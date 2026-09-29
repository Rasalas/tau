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
/** Where only one of the two fits, the chat in front: the stage is folded away and the conversation shown. */
const chatInFront = (center: () => string) => screen.queryByRole("region", { name: "Stage" }) === null && !center().includes("conversation-folded");

describe("picking a thread in the rail while only one of chat and stage fits", () => {
  it("brings the chat forward for another thread and for the one on screen; each thread keeps its own terminal tab", async () => {
    setWindowWidth(900);
    const { pick, center, switchSession } = await renderRail();
    const stage = await openTerminal();
    expect(center()).toContain("conversation-folded");
    expect(selected(stage, /Terminal/)).toBe("true");

    pick("b");
    await waitFor(() => expect(chatInFront(center)).toBe(true));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/b.jsonl"));

    // Thread b has a stage of its own; its terminal comes in front of the chat.
    const stageB = await openTerminal();
    expect(within(stageB).getAllByRole("tab")).toHaveLength(1);
    pick("b");
    await waitFor(() => expect(chatInFront(center)).toBe(true));
    await waitFor(() => expect(switchSession).toHaveBeenCalledTimes(2));

    pick("a");
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/a.jsonl"));
    fireEvent.click(await screen.findByRole("button", { name: "Show stage" }));
    expect(within(await screen.findByRole("region", { name: "Stage" })).getByRole("tab", { name: /Terminal/ })).toBeTruthy();
  });

  it("brings the chat back beside a maximized tool, which stays in its tab", async () => {
    setWindowWidth(1728);
    const { pick, center } = await renderRail();
    fireEvent.click(await screen.findByRole("button", { name: "Show stage" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Diffs/ }));
    fireEvent.click(await within(stage).findByRole("button", { name: "Maximize stage" }));
    expect(center()).toContain("conversation-folded");

    pick("a");
    // Chat and stage side by side again: the row asks for the chat, not for the stage to go.
    await waitFor(() => expect(center()).not.toContain("conversation-folded"));
    expect(center()).toContain("stage-open");
    const again = screen.getByRole("region", { name: "Stage" });
    expect(within(again).getByRole("button", { name: "Maximize stage" }).getAttribute("aria-pressed")).toBe("false");
    expect(selected(again, /Diffs/)).toBe("true");
  });

  it("leaves the stage alone where the chat is beside it", async () => {
    setWindowWidth(1728);
    const { pick, center } = await renderRail();
    const stage = await openTerminal();
    expect(center()).toContain("stage-open");
    pick("a");
    expect(selected(stage, /Terminal/)).toBe("true");
    expect(center()).not.toContain("conversation-folded");

    // Narrowed afterwards, the stage keeps its own tab in front, the chat folded beside it.
    act(() => setWindowWidth(900));
    expect(center()).toContain("conversation-folded");
    expect(selected(stage, /Terminal/)).toBe("true");
  });
});

/** The phone's bar shows each sheet's glyph, or folds them past two into its More menu. */
async function openSheet(label: string): Promise<void> {
  const bar = document.querySelector<HTMLElement>(".title-bar")!;
  const direct = within(bar).queryByRole("button", { name: label });
  if (direct) { fireEvent.click(direct); return; }
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  fireEvent.click(within(await screen.findByRole("menu", { name: "Panels" })).getByRole("menuitemcheckbox", { name: label }));
}

describe("picking a thread on a phone", () => {
  it("opens the chat, not the panel sheet that was open, even for the thread on screen", async () => {
    setWindowWidth(390);
    const { switchSession } = await renderRail();
    await openSheet("Notes");
    expect(await screen.findByRole("dialog", { name: "Notes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open thread Thread a" }));
    expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/a.jsonl"));
  });
});

const composerFocused = () => document.activeElement === document.querySelector(".conversation-column textarea");
const startScreenShown = () => screen.queryByRole("heading", { name: /do next\?$/ }) !== null;

async function pickProjectWithEnter(): Promise<void> {
  const picker = await screen.findByRole("dialog", { name: "Search projects" });
  fireEvent.keyDown(within(picker).getByRole("textbox", { name: "Search projects" }), { key: "Enter", bubbles: true, cancelable: true });
}

function pressNewThreadShortcut(key = "n", shiftKey = false): void {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key, metaKey: mac, ctrlKey: !mac, shiftKey, bubbles: true, cancelable: true });
}

describe("starting a new thread while only one of chat and stage fits", () => {
  it("shows the draft's chat with a stage of its own and focuses its composer from the shortcut, the rail, the palette and the start card", async () => {
    setWindowWidth(900);
    await renderRail();

    // ⌘N, the rail and the palette open in the project on screen; ⇧⌘O and "New thread in…" ask.
    const starts: Array<() => Promise<void>> = [
      async () => { pressNewThreadShortcut(); },
      async () => { fireEvent.click(screen.getByRole("button", { name: "New thread" })); },
      async () => { await runPaletteCommand("Create new thread"); },
      async () => { pressNewThreadShortcut("O", true); await pickProjectWithEnter(); },
      async () => { await runPaletteCommand("New thread in…"); await pickProjectWithEnter(); },
    ];
    for (const start of starts) {
      const stage = await openTerminal();
      fireEvent.click(within(stage).getByRole("tab", { name: /Terminal/ }));
      (document.activeElement as HTMLElement | null)?.blur();

      await start();
      expect(startScreenShown()).toBe(true);
      expect(composerFocused()).toBe(true);
      // A new draft starts with nothing beside its chat.
      expect(screen.queryByRole("region", { name: "Stage" })).toBeNull();
    }

    // The start card's project button sits in the chat itself.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByRole("button", { name: /^Change project/ }));
    await pickProjectWithEnter();
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
  });

  it("starts the draft without the maximized tool; its thread shows the tool beside its chat again", async () => {
    setWindowWidth(1728);
    const { pick, center } = await renderRail();
    fireEvent.click(await screen.findByRole("button", { name: "Show stage" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Diffs/ }));
    fireEvent.click(await within(stage).findByRole("button", { name: "Maximize stage" }));
    expect(center()).toContain("conversation-folded");

    pressNewThreadShortcut();
    expect(screen.queryByRole("region", { name: "Stage" })).toBeNull();
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
    // A tab opened beside the draft's chat puts documents in front.
    await openTerminal();

    pick("a");
    // Picked from a draft: the thread's chat, beside its tool rather than behind it.
    const again = await screen.findByRole("region", { name: "Stage" });
    await waitFor(() => expect(center()).not.toContain("conversation-folded"));
    expect(within(again).getByRole("tab", { name: /Diffs/ })).toBeTruthy();
    expect(within(again).getByRole("button", { name: "Maximize stage" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("starting a new thread on a phone", () => {
  it("opens the draft's chat over the list and drops the panel sheet", async () => {
    setWindowWidth(390);
    await renderRail();
    await openSheet("Notes");
    expect(await screen.findByRole("dialog", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));

    const [fab] = await screen.findAllByRole("button", { name: "New thread" });
    fireEvent.click(fab!);
    expect(screen.queryByRole("dialog", { name: "Notes" })).toBeNull();
    expect(startScreenShown()).toBe(true);
    expect(composerFocused()).toBe(true);
  });
});
