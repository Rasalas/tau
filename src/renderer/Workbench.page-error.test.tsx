// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension } from "./extension-system";
import { renderApp } from "./test-support/render-app";

const pageModule = vi.hoisted(() => ({ fail: true }));

// The page screen's chunk, failing the way a module that throws while loading does.
vi.mock("./pages/AppPageScreen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pages/AppPageScreen")>();
  return {
    get AppPageScreen() {
      if (pageModule.fail) throw new Error("page screen broke");
      return actual.AppPageScreen;
    },
  };
});

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const probe: DesktopExtension = {
  id: "test.page-error",
  name: "Page probe",
  activate(plugin) {
    plugin.registerPage({ id: "probe", label: "Probe", Component: () => <p>Probe page</p> });
    plugin.registerSidebar({ id: "opener", Component: ({ actions }) => <button type="button" onClick={() => actions.openPage?.("probe")}>Open probe</button> });
  },
};

describe("a page whose chunk fails", () => {
  it("shows its card where the page sits, and Retry loads the chunk again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderApp(undefined, { extensions: [probe] });
    fireEvent.click(screen.getByRole("button", { name: "Open probe" }));

    const card = await screen.findByRole("alert");
    expect(card.textContent).toContain("This page failed to load.");
    expect(card.textContent).toContain("page screen broke");
    // In the page's own section, not a bare cell of the shell's grid.
    expect(card.parentElement?.matches("section.app-page")).toBe(true);
    expect(card.parentElement?.parentElement?.classList.contains("app-shell")).toBe(true);
    expect(card.closest(".sidebar-slot")).toBeNull();

    pageModule.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Probe page")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
