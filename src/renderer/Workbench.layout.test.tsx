// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension, PanelProps } from "./extension-system";
import { runPaletteCommand } from "./test-support/palette";
import { renderApp } from "./test-support/render-app";

/** jsdom's window is 1024 wide unless a test says otherwise. */
function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setWindowWidth(1024); });

/** Counts its own clicks, so a remount would show as a reset counter. */
function Counter({ placement, active }: PanelProps) {
  const [count, setCount] = useState(0);
  return <section className="panel-body">
    <header className="panel-header"><h2>Counter</h2></header>
    <button type="button" onClick={() => setCount((value) => value + 1)}>Count {count}</button>
    <output data-testid="counter-place">{placement}:{active ? "active" : "hidden"}</output>
  </section>;
}

const panels: DesktopExtension = {
  id: "test.layout",
  name: "Layout probe",
  activate(plugin) {
    plugin.registerPanel({ id: "counter", label: "Counter", order: 1, maximizable: true, Component: Counter });
    plugin.registerPanel({ id: "fixed", label: "Fixed", order: 2, Component: () => <div>fixed panel</div> });
    plugin.registerPanel({ id: "shell", label: "Shell", order: 3, placement: "drawer", maximizable: true, Component: () => <div>shell drawer</div> });
  },
};

const tools: DesktopExtension = {
  id: "test.tools",
  name: "Tools probe",
  activate(plugin) {
    plugin.registerPanel({
      id: "browser", label: "Browser", order: 1, width: "wide", maximizable: true,
      Component: ({ actions }) => <button type="button" onClick={() => actions.openFile("/repo/a.ts")}>Open a.ts</button>,
    });
    plugin.registerPanel({
      id: "tree", label: "Tree", order: 2,
      Component: ({ actions }) => <button type="button" onClick={() => actions.openFile("/repo/a.ts")}>Pick a.ts</button>,
    });
  },
};

function pressMod(key: string, options: KeyboardEventInit = {}): void {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true, ...options });
}

const rail: DesktopExtension = { id: "test.rail", name: "Rail probe", activate(plugin) {
  plugin.registerSidebar({ id: "rail", Component: () => <aside className="session-rail">threads</aside> });
} };

const shell = (container: HTMLElement) => container.querySelector(".app-shell") as HTMLElement;

