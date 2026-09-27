// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningTurn } from "../../src/renderer/test-support/kit-harness.js";
import { ProjectSwitcherPopover, RailRowAction } from "./navigation.js";

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
    render(<Chat />);
    const search = screen.getByRole("textbox", { name: "Search projects" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch project" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
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

describe("RailRowAction", () => {
  const action = {
    id: "snooze",
    label: "Snooze thread",
    icon: <i />,
    menu: () => [
      { items: [{ id: "snooze:1h", label: "In 1 hour", hint: "10:00" }, { id: "snooze:tomorrow", label: "Tomorrow", hint: "9:00" }] },
      { items: [{ id: "snooze:custom", label: "Custom…" }] },
    ],
  };
  const focused = () => document.activeElement?.textContent;

  it("walks the list from the keyboard and picks with Enter's click, without the rail seeing the keys", () => {
    const onPick = vi.fn();
    const railKeys = vi.fn();
    render(<div onKeyDown={railKeys}><RailRowAction action={action} onPick={onPick} /></div>);
    const button = screen.getByRole("button", { name: "Snooze thread" });
    button.focus();
    fireEvent.click(button, { detail: 0 });

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(focused()).toBe("In 1 hour10:00");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(focused()).toBe("Tomorrow9:00");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(focused()).toBe("Custom…");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(focused()).toBe("In 1 hour10:00");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(railKeys).not.toHaveBeenCalled();

    fireEvent.click(document.activeElement!);
    expect(onPick).toHaveBeenCalledWith("snooze:custom");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and gives focus back to its button", () => {
    render(<RailRowAction action={action} onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Snooze thread" });
    button.focus();
    fireEvent.click(button, { detail: 1 });
    // Opened by the pointer the list holds focus, not its first row.
    expect(document.activeElement?.getAttribute("role")).toBe("menu");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
