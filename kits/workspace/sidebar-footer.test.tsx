// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartColumn, GitPullRequest } from "lucide-react";
import type { DesktopExtension } from "tau";
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
