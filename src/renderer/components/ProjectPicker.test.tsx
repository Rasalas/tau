// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("offers / last, however recently the host started in it", () => {
    const onSelect = vi.fn();
    const withRoot = [{ path: "/", name: "/", lastOpenedAt: 99 }, ...projects.slice(0, 2)];
    render(<ProjectPicker open projects={withRoot} onBrowse={() => {}} onClose={() => {}} onRemove={() => {}} onSelect={onSelect} />);
    expect(screen.getAllByRole("option").map((option) => option.textContent?.includes("Project") ?? false)).toEqual([true, true, false]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search projects" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(projects[0]);
  });

  it("renders project icon image when available, falling back to initial", () => {
    const iconProjects = [
      { path: "/projects/with-icon", name: "IconProject", lastOpenedAt: 2, icon: "data:image/svg+xml;base64,abc" },
      { path: "/projects/no-icon", name: "TextProject", lastOpenedAt: 1 },
    ];
    const { container } = render(<ProjectPicker open projects={iconProjects} onBrowse={() => {}} onClose={() => {}} onRemove={() => {}} onSelect={() => {}} />);

    const img = container.querySelector(".project-picker-results img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("data:image/svg+xml;base64,abc");
    expect(screen.getByText("T")).toBeTruthy();
  });

  it("leads with the project in context, checked and selected, then the most recently used (K98)", async () => {
    const onSelect = vi.fn();
    const three = [
      { path: "/a", name: "alpha", lastOpenedAt: 1 },
      { path: "/b", name: "beta", lastOpenedAt: 2 },
      { path: "/c", name: "gamma", lastOpenedAt: 3, workspaceId: "ws-c" },
    ];
    const threads = [{ id: "t", path: "/t.jsonl", title: "t", modifiedAt: 50, projectPath: "/a", projectName: "alpha", messageCount: 1 }];
    render(<ProjectPicker open projects={three} threads={threads} preselect="/b" machine="Mac mini" onBrowse={() => {}} onClose={() => {}} onRemove={() => {}} onSelect={onSelect} />);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(["beta", "alpha", "gamma"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.querySelector("[aria-label=current]")).toBeTruthy();
    expect(options[0]!.textContent).toContain("Mac mini · /b");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search projects" })));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search projects" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(three[1]);
  });

  it("reaches Add project with the keyboard, and offers it when nothing matches", () => {
    const onBrowse = vi.fn();
    render(<ProjectPicker open projects={projects.slice(0, 2)} onBrowse={onBrowse} onClose={() => {}} onRemove={() => {}} onSelect={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Search projects" });
    for (let step = 0; step < 5; step += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Add project…" }).className).toContain("selected");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onBrowse).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "nothing like it" } });
    expect(screen.getByText("No matching projects")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onBrowse).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape without choosing", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectPicker open projects={projects.slice(0, 2)} onBrowse={() => {}} onClose={onClose} onRemove={() => {}} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search projects" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is a bottom sheet on touch, whose search waits for a tap", async () => {
    const onSelect = vi.fn();
    render(<ProjectPicker open sheet projects={projects.slice(0, 2)} preselect="/projects/1" onBrowse={() => {}} onClose={() => {}} onRemove={() => {}} onSelect={onSelect} />);
    const sheet = await screen.findByRole("dialog", { name: "New thread in" });
    expect(sheet.className).toContain("touch-sheet");
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Search projects" }));
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(onSelect).toHaveBeenCalledWith(projects[1]);
  });
});
