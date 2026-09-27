// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension, PanelProps } from "./extension-system";
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
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("256px");
    expect(handle.getAttribute("aria-valuemin")).toBe("208");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("272px");
    expect(view.storage.get("tau:sidebar-width")).toBe("272");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("208px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(shell(view.container).style.getPropertyValue("--sidebar-width")).toBe("256px");

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 256 }));
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

  it("maximizes the dock's panel into a stage tab and back, keeping its state", async () => {
    const view = renderApp(undefined, { extensions: [panels] });
    fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Count 0" }));
    expect(screen.getByTestId("counter-place").textContent).toBe("dock:active");

    pressMod("b", { altKey: true, shiftKey: true });
    const stage = await screen.findByRole("region", { name: "Stage" });
    await waitFor(() => expect(within(stage).getByRole("button", { name: "Count 1" })).toBeTruthy());
    expect(within(stage).getByRole("tab", { name: /Counter/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("counter-place").textContent).toBe("stage:active");
    // Never drawn twice: the dock let it go and closed.
    expect(view.container.querySelector(".instrument-dock .panel-stage")).toBeNull();
    expect(screen.getByRole("button", { name: "Counter" }).className).toContain("on-stage");

    pressMod("b", { altKey: true, shiftKey: true });
    await waitFor(() => expect(view.container.querySelector(".instrument-dock .panel-stage")).not.toBeNull());
    expect(within(view.container.querySelector(".instrument-dock") as HTMLElement).getByRole("button", { name: "Count 1" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Stage" })).toBeNull();
    expect(screen.getByTestId("counter-place").textContent).toBe("dock:active");
  });

  it("offers the maximize button only on a panel that declares it, and closing the tab puts the panel back", async () => {
    renderApp(undefined, { extensions: [panels] });
    fireEvent.click(await screen.findByRole("button", { name: "Fixed" }));
    await screen.findByText("fixed panel");
    expect(screen.queryByRole("button", { name: /^Maximize / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Counter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Maximize Counter" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    fireEvent.click(within(stage).getByRole("button", { name: "Close Counter" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Counter" }));
    expect(await screen.findByRole("button", { name: "Count 0" })).toBeTruthy();
  });

  it("brings a maximized panel's tab forward from the rail and pins the chat as the first tab", async () => {
    renderApp(undefined, { extensions: [panels] });
    fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Maximize Counter" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    const tabs = within(stage).getAllByRole("tab");
    expect(tabs[0]?.textContent).toContain("Chat");
    fireEvent.click(tabs[0]!);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Counter" }));
    await waitFor(() => expect(screen.getByTestId("counter-place").textContent).toBe("stage:active"));
    expect(screen.getAllByRole("button", { name: /^Count / })).toHaveLength(1);

    fireEvent.click(within(stage).getByRole("button", { name: "Show chat beside the stage" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
    expect(screen.getByTestId("counter-place").textContent).toBe("dock:active");
  });

  it("opens a wide tool beside the chat, and takes it into the tabs behind a document opened later", async () => {
    const view = renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Browser" }));
    const side = await screen.findByRole("region", { name: "Browser" });
    expect(side.className).toBe("side-panel");
    expect(view.container.querySelector(".workbench-center")?.className).toContain("wide-open");
    expect(shell(view.container).className).toContain("dock-closed");

    fireEvent.click(within(side).getByRole("button", { name: "Open a.ts" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    await waitFor(() => expect(view.container.querySelector(".workbench-center")?.className).not.toContain("wide-open"));
    const tabs = within(stage).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Browser", "a.ts"]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    // Beside the chat, not maximized: no chat tab.
    expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
    fireEvent.click(tabs[0]!);
    expect(within(stage).getByRole("button", { name: "Open a.ts" })).toBeTruthy();
  });

  it("opens a wide tool as the tab in front while the stage is open, never over it", async () => {
    const view = renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick a.ts" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await waitFor(() => expect(within(stage).getByRole("tab", { name: /Browser/ }).getAttribute("aria-selected")).toBe("true"));
    expect(view.container.querySelector(".workbench-center")?.className).not.toContain("wide-open");
    expect(view.container.querySelector(".workbench-center")?.className).not.toContain("compact");
    expect(view.container.querySelector(".side-panel:not([hidden])")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Open a.ts" })).toHaveLength(1);
    // The rail brings its tab forward again from behind the file.
    fireEvent.click(within(stage).getByRole("tab", { name: /a\.ts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await waitFor(() => expect(within(stage).getByRole("tab", { name: /Browser/ }).getAttribute("aria-selected")).toBe("true"));
  });

  it("keeps a wide tool's tab beside the documents when the maximized stage is put back", async () => {
    renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick a.ts" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(await within(stage).findByRole("button", { name: "Maximize stage" }));
    expect(within(stage).getByRole("tab", { name: "Chat" })).toBeTruthy();
    fireEvent.click(within(stage).getByRole("button", { name: "Show chat beside the stage" }));
    await waitFor(() => expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull());
    expect(within(stage).getByRole("tab", { name: /Browser/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(stage).getByRole("tab", { name: /a\.ts/ })).toBeTruthy();
  });

  it("follows a panel's redirect from the rail instead of opening the panel", async () => {
    let redirected = 0;
    const elsewhere: DesktopExtension = { id: "test.elsewhere", name: "Elsewhere", activate(plugin) {
      plugin.registerPanel({ id: "away", label: "Away", order: 1, redirect: () => { redirected += 1; return true; }, Component: () => <div>away panel</div> });
      plugin.registerPanel({ id: "here", label: "Here", order: 2, redirect: () => false, Component: () => <div>here panel</div> });
    } };
    renderApp(undefined, { extensions: [elsewhere] });
    fireEvent.click(await screen.findByRole("button", { name: "Away" }));
    expect(redirected).toBe(1);
    expect(screen.queryByText("away panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Here" }));
    expect(await screen.findByText("here panel")).toBeTruthy();
  });

  it("floats a list over the chat until a document opens, then docks it beside the document", async () => {
    const view = renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
    await screen.findByRole("button", { name: "Pick a.ts" });
    expect(shell(view.container).className).toContain("dock-overlay");
    expect(shell(view.container).style.getPropertyValue("--dock-width")).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Pick a.ts" }));
    await screen.findByRole("region", { name: "Stage" });
    await waitFor(() => expect(shell(view.container).className).not.toContain("dock-overlay"));
    expect(shell(view.container).style.getPropertyValue("--dock-width")).toBe("320px");
  });

  it("closes a floating list when the chat is clicked", async () => {
    const view = renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
    await screen.findByRole("button", { name: "Pick a.ts" });
    fireEvent.pointerDown(view.container.querySelector(".conversation-column") as HTMLElement);
    await waitFor(() => expect(shell(view.container).className).not.toContain("dock-overlay"));
  });

  it("maximizes the tool beside the chat when the divider is pushed past the chat's minimum", async () => {
    const view = renderApp(undefined, { extensions: [tools] });
    fireEvent.click(await screen.findByRole("button", { name: "Browser" }));
    const divider = await screen.findByRole("separator", { name: "Resize chat" });
    expect(divider.getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    const stage = await screen.findByRole("region", { name: "Stage" });
    expect(within(stage).getByRole("tab", { name: /Browser/ }).getAttribute("aria-selected")).toBe("true");
    expect(view.container.querySelector(".workbench-center")?.className).toContain("compact");
    expect(view.storage.get("tau:chat-width")).toBeNull();
  });

  it("draws a drawer panel below the conversation, resizes it and keeps the height for this client", async () => {
    const view = renderApp(undefined, { extensions: [panels] });
    // A drawer panel has a title-bar toggle, not a rail button.
    expect(screen.queryByRole("button", { name: "Shell" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Toggle Shell drawer" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Toggle Shell drawer" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Shell" })).toBeNull());
  });

  it("opens a drawer panel from openPanel, and maximizes it into the stage", async () => {
    let open: ((id: string) => void) | undefined;
    const opener: DesktopExtension = { id: "test.opener", name: "Opener", activate(plugin) {
      plugin.registerCommand({ id: "test.open-shell", label: "Open shell", group: "Test", run: (actions) => { open = actions.openPanel; actions.openPanel("shell"); } });
    } };
    const view = renderApp(undefined, { extensions: [panels, opener] });
    await screen.findByRole("button", { name: "Toggle Shell drawer" });
    pressMod("k");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("textbox", { name: "Command" }), { target: { value: "Open shell" } });
    fireEvent.keyDown(within(palette).getByRole("textbox", { name: "Command" }), { key: "Enter", bubbles: true, cancelable: true });
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
      plugin.registerCommand({ id: "test.open-other", label: "Open the other fixture", group: "Test", run: (actions) => actions.openFile("/project/other.txt", { pin: true }) });
    } };
    async function openFile(label = "Open the fixture file"): Promise<HTMLElement> {
      pressMod("k");
      const palette = await screen.findByRole("dialog", { name: "Command palette" });
      const input = within(palette).getByRole("textbox", { name: "Command" });
      fireEvent.change(input, { target: { value: label } });
      fireEvent.keyDown(input, { key: "Enter", bubbles: true, cancelable: true });
      return screen.findByRole("region", { name: "Stage" });
    }

    it("folds the dock to its rail for a file, keeps the chat beside it, and brings the dock back when the file closes", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, panels, files] });
      fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
      // Nothing open beside the chat yet: the list floats and takes no column.
      expect(shell(view.container).className).toContain("dock-overlay");
      const stage = await openFile();
      expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
      expect(shell(view.container).className).toContain("dock-closed");
      expect(shell(view.container).style.getPropertyValue("--dock-width")).toBe("0px");
      expect(view.container.querySelector(".workbench-center")?.className).not.toContain("compact");

      fireEvent.click(within(stage).getByRole("button", { name: "Close notes.txt" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      expect(shell(view.container).className).toContain("dock-overlay");
      expect(screen.getByTestId("counter-place").textContent).toBe("dock:active");
    });

    it("leaves the dock open once the user asks for it, with the chat in the first tab, until a new tab asks for room", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, panels, files] });
      fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
      const stage = await openFile();
      expect(shell(view.container).className).toContain("dock-closed");
      fireEvent.click(screen.getByRole("button", { name: "Counter" }));
      await waitFor(() => expect(shell(view.container).className).not.toContain("dock-closed"));
      expect(within(stage).getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("false");
      expect(within(stage).queryByRole("button", { name: "Maximize stage" })).toBeNull();

      await openFile("Open the other fixture");
      await waitFor(() => expect(shell(view.container).className).toContain("dock-closed"));
      expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
    });

    it("folds the dock at 1512 for the stage's reading width, and a dock the user opens stays beside the chat", async () => {
      setWindowWidth(1512);
      const view = renderApp(undefined, { extensions: [rail, panels, files] });
      fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
      const stage = await openFile();
      expect(shell(view.container).className).toContain("dock-closed");
      fireEvent.click(screen.getByRole("button", { name: "Counter" }));
      await waitFor(() => expect(shell(view.container).className).not.toContain("dock-closed"));
      expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
      expect(view.container.querySelector(".workbench-center")?.className).not.toContain("compact");
    });

    it("leaves the dock open at 1728, where the stage has its reading width beside it", async () => {
      setWindowWidth(1728);
      const view = renderApp(undefined, { extensions: [rail, panels, files] });
      fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
      await openFile();
      expect(shell(view.container).className).not.toContain("dock-closed");
      expect(shell(view.container).style.getPropertyValue("--dock-width")).toBe("320px");
    });

    it("maximizes the stage into the same tabs, the chat first, and puts the chat back beside it", async () => {
      setWindowWidth(1728);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      const center = () => view.container.querySelector(".workbench-center")?.className ?? "";
      expect(center()).not.toContain("compact");
      fireEvent.click(within(stage).getByRole("button", { name: "Maximize stage" }));
      const chat = within(stage).getByRole("tab", { name: "Chat" });
      expect(chat.getAttribute("aria-selected")).toBe("false");
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
      expect(center()).toContain("compact");
      fireEvent.click(chat);
      expect(center()).toContain("chat-focused");

      fireEvent.click(within(stage).getByRole("button", { name: "Show chat beside the stage" }));
      expect(within(stage).queryByRole("tab", { name: "Chat" })).toBeNull();
      expect(center()).not.toContain("compact");
    });

    it("maximizes a dock panel over the whole centre, and moving it back puts the chat beside the stage again", async () => {
      setWindowWidth(1728);
      renderApp(undefined, { extensions: [panels] });
      fireEvent.click(await screen.findByRole("button", { name: "Counter" }));
      fireEvent.click(await screen.findByRole("button", { name: "Maximize Counter" }));
      const stage = await screen.findByRole("region", { name: "Stage" });
      expect(within(stage).getByRole("tab", { name: "Chat" })).toBeTruthy();
      expect(within(stage).getByRole("button", { name: "Show chat beside the stage" }).getAttribute("aria-pressed")).toBe("true");
      pressMod("b", { altKey: true, shiftKey: true });
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      expect(screen.getByTestId("counter-place").textContent).toBe("dock:active");
    });

    it("keeps a window too narrow for both in tabs, with nothing to restore", async () => {
      setWindowWidth(1000);
      renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      expect(within(stage).getByRole("tab", { name: "Chat" })).toBeTruthy();
      expect(within(stage).queryByRole("button", { name: "Maximize stage" })).toBeNull();
    });
  });
});
