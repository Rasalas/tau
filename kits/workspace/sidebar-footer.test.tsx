// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartColumn, GitPullRequest } from "lucide-react";
import type { DesktopExtension, PageProps } from "tau";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { setHostClient, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

describe("sidebar footer pages", () => {
  it("opens contributed commands and shows standalone pages outside Settings", async () => {
    const pullRequests = vi.fn();
    const pages: DesktopExtension = {
      id: "footer-test", name: "Footer test", activate(plugin) {
        plugin.registerSettingsPage({ id: "usage-test", label: "Usage", standalone: true, Component: () => <p>Usage totals</p> });
        plugin.registerCommand({ id: "usage-test.open", label: "Usage", group: "Test", access: "read", surfaces: ["sidebar-footer"], Icon: ChartColumn, run: (actions) => actions.openSettings("usage-test") });
        plugin.registerCommand({ id: "requests-test.open", label: "Pull requests", group: "Test", access: "read", surfaces: ["sidebar-footer"], Icon: GitPullRequest, run: pullRequests });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages] });
    const usage = await screen.findByRole("button", { name: "Usage" });
    const footer = within(view.container.querySelector(".sidebar-footer") as HTMLElement);
    expect(footer.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Pull requests", "Usage", "Settings"]);
    fireEvent.click(footer.getByRole("button", { name: "Pull requests" }));
    expect(pullRequests).toHaveBeenCalledTimes(1);
    fireEvent.click(usage);
    const page = await screen.findByRole("dialog", { name: "Usage" });
    expect(within(page).getByText("Usage totals")).toBeTruthy();
    expect(within(page).queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    fireEvent.click(within(page).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "Usage" })).toBeNull();
    fireEvent.click(footer.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).queryByRole("button", { name: "Usage" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(footer.getByRole("button", { name: "Usage" }));
    await screen.findByRole("dialog", { name: "Usage" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Usage" })).toBeNull();
  });

  it("draws a page's count on its icon and reads it out with the label", async () => {
    let count: number | undefined = 3;
    const pages: DesktopExtension = {
      id: "badge-test", name: "Badge test", activate(plugin) {
        plugin.registerPage({ id: "requests", label: "Pull requests", Icon: GitPullRequest, useBadge: () => count, Component: () => null });
        plugin.registerPage({ id: "quiet", label: "Usage", Icon: ChartColumn, useBadge: () => 0, Component: () => null });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages] });
    const requests = await screen.findByRole("button", { name: "Pull requests, 3" });
    expect(requests.querySelector(".page-badge")?.textContent).toBe("3");
    const footer = view.container.querySelector(".sidebar-footer") as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Usage" }).querySelector(".page-badge")).toBeNull();
    count = 120;
    fireEvent.click(within(footer).getByRole("button", { name: "Usage" }));
    fireEvent.click(await within(footer).findByRole("button", { name: "Back to thread" }));
    expect((await screen.findByRole("button", { name: "Pull requests, 120" })).querySelector(".page-badge")?.textContent).toBe("99+");
  });

  it("leads with a prominent page as an icon with its count, and ends with the pages' figures, a waiting update and Settings", async () => {
    let figure: { text: string; short?: string; hint?: string } | undefined;
    const install = vi.fn();
    const pages: DesktopExtension = {
      id: "foot-test", name: "Foot test", activate(plugin) {
        plugin.registerPage({ id: "usage", label: "Usage", Icon: ChartColumn, order: 20, useSummary: () => figure, Component: () => null });
        plugin.registerPage({ id: "requests", label: "Pull requests", Icon: GitPullRequest, order: 10, Component: () => null });
        plugin.registerPage({ id: "reviews", label: "Reviews", Icon: GitPullRequest, order: 30, prominent: true, useBadge: () => 4, Component: () => null });
        plugin.registerPage({
          id: "limits", label: "Limits", order: 40, Component: () => null,
          Summary: ({ actions }) => <button type="button" aria-label="Limits left" onClick={() => actions.openPage?.("limits", { section: "limits" })}>bars</button>,
        });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages], seed: (services) => services.appUpdate?.set({ version: "0.8.0", install }) });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    const reviews = await footer.findByRole("button", { name: "Reviews, 4" });
    // An icon and its badge, no label.
    expect(reviews.textContent).toBe("4");
    expect(reviews.querySelector(".page-badge")?.textContent).toBe("4");
    // Without a figure yet, the page keeps its icon at the end.
    expect(footer.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Reviews, 4", "Pull requests", "Usage", "Limits left", "Tau 0.8.0 is ready: restart to update", "Settings"]);
    const end = view.container.querySelector(".sidebar-footer-end") as HTMLElement;
    expect(within(end).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Usage", "Limits left", "Tau 0.8.0 is ready: restart to update", "Settings"]);
    fireEvent.click(footer.getByRole("button", { name: "Tau 0.8.0 is ready: restart to update" }));
    expect(install).toHaveBeenCalledTimes(1);

    figure = { text: "$12.40 · 22 · 3.1M tok", short: "$12.40", hint: "This month · $12.40 billed per token" };
    fireEvent.click(footer.getByRole("button", { name: "Pull requests" }));
    fireEvent.click(await footer.findByRole("button", { name: "Back to thread" }));
    const usage = await footer.findByRole("button", { name: "Usage: This month · $12.40 billed per token" });
    expect(usage.closest(".sidebar-footer-end")).toBeTruthy();
    expect(usage.querySelector(".sidebar-summary-full")?.textContent).toBe("$12.40 · 22 · 3.1M tok");
    expect(usage.querySelector(".sidebar-summary-short")?.textContent).toBe("$12.40");
    fireEvent.click(usage);
    expect(await screen.findByRole("region", { name: "Usage" })).toBeTruthy();
  });

  it("does not show entries from absent kits", async () => {
    const view = renderApp(undefined, { extensions: [workspaceExtension] });
    await screen.findByRole("button", { name: "Settings" });
    expect(within(view.container.querySelector(".sidebar-footer") as HTMLElement).getAllByRole("button")).toHaveLength(1);
  });
});

describe("app pages", () => {
  const Report = ({ params, navigate }: PageProps) => (
    <div>
      <p>{params.item ? `Item ${String(params.item)}` : "All items"}</p>
      <button type="button" onClick={() => navigate({ item: 7 }, { label: "Item 7" })}>Open item</button>
    </div>
  );
  const pages: DesktopExtension = {
    id: "pages-test", name: "Pages test", activate(plugin) {
      plugin.registerPage({ id: "reports", label: "Reports", Icon: ChartColumn, order: 5, Component: Report });
    },
  };

  it("opens a page beside the sidebar, steps into a view and back out, and leaves it with Back", async () => {
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages] });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    fireEvent.click(await footer.findByRole("button", { name: "Reports" }));
    const page = await screen.findByRole("region", { name: "Reports" });
    expect(within(page).getByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(await within(page).findByText("All items")).toBeTruthy();
    // The sidebar stays, and its foot is Back alone.
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
    expect(footer.getAllByRole("button").map((button) => button.textContent)).toEqual(["Back to thread"]);

    fireEvent.click(within(page).getByRole("button", { name: "Open item" }));
    expect(await within(page).findByText("Item 7", { selector: "p" })).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Item 7" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await within(page).findByText("All items")).toBeTruthy();

    fireEvent.click(footer.getByRole("button", { name: "Back to thread" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Reports" })).toBeNull());
    expect(footer.queryByRole("button", { name: "Back to thread" })).toBeNull();
    expect(footer.getByRole("button", { name: "Reports" })).toBeTruthy();
  });

  it("closes with Escape, and stays under Settings opened over it", async () => {
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages] });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    fireEvent.click(await footer.findByRole("button", { name: "Reports" }));
    await screen.findByRole("region", { name: "Reports" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Reports" })).toBeNull());

    fireEvent.click(footer.getByRole("button", { name: "Reports" }));
    await screen.findByRole("region", { name: "Reports" });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    // Settings opened over the page; closing it shows the page again.
    expect(await screen.findByRole("region", { name: "Reports" })).toBeTruthy();
  });

  it("counts as an overlay: Escape closes the page and runs no plain chord; an overlay over it closes first", async () => {
    const stop = vi.fn();
    const stopper: DesktopExtension = {
      id: "stop-test", name: "Stop test", activate(plugin) {
        plugin.registerCommand({ id: "stop-test.stop", label: "Stop", group: "Test", access: "read", run: stop });
        plugin.registerKeybinding({ keys: "escape", commandId: "stop-test.stop", when: "true" });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, pages, stopper] });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    fireEvent.click(await footer.findByRole("button", { name: "Reports" }));
    await screen.findByRole("region", { name: "Reports" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    // The palette closes; the page under it stays.
    fireEvent.keyDown(palette.querySelector("input")!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    expect(screen.getByRole("region", { name: "Reports" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Reports" })).toBeNull());
    expect(stop).not.toHaveBeenCalled();
  });

  it("draws a page's own sidebar in the thread list's place, which steers the page", async () => {
    const shown: Array<boolean | undefined> = [];
    const owned: DesktopExtension = {
      id: "owned-test", name: "Owned test", activate(plugin) {
        plugin.registerPage({
          id: "catalog", label: "Catalog", Icon: ChartColumn,
          Component: ({ params, sidebar }) => { shown.push(sidebar); return <p>{params.item ? `Item ${String(params.item)}` : "Overview"}</p>; },
          Sidebar: ({ params, navigate }) => (
            <ul aria-label="Items">
              {[1, 2].map((item) => <li key={item}><button type="button" aria-current={params.item === item ? "page" : undefined} onClick={() => navigate({ item }, { replace: true })}>Item {item}</button></li>)}
            </ul>
          ),
        });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, owned] });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    fireEvent.click(await footer.findByRole("button", { name: "Catalog" }));
    const page = await screen.findByRole("region", { name: "Catalog" });
    expect(await within(page).findByText("Overview")).toBeTruthy();
    const sidebar = await screen.findByRole("navigation", { name: "Catalog" });
    // The thread list stays mounted, out of sight, so its scroll and search survive.
    expect(view.container.querySelector(".sidebar-slot.covered .session-rail")).toBeTruthy();
    expect(shown.at(-1)).toBe(true);

    fireEvent.click(within(sidebar).getByRole("button", { name: "Item 2" }));
    expect(await within(page).findByText("Item 2")).toBeTruthy();
    expect(within(sidebar).getByRole("button", { name: "Item 2" }).getAttribute("aria-current")).toBe("page");

    const backs = within(sidebar).getAllByRole("button", { name: "Back to thread" });
    expect(backs).toHaveLength(2);
    fireEvent.click(backs[1]!);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Catalog" })).toBeNull());
    expect(screen.queryByRole("navigation", { name: "Catalog" })).toBeNull();
    expect(view.container.querySelector(".sidebar-slot.covered")).toBeNull();
  });

  it("keeps the thread list beside a page without a sidebar of its own, and tells the page", async () => {
    const shown: Array<boolean | undefined> = [];
    const plain: DesktopExtension = {
      id: "plain-test", name: "Plain test", activate(plugin) {
        plugin.registerPage({ id: "plain", label: "Plain", Icon: ChartColumn, Component: ({ sidebar }) => { shown.push(sidebar); return <p>Plain page</p>; } });
      },
    };
    const view = renderApp(undefined, { extensions: [workspaceExtension, plain] });
    const footer = within(await waitFor(() => view.container.querySelector(".sidebar-footer") as HTMLElement));
    fireEvent.click(await footer.findByRole("button", { name: "Plain" }));
    await screen.findByText("Plain page");
    expect(view.container.querySelector(".sidebar-slot.covered")).toBeNull();
    expect(shown.at(-1)).toBe(false);
  });
});