describe("workbench layout", () => {
  it("resizes the sidebar by keyboard within T3's bounds and keeps the width for this client", async () => {
    const view = renderApp(undefined, { extensions: [rail] });
    const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("248px");
    expect(handle.getAttribute("aria-valuemin")).toBe("208");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("264px");
    expect(view.storage.get("tau:sidebar-width")).toBe("264");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("208px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("248px");

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 248 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 330 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("330px");
  });

  it("restores the stored sidebar width, and never lets it squeeze the conversation below 640 px", async () => {
    const storage = createMemoryStorage();
    storage.set("tau:sidebar-width", "900");
    const view = renderApp(undefined, { storage, extensions: [rail] });
    await screen.findByRole("separator", { name: "Resize sidebar" });
    // jsdom's window is 1024 wide: 1024 − 640.
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("384px");
    expect(view.storage.get("tau:sidebar-width")).toBe("900");
  });

  /** The header's toggle: shows the stage, or opens it on the first tool when nothing is open. */
  async function showStage(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: "Show stage" }));
    return screen.findByRole("region", { name: "Stage" });
  }

  it("draws no window-wide title bar and no panel rail: the thread header carries the stage toggle", async () => {
    const view = renderApp(undefined, { extensions: [rail, panels] });
    await screen.findByRole("button", { name: "Show stage" });
    expect(view.container.querySelector(".title-bar")).toBeNull();
    expect(view.container.querySelector(".panel-rail, .instrument-dock")).toBeNull();
    expect(view.container.querySelector(".conversation-column > .thread-header")).not.toBeNull();
  });

  it("opens every panel as a stage tab from the strip's tools, keeping its state across tabs", async () => {
    renderApp(undefined, { extensions: [panels, tools] });
    const stage = await showStage();
    // A panel that asked for a button gets one; the rest are under More tools.
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Counter/ }));
    await waitFor(() => expect(within(stage).getByRole("tab", { name: /Counter/ }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(stage).getByRole("button", { name: "Count 0" }));
    expect(screen.getByTestId("counter-place").textContent).toBe("stage:active");

    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Browser/ }));
    await waitFor(() => expect(within(stage).getByRole("tab", { name: /Browser/ }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(stage).getByRole("tab", { name: /Counter/ }));
    // Never remounted: the count survived its tab going behind another.
    expect(await within(stage).findByRole("button", { name: "Count 1" })).toBeTruthy();
    fireEvent.click(within(stage).getByRole("button", { name: "Close Counter" }));
    await waitFor(() => expect(within(stage).queryByRole("tab", { name: /Counter/ })).toBeNull());
  });

  it("gives a panel that asks for it a button of its own, pressed while its tab is in front, and opens the stage on it", async () => {
    const buttons: DesktopExtension = { id: "test.buttons", name: "Buttons", activate(plugin) {
      plugin.registerPanel({ id: "shell-tab", label: "Shell tab", order: 1, stageButton: true, Component: () => <div>shell tab body</div> });
      plugin.registerPanel({ id: "other", label: "Other", order: 2, stageButton: true, Component: () => <div>other body</div> });
    } };
    renderApp(undefined, { extensions: [buttons] });
    const stage = await showStage();
    // The empty stage opened on the first tool that has a button.
    expect(await within(stage).findByText("shell tab body")).toBeTruthy();
    expect(within(stage).queryByRole("button", { name: "More tools" })).toBeNull();
    expect(within(stage).getByRole("button", { name: "Shell tab" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(stage).getByRole("button", { name: "Other" }));
    expect(await within(stage).findByText("other body")).toBeTruthy();
    expect(within(stage).getByRole("button", { name: "Shell tab" }).getAttribute("aria-pressed")).toBe("false");
    // Opening it again focuses its tab, never a second one.
    fireEvent.click(within(stage).getByRole("button", { name: "Shell tab" }));
    fireEvent.click(within(stage).getByRole("button", { name: "Shell tab" }));
    expect(within(stage).getAllByRole("tab", { name: /Shell tab/ })).toHaveLength(1);
  });

  it("draws a panel's count beside its tab title", async () => {
    let count = 3;
    const counted: DesktopExtension = { id: "test.counted", name: "Counted", activate(plugin) {
      plugin.registerPanel({ id: "agents-probe", label: "Agents", order: 1, stageButton: true, useBadge: () => count, Component: () => <div>agents</div> });
    } };
    renderApp(undefined, { extensions: [counted] });
    const stage = await showStage();
    fireEvent.click(within(stage).getByRole("button", { name: "Agents" }));
    const tab = await within(stage).findByRole("tab", { name: /Agents/ });
    expect(tab.querySelector(".stage-tab-badge")?.textContent).toBe("3");
    count = 0;
    expect(count).toBe(0);
  });

  it("follows a panel's redirect from the strip instead of opening the panel", async () => {
    let redirected = 0;
    const elsewhere: DesktopExtension = { id: "test.elsewhere", name: "Elsewhere", activate(plugin) {
      plugin.registerPanel({ id: "here", label: "Here", order: 1, stageButton: true, redirect: () => false, Component: () => <div>here panel</div> });
      plugin.registerPanel({ id: "away", label: "Away", order: 2, stageButton: true, redirect: () => { redirected += 1; return true; }, Component: () => <div>away panel</div> });
    } };
    renderApp(undefined, { extensions: [elsewhere] });
    const stage = await showStage();
    expect(await screen.findByText("here panel")).toBeTruthy();
    fireEvent.click(within(stage).getByRole("button", { name: "Away" }));
    expect(redirected).toBe(1);
    expect(screen.queryByText("away panel")).toBeNull();
  });

  it("opens a document beside a tool as another tab, and a tool opened later in front", async () => {
    renderApp(undefined, { extensions: [tools] });
    const stage = await showStage();
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Tree/ }));
    fireEvent.click(await within(stage).findByRole("button", { name: "Pick a.ts" }));
    await waitFor(() => expect(within(stage).getByRole("tab", { name: /a\.ts/ }).getAttribute("aria-selected")).toBe("true"));
    // The toggle opened the first tool; Tree and the file joined it.
    expect(within(stage).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Browser", "Tree", "a.ts"]);
  });

  it("gives the stage about half the window by default, the chat what is left, and keeps a dragged width", async () => {
    setWindowWidth(1600);
    const files: DesktopExtension = { id: "test.files", name: "File opener", activate(plugin) {
      plugin.registerCommand({ id: "test.open-file", label: "Open the fixture file", group: "Test", run: (actions) => actions.openFile("/project/notes.txt") });
    } };
    const view = renderApp(undefined, { extensions: [rail, files] });
    await runPaletteCommand("Open the fixture file");
    await screen.findByRole("region", { name: "Stage" });
    const center = view.container.querySelector(".workbench-center") as HTMLElement;
    // 1600 − 248 sidebar (the design's) − 800 for the stage.
    expect(center.style.getPropertyValue("--chat-width")).toBe("552px");
    const divider = screen.getByRole("separator", { name: "Resize chat" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(center.style.getPropertyValue("--chat-width")).toBe("568px");
    expect(view.storage.get("tau:chat-width")).toBe("568");
  });

  it("maximizes the stage when the divider is pushed past the chat's minimum", async () => {
    setWindowWidth(1440);
    const view = renderApp(undefined, { extensions: [tools] });
    const stage = await showStage();
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Browser/ }));
    const divider = await screen.findByRole("separator", { name: "Resize chat" });
    fireEvent.keyDown(divider, { key: "Home" });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    await waitFor(() => expect(view.container.querySelector(".workbench-center")?.className).toContain("conversation-folded"));
    expect(await screen.findByRole("navigation", { name: "Conversation" })).toBeTruthy();
  });

  it("draws a drawer panel below the conversation from its tool, resizes it and keeps the height for this client", async () => {
    const view = renderApp(undefined, { extensions: [panels] });
    const stage = await showStage();
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Shell/ }));
    const drawer = await screen.findByRole("region", { name: "Shell" });
    expect(within(drawer).getByText("shell drawer")).toBeTruthy();
    expect(drawer.style.height).toBe("280px");

    const handle = within(drawer).getByRole("separator", { name: "Resize Shell drawer" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(drawer.style.height).toBe("296px");
    expect(view.storage.get("tau:drawer-height")).toBe("296");
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientY: 700 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));
    expect(drawer.style.height).toBe("180px");

    // Its tool closes it again.
    fireEvent.click(within(stage).getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Shell/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Shell" })).toBeNull());
  });

  it("opens a drawer panel from openPanel, and maximizes it into the stage", async () => {
    let open: ((id: string) => void) | undefined;
    const opener: DesktopExtension = { id: "test.opener", name: "Opener", activate(plugin) {
      plugin.registerCommand({ id: "test.open-shell", label: "Open shell", group: "Test", run: (actions) => { open = actions.openPanel; actions.openPanel("shell"); } });
    } };
    const view = renderApp(undefined, { extensions: [panels, opener] });
    await screen.findByRole("button", { name: "Show stage" });
    await runPaletteCommand("Open shell");
    const drawer = await screen.findByRole("region", { name: "Shell" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Maximize Shell" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    expect(within(stage).getByText("shell drawer")).toBeTruthy();
    expect(view.container.querySelector(".workbench-drawer")).toBeNull();
    // openPanel on a maximized panel brings its tab forward rather than drawing it again.
    act(() => open?.("shell"));
    expect(screen.getAllByText("shell drawer")).toHaveLength(1);
  });

  describe("chat beside the stage", () => {
    const files: DesktopExtension = { id: "test.files", name: "File opener", activate(plugin) {
      plugin.registerCommand({ id: "test.open-file", label: "Open the fixture file", group: "Test", run: (actions) => actions.openFile("/project/notes.txt") });
      plugin.registerCommand({ id: "test.open-relative", label: "Open the fixture relatively", group: "Test", run: (actions) => actions.openFile("notes.txt") });
      plugin.registerCommand({ id: "test.open-other", label: "Open the other fixture", group: "Test", run: (actions) => actions.openFile("/project/other.txt", { pin: true }) });
    } };
    async function openFile(label = "Open the fixture file"): Promise<HTMLElement> {
      await runPaletteCommand(label);
      return screen.findByRole("region", { name: "Stage" });
    }

    it("hides the stage from the header and brings it back as it was", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      fireEvent.click(screen.getByRole("button", { name: "Hide stage" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      expect(view.container.querySelector(".workbench-center")?.className).not.toContain("stage-open");
      const stage = await showStage();
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("brings the stage back when a link opens a file, and a second link to it focuses the same tab", async () => {
      setWindowWidth(1440);
      renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      await openFile("Open the other fixture");
      fireEvent.click(screen.getByRole("button", { name: "Hide stage" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      const stage = await openFile("Open the fixture relatively");
      expect(within(stage).getAllByRole("tab", { name: /notes\.txt/ })).toHaveLength(1);
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("maximizes the stage over the centre, folding the conversation to its spine, and the spine brings the chat back", async () => {
      setWindowWidth(1728);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      const center = () => view.container.querySelector(".workbench-center")?.className ?? "";
      expect(center()).toContain("stage-open");
      fireEvent.click(within(stage).getByRole("button", { name: "Maximize stage" }));
      expect(center()).toContain("conversation-folded");
      const spine = screen.getByRole("navigation", { name: "Conversation" });
      expect(within(stage).getByRole("button", { name: "Show chat beside the stage" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(within(spine).getByRole("button", { name: "Show chat" }));
      await waitFor(() => expect(center()).toContain("stage-open"));
      expect(center()).not.toContain("conversation-folded");
      expect(screen.queryByRole("navigation", { name: "Conversation" })).toBeNull();

      // The keyboard's maximize does the same, both ways.
      pressMod("b", { altKey: true, shiftKey: true });
      await waitFor(() => expect(center()).toContain("conversation-folded"));
      pressMod("b", { altKey: true, shiftKey: true });
      await waitFor(() => expect(center()).not.toContain("conversation-folded"));
    });

    it("folds the conversation in a window too narrow for both, with nothing to restore", async () => {
      setWindowWidth(1000);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      expect(within(stage).queryByRole("button", { name: "Maximize stage" })).toBeNull();
      expect(view.container.querySelector(".workbench-center")?.className).toContain("conversation-folded");
      fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      // The header's toggle brings the stage back in front of the chat.
      expect(await showStage()).toBeTruthy();
    });
  });
});
