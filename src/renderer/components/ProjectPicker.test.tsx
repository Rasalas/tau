// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "./ProjectPicker";

const projects = Array.from({ length: 10_000 }, (_, index) => ({
  path: `/projects/${index}`,
  name: `Project ${index}`,
  lastOpenedAt: 10_000 - index,
}));

afterEach(cleanup);

describe("ProjectPicker large catalogs", () => {
  it("virtualizes 10,000 projects and preserves keyboard selection", () => {
    const onSelect = vi.fn();
    render(<ProjectPicker open projects={projects} onBrowse={() => {}} onClose={() => {}} onRemove={() => {}} onSelect={onSelect} />);
    expect(screen.getAllByRole("option").length).toBeLessThan(50);
    const input = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(projects[1]);
    fireEvent.change(input, { target: { value: "Project 9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(projects[9999]);
  });

  it("removes the selected project through the context menu or Shift+Delete", () => {
    const onRemove = vi.fn();
    render(<ProjectPicker open projects={projects.slice(0, 2)} onBrowse={() => {}} onClose={() => {}} onRemove={onRemove} onSelect={() => {}} />);

    fireEvent.contextMenu(screen.getByRole("option", { name: /Project 0/u }), { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from Tau/u }));
    expect(onRemove).toHaveBeenCalledWith(projects[0]);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search projects" }), { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Delete", shiftKey: true });
    expect(onRemove).toHaveBeenLastCalledWith(projects[1]);
  });

  it("does not offer linked worktrees as new-thread projects", () => {
    const main = { path: "/repos/tau", name: "tau", lastOpenedAt: 2 };
    const worktree = { path: "/repos/tau-worktrees/feat-input", name: "tau", lastOpenedAt: 3 };

    render(<ProjectPicker
      open
      projects={[worktree, main]}
      worktreePaths={new Set([worktree.path])}
      onBrowse={() => {}}
      onClose={() => {}}
      onRemove={() => {}}
      onSelect={() => {}}
    />);

    expect(screen.getByRole("option", { name: /\/repos\/tau$/u })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /feat-input/u })).toBeNull();
  });
});
