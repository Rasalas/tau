// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningTurn } from "../../src/renderer/test-support/kit-harness.js";
import { ProjectSwitcherPopover } from "./navigation.js";

afterEach(cleanup);

describe("ProjectSwitcherPopover", () => {
  it("closes on Escape during a running turn and stops nothing", () => {
    const { abort } = runningTurn();
    function Chat() {
      const [open, setOpen] = useState(true);
      // `flushSync`: a browser commits the close before the window's listener runs.
      return <main data-keybinding-context="chat">
        <textarea aria-label="Composer" />
        <ProjectSwitcherPopover open={open} projects={[{ name: "tau", path: "/repos/tau", lastOpenedAt: 1 }]} onClose={() => flushSync(() => setOpen(false))} onSelect={() => {}} />
      </main>;
    }
    const view = render(<Chat />);
    const search = screen.getByRole("textbox", { name: "Search projects" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch project" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    // Open while the keyboard is back in the composer: Escape still closes it first.
    view.unmount();
    render(<Chat />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch project" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("opens as a searchable anchored switcher", () => {
    const onSelect = vi.fn();
    render(<ProjectSwitcherPopover
      activePath="/repos/tau"
      open
      projects={[
        { name: "tau", path: "/repos/tau", lastOpenedAt: 2 },
        { name: "satchel", path: "/repos/satchel", lastOpenedAt: 1 },
      ]}
      onClose={() => {}}
      onSelect={onSelect}
    />);

    expect(screen.getByRole("dialog", { name: "Switch project" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "stch" } });
    expect(screen.queryByText("tau")).toBeNull();
    fireEvent.click(screen.getByText("satchel"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "/repos/satchel" }));
  });

  it("marks project as current when activePath is a worktree or subpath", () => {
    render(<ProjectSwitcherPopover
      activePath="/repos/tau/nested-worktree"
      open
      projects={[
        { name: "tau", path: "/repos/tau", lastOpenedAt: 2 },
        { name: "satchel", path: "/repos/satchel", lastOpenedAt: 1 },
      ]}
      onClose={() => {}}
      onSelect={() => {}}
    />);

    expect(screen.getByText("current")).toBeTruthy();
  });
});

describe("ProjectSwitcherPopover as the rail's project filter", () => {
  const projects = [
    { name: "tau", path: "/repos/tau", lastOpenedAt: 2 },
    { name: "satchel", path: "/repos/satchel", lastOpenedAt: 1 },
  ];

  it("leads with All projects, checks the shown one, and picks from the keyboard", () => {
    const all = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectSwitcherPopover
      label="Filter by project"
      open
      projects={projects}
      all={{ label: "All projects", onSelect: all }}
      selectedName="satchel"
      onClose={() => {}}
      onSelect={onSelect}
    />);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(["All projects", "tau", "satchel"]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(screen.queryByText("current")).toBeNull();
    // The shown project is where the keyboard starts.
    expect(options[2]!.getAttribute("aria-selected")).toBe("true");
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(all).toHaveBeenCalledOnce();
    // A query hides the row for every project.
    fireEvent.change(search, { target: { value: "sat" } });
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["satchel"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "satchel" }));
  });

  it("opens a project's settings from its row and draws its footer", () => {
    const onSettings = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectSwitcherPopover
      label="Filter by project"
      open
      projects={projects}
      all={{ label: "All projects", onSelect: () => {} }}
      onClose={() => {}}
      onSelect={onSelect}
      onSettings={onSettings}
      footer={<button type="button">Add project…</button>}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Project settings for tau" }));
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ path: "/repos/tau" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add project…" })).toBeTruthy();
  });
});
