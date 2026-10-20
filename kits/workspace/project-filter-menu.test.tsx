// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFilterMenu } from "./project-filter-menu.js";
import { NO_PROJECT, type RailProjectFilter, type SavedProjectGroup } from "./project-filter.js";

afterEach(cleanup);
const projects = [{ name: "Tau", path: "/tau", workspaceId: "ws1_tau", lastOpenedAt: 1 }, { name: "Website", path: "/site", workspaceId: "ws1_site", lastOpenedAt: 2 }];
const groups = [{ id: "product", name: "Product", projects: ["ws1_tau", "ws1_site"] }];
function menu(initial: RailProjectFilter = ["ws1_tau"], saved: readonly SavedProjectGroup[] = groups) {
  const change = vi.fn(), save = vi.fn(() => true), close = vi.fn();
  function Host() {
    const [filter, setFilter] = useState<RailProjectFilter>(initial);
    return <ProjectFilterMenu filter={filter} projects={projects} groups={saved} onChange={(next) => { setFilter(next); change(next); }} onClose={close} onSave={save} onRemove={() => {}} />;
  }
  render(<Host />);
  return { change, save, close };
}

describe("project filter menu", () => {
  it("keeps normal project and saved-group choices free of checkboxes", () => {
    const { change, close } = menu(groups[0]!.projects);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Website" }));
    expect(change).toHaveBeenLastCalledWith(["ws1_site"]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("enters selection with Ctrl-click, keeps the first project, and saves without changing an existing group", () => {
    const { change, save } = menu(["ws1_tau"], []);
    fireEvent.click(screen.getByRole("option", { name: "Website" }), { ctrlKey: true });
    expect(change).toHaveBeenLastCalledWith(["ws1_tau", "ws1_site"]);
    expect(screen.getByRole("checkbox", { name: "Tau" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), { target: { value: "Release" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Enter" });
    expect(save).toHaveBeenCalledWith("Release", ["ws1_tau", "ws1_site"], undefined);
  });

  it("offers multi-selection without modifiers, supports projectless selection and keeps focus while typing", async () => {
    const { change } = menu(["ws1_tau"]);
    fireEvent.click(screen.getByRole("button", { name: /Select multiple/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "No project" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "No project" }));
    expect(change).toHaveBeenLastCalledWith(["ws1_tau", NO_PROJECT]);
    const search = screen.getByRole("textbox", { name: "Search projects" }); search.focus();
    fireEvent.change(search, { target: { value: "web" } });
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Tau" })).toBeNull());
    expect(screen.getByRole("option", { name: "Product" })).toBeTruthy();
    expect(document.activeElement).toBe(search);
  });

  it("lets a keyboard user add a highlighted project with Ctrl+Enter", () => {
    const { change } = menu();
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "Website" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    // Search also finds Product by its member Website, so move until Website is highlighted.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.querySelector('.rail-project-entry.highlighted [aria-label="Website"]')).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter", ctrlKey: true });
    expect(change).toHaveBeenLastCalledWith(["ws1_tau", "ws1_site"]);
  });

  it("selects a searched group with Enter instead of landing on its section label", () => {
    const { change, close } = menu();
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "Product" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith(["ws1_tau", "ws1_site"]);
    expect(close).toHaveBeenCalledOnce();
  });
});
