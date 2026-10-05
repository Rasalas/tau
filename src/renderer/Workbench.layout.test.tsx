// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension, PanelProps } from "./extension-system";
import { runPaletteCommand } from "./test-support/palette";
import { createFakeHostClient } from "./test-support/fake-host-client";
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
  it("places workspace context and agent frames beside chat without opening a stage tab", async () => {
    const workspace: DesktopExtension = { id: "test.workspace-area", name: "Workspace area", activate(plugin) {
      plugin.registerRegion({ id: "summary", placement: "workspace-summary", Component: () => <span>Project context</span> });
      plugin.registerRegion({ id: "preview", placement: "workspace-preview", Component: () => <span>Agent frame</span> });
      plugin.registerPanel({ id: "files", label: "Files", stageButton: true, Component: () => <span>File contents</span> });
      plugin.registerRegion({ id: "context-trigger", placement: "stage-bar", Component: ({ workspaceSummary }) => <button aria-expanded={workspaceSummary?.shown} aria-haspopup={workspaceSummary ? undefined : "dialog"} onClick={workspaceSummary?.toggle}>Project actions</button> });
    } };
    const view = renderApp(undefined, { extensions: [workspace, rail] });
    const summary = await screen.findByText("Project context");
    const preview = await screen.findByText("Agent frame");
    expect(summary.closest(".workspace-area")).toBeTruthy();
    expect(preview.closest(".workspace-area")).toBe(summary.closest(".workspace-area"));
    expect(preview.closest(".conversation-column")).toBeNull();
    expect(view.container.querySelector(".stage")).toBeNull();
    expect(view.container.querySelector(".workbench-center.stage-open")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize chat" })).toBeNull();
    expect((await screen.findByRole("button", { name: "Files" })).closest(".workspace-area-tools")).toBeTruthy();
    expect(view.container.querySelector(".thread-header .stage-tools")).toBeNull();
    const projectActions = () => screen.getByRole("button", { name: "Project actions" });
    expect(projectActions().closest(".workspace-area-tools")).toBeTruthy();
    expect(projectActions().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(projectActions());
    await waitFor(() => expect(screen.queryByText("Project context")).toBeNull());
    expect(projectActions().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(projectActions());
    await screen.findByText("Project context");
    const collapse = screen.getByRole("button", { name: "Collapse stage" });
    expect(collapse.closest(".workspace-area-tools")?.lastElementChild).toBe(collapse);
    expect(collapse.closest(".thread-header")).toBeNull();
    fireEvent.click(collapse);
    await waitFor(() => expect(view.container.querySelector(".workspace-area")).toBeNull());
    expect(projectActions().closest(".thread-header")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand stage" }));
    await screen.findByText("Project context");
    act(() => setWindowWidth(850));
    await waitFor(() => expect(screen.queryByText("Project context")).toBeNull());
    expect(view.container.querySelector(".workspace-summary-narrow")).toBeNull();
    expect(projectActions().getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.getByRole("button", { name: "Project actions" }).closest(".thread-header")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await screen.findByText("File contents");
    await waitFor(() => expect(screen.queryByText("Project context")).toBeNull());
    expect(screen.getAllByRole("button", { name: "Files" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Files" }).closest(".stage-strip")).toBeTruthy();
    act(() => setWindowWidth(1440));
    await waitFor(() => expect(projectActions().getAttribute("aria-haspopup")).toBe("dialog"));
  });

  it("leaves a projectless draft and a workspace without a contributing kit at full chat width", async () => {
    const contribution: DesktopExtension = { id: "test.empty-workspace", name: "Empty workspace", activate(plugin) {
      plugin.registerRegion({ id: "summary", placement: "workspace-summary", Component: () => <span>Workspace controls</span> });
    } };
    const view = renderApp(createFakeHostClient(), { extensions: [contribution] });
    await waitFor(() => expect(view.container.querySelector(".conversation-start")).toBeTruthy());
    expect(view.container.querySelector(".workspace-area")).toBeNull();
    expect(view.container.querySelector(".workspace-summary-narrow")).toBeNull();
    expect(screen.queryByText("Workspace controls")).toBeNull();
    view.unmount();
    const withoutKit = renderApp(undefined, { extensions: [] });
    await screen.findByRole("button", { name: "Split host snapshots & virtualize the thread list" });
    expect(withoutKit.container.querySelector(".workspace-area")).toBeNull();
  });

  it("resizes the sidebar by keyboard within its bounds and keeps the width for this client", async () => {
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

  /** Open the first available tool from the header. */
  async function showStage(): Promise<HTMLElement> {
    const toolbar = await screen.findByRole("toolbar", { name: "Tools" });
    const button = (await within(toolbar).findAllByRole("button")).find((candidate) => candidate.getAttribute("aria-label") !== "Expand stage")!;
    fireEvent.click(button);
    if (button.getAttribute("aria-label") === "More tools") {
      fireEvent.click((await screen.findAllByRole("menuitem"))[0]!);
    }
    return screen.findByRole("region", { name: "Stage" });
  }

  it("draws the tools and stage toggle in the thread header without a panel rail", async () => {
    const view = renderApp(undefined, { extensions: [rail, panels] });
    await screen.findByRole("button", { name: "More tools" });
    expect(screen.getByRole("button", { name: "Expand stage" }).hasAttribute("disabled")).toBe(true);
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

  it("keeps the stage's tools in the thread header while the stage is hidden, and in the strip while it shows (design 1k)", async () => {
    const buttons: DesktopExtension = { id: "test.buttons", name: "Buttons", activate(plugin) {
      plugin.registerPanel({ id: "shell-tab", label: "Shell tab", order: 1, stageButton: true, Component: () => <div>shell tab body</div> });
      plugin.registerPanel({ id: "other", label: "Other", order: 2, stageButton: true, Component: () => <div>other body</div> });
    } };
    renderApp(undefined, { extensions: [buttons] });
    const toolbar = await screen.findByRole("toolbar", { name: "Tools" });
    expect(toolbar.closest(".thread-header")).not.toBeNull();
    fireEvent.click(await within(toolbar).findByRole("button", { name: "Other" }));
    const stage = await screen.findByRole("region", { name: "Stage" });
    expect(await within(stage).findByText("other body")).toBeTruthy();
    expect(within(screen.getByRole("toolbar", { name: "Tools" })).queryByRole("button", { name: "Other" })).toBeNull();
    expect(within(stage).getByRole("button", { name: "Other" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("gives a panel that asks for it a button of its own, pressed while its tab is in front, and opens the stage on it", async () => {
    const buttons: DesktopExtension = { id: "test.buttons", name: "Buttons", activate(plugin) {
      plugin.registerPanel({ id: "shell-tab", label: "Shell tab", order: 1, stageButton: true, Component: () => <div>shell tab body</div> });
      plugin.registerPanel({ id: "other", label: "Other", order: 2, stageButton: true, Component: () => <div>other body</div> });
    } };
    renderApp(undefined, { extensions: [buttons] });
    const stage = await showStage();
    // The header tool opens its stage tab.
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
    // The header opened Browser; Tree and the file joined it.
    expect(within(stage).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Browser", "Tree", "a.ts"]);
  });

  it("gives the chat the design's 470 px by default, the stage the rest, and keeps a dragged width", async () => {
    setWindowWidth(1600);
    const files: DesktopExtension = { id: "test.files", name: "File opener", activate(plugin) {
      plugin.registerCommand({ id: "test.open-file", label: "Open the fixture file", group: "Test", run: (actions) => actions.openFile("/project/notes.txt") });
    } };
    const view = renderApp(undefined, { extensions: [rail, files] });
    await runPaletteCommand("Open the fixture file");
    await screen.findByRole("region", { name: "Stage" });
    const center = view.container.querySelector(".workbench-center") as HTMLElement;
    expect(center.style.getPropertyValue("--chat-width")).toBe("470px");
    const divider = screen.getByRole("separator", { name: "Resize chat" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(center.style.getPropertyValue("--chat-width")).toBe("486px");
    expect(view.storage.get("tau:chat-width")).toBe("486");
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
    // The way back is the strip's toggle.
    expect(within(stage).getByRole("button", { name: "Show chat beside the stage" })).toBeTruthy();
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
    await screen.findByRole("button", { name: "More tools" });
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

    it("collapses the stage from the right of its toolbar and restores its tabs and width", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      fireEvent.keyDown(screen.getByRole("separator", { name: "Resize chat" }), { key: "ArrowRight" });
      const center = view.container.querySelector(".workbench-center") as HTMLElement;
      const width = center.style.getPropertyValue("--chat-width");
      const collapse = screen.getByRole("button", { name: "Collapse stage" });
      expect(collapse.closest(".thread-header")).toBeNull();
      expect(collapse.closest(".stage-strip-actions")?.lastElementChild).toBe(collapse);
      expect(collapse.previousElementSibling?.getAttribute("aria-label")).toBe("Maximize stage");
      expect(collapse.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(collapse);
      await waitFor(() => expect(view.container.querySelector(".workspace-area")).toBeNull());
      const expand = screen.getByRole("button", { name: "Expand stage" });
      expect(expand.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(expand);
      const stage = await screen.findByRole("region", { name: "Stage" });
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
      expect(center.style.getPropertyValue("--chat-width")).toBe(width);
    });

    it("hides the stage from the dock toggle and brings it back as it was", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      await runPaletteCommand("Toggle dock");
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      expect(view.container.querySelector(".workbench-center")?.className).not.toContain("stage-open");
      await runPaletteCommand("Toggle dock");
      const stage = await screen.findByRole("region", { name: "Stage" });
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("brings the stage back when a link opens a file, and a second link to it focuses the same tab", async () => {
      setWindowWidth(1440);
      renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      await openFile("Open the other fixture");
      await runPaletteCommand("Toggle dock");
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      const stage = await openFile("Open the fixture relatively");
      expect(within(stage).getAllByRole("tab", { name: /notes\.txt/ })).toHaveLength(1);
      expect(within(stage).getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("collapses the conversation to its spine beside the stage, with the composer over the stage, and opens it again", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      const center = () => view.container.querySelector(".workbench-center")?.className ?? "";
      await runPaletteCommand("Collapse to spine");
      const spine = await screen.findByRole("complementary", { name: "Thread" });
      expect(center()).toContain("spine");
      expect(center()).toContain("composer-floating");
      expect(center()).toContain("conversation-folded");
      expect((view.container.querySelector("textarea") as HTMLTextAreaElement).placeholder).toBe("Say something to the thread…");
      // The strip's last button leads back too.
      expect(within(stage).getByRole("button", { name: "Show conversation" })).toBeTruthy();
      fireEvent.click(within(spine).getByRole("button", { name: "Open conversation" }));
      await waitFor(() => expect(center()).toContain("stage-open"));
      expect(center()).not.toContain("spine");
      expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull();
    });

    it("keeps the spine across a restart, and drops it with the stage", async () => {
      setWindowWidth(1440);
      const storage = createMemoryStorage();
      const first = renderApp(undefined, { extensions: [rail, files], storage });
      await openFile();
      await runPaletteCommand("Collapse to spine");
      await screen.findByRole("complementary", { name: "Thread" });
      expect(storage.get("tau:spine")).toBe("true");
      first.unmount();
      // A restart: the stage opens later than the first paint, and the choice is still the user's.
      const second = renderApp(undefined, { extensions: [rail, files], storage });
      await openFile();
      expect(second.container.querySelector(".workbench-center")?.className).toContain("spine");
      fireEvent.click(await screen.findByRole("button", { name: "Open conversation" }));
      await waitFor(() => expect(storage.get("tau:spine")).toBe("false"));
    });

    it("maximizes the stage over the whole centre, with no strip for the chat, and its toggle brings the chat back", async () => {
      setWindowWidth(1728);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      const center = () => view.container.querySelector(".workbench-center")?.className ?? "";
      expect(center()).toContain("stage-open");
      fireEvent.click(within(stage).getByRole("button", { name: "Maximize stage" }));
      expect(center()).toContain("conversation-folded");
      expect(screen.queryByRole("navigation", { name: "Conversation" })).toBeNull();
      // The stage is the centre's only child in the flow; the chat stays mounted out of sight.
      expect(view.container.querySelector(".workbench-center > .conversation-column")).not.toBeNull();

      fireEvent.click(within(stage).getByRole("button", { name: "Show chat beside the stage" }));
      await waitFor(() => expect(center()).toContain("stage-open"));
      expect(center()).not.toContain("conversation-folded");

      // The keyboard's maximize does the same, both ways.
      pressMod("b", { altKey: true, shiftKey: true });
      await waitFor(() => expect(center()).toContain("conversation-folded"));
      pressMod("b", { altKey: true, shiftKey: true });
      await waitFor(() => expect(center()).not.toContain("conversation-folded"));
    });

    it("restores chat with one click after a maximized stage becomes narrow", async () => {
      setWindowWidth(1440);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      fireEvent.click(within(stage).getByRole("button", { name: "Maximize stage" }));
      act(() => setWindowWidth(900));
      fireEvent.click(within(stage).getByRole("button", { name: "Show chat beside the stage" }));
      await waitFor(() => expect(view.container.querySelector(".workbench-center")?.className).not.toContain("conversation-folded"));
      expect(screen.queryByRole("region", { name: "Stage" })).toBeNull();
    });

    it("keeps chat and stage side by side in a window short of the chat's 380 px, the chat narrower", async () => {
      setWindowWidth(970);
      const view = renderApp(undefined, { extensions: [rail, files] });
      await openFile();
      const center = view.container.querySelector(".workbench-center") as HTMLElement;
      expect(center.className).toContain("stage-open");
      expect(center.className).not.toContain("conversation-folded");
      // 970 − 248 sidebar − 360 for the stage.
      expect(center.style.getPropertyValue("--chat-width")).toBe("362px");
    });

    it("shows one of the two in a window too narrow for both, with nothing to restore", async () => {
      setWindowWidth(900);
      const view = renderApp(undefined, { extensions: [rail, files] });
      const stage = await openFile();
      expect(within(stage).queryByRole("button", { name: "Maximize stage" })).toBeNull();
      expect(view.container.querySelector(".workbench-center")?.className).toContain("conversation-folded");
      fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Stage" })).toBeNull());
      // Opening the file brings the stage back in front of the chat.
      expect(await openFile()).toBeTruthy();
    });
  });
});
