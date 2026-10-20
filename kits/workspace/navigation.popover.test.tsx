// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningTurn } from "../../src/renderer/test-support/kit-harness.js";
import { ProjectSwitcherPopover, rankProjects } from "./navigation.js";

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

describe("a long project path", () => {
  it("keeps the last folder, cuts the middle, and has the whole path in its tooltip", () => {
    const path = "/Volumes/WD-Black-SN850X/tbuck/repos/_self/tau-public-worktrees/k141/tau-scratch";
    render(<ProjectSwitcherPopover
      open
      projects={[{ name: "tau-scratch", path, lastOpenedAt: 1 }]}
      onClose={() => {}}
      onSelect={() => {}}
    />);
    const small = screen.getByRole("option", { name: "tau-scratch" }).querySelector("small")!;
    const [truncated] = [...small.children] as HTMLElement[];
    expect(truncated!.getAttribute("data-tooltip")).toBe(path);
    // The head gives way with an ellipsis; the tail with its slash does not shrink.
    const [head, tail] = [...truncated!.children] as HTMLElement[];
    expect(head!.textContent).toBe(path.slice(0, -"/tau-scratch".length));
    expect(tail!.textContent).toBe("/tau-scratch");
    expect(tail!.style.flexShrink).toBe("0");
  });
});

describe("rankProjects", () => {
  const project = (name: string, path: string) => ({ name, path, lastOpenedAt: 0 });
  const projects = [project("tau-scratch", "/work/k141/tau-scratch"), project("dotfiles", "/work/k141/dotfiles"), project("shop-api", "/work/k141/shop-api"), project("sh-op", "/work/k141/sh-op")];

  it("does not match every sibling repo by the letters of their shared path", () => {
    expect(rankProjects(projects, "shop").map((entry) => entry.name)).toEqual(["shop-api", "sh-op"]);
  });

  it("still finds a project by its folder", () => {
    expect(rankProjects(projects, "k141/dot").map((entry) => entry.name)).toEqual(["dotfiles"]);
  });
});
