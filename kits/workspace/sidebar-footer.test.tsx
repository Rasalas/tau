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
    expect(footer.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Settings", "Pull requests", "Usage"]);
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
    // The sidebar stays, and its foot leads with Back and marks the page.
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
    expect(footer.getByRole("button", { name: "Reports" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(page).getByRole("button", { name: "Open item" }));
    expect(await within(page).findByText("Item 7", { selector: "p" })).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Item 7" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await within(page).findByText("All items")).toBeTruthy();

    fireEvent.click(footer.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Reports" })).toBeNull());
    expect(footer.queryByRole("button", { name: "Back" })).toBeNull();
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
    fireEvent.click(footer.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    // Settings opened over the page; closing it shows the page again.
    expect(await screen.findByRole("region", { name: "Reports" })).toBeTruthy();
  });
});
