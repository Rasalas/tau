// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTitleMenu } from "./ThreadTitleMenu";

afterEach(cleanup);

function props() {
  return {
    title: "Improve title menu",
    label: "main",
    pinned: false,
    settled: false,
    onNewThread: vi.fn(),
    onOpenTree: vi.fn(),
    onDuplicate: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleSettled: vi.fn(),
    onRename: vi.fn(async () => true),
    commands: [{ id: "thread-titles.regenerate", label: "Regenerate title" }],
    onCommand: vi.fn(),
    onMarkUnread: vi.fn(),
    onCopy: vi.fn(),
  };
}

describe("ThreadTitleMenu", () => {
  it("opens from the title and groups the supported thread actions", () => {
    const handlers = props();
    render(<ThreadTitleMenu {...handlers} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));

    expect(screen.getByText("New thread on main")).toBeTruthy();
    expect(screen.getByText("Pin thread")).toBeTruthy();
    expect(screen.getByText("Settle thread")).toBeTruthy();
    expect(screen.getByText("Rename thread")).toBeTruthy();
    expect(screen.getByText("Regenerate title")).toBeTruthy();
    expect(screen.getByText("Mark unread")).toBeTruthy();
    expect(screen.getByText("Copy entire chat as Markdown")).toBeTruthy();
    expect(screen.getByText("Copy path")).toBeTruthy();
  });

  it("puts a destructive command last, in the danger colour", () => {
    const handlers = { ...props(), commands: [{ id: "thread.delete", label: "Delete", destructive: true }, { id: "thread.archive", label: "Archive thread" }] };
    render(<ThreadTitleMenu {...handlers} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    const items = screen.getAllByRole("menuitem");
    const last = items.at(-1)!;
    expect(last.textContent).toBe("Delete");
    expect(last.className).toContain("destructive");
    expect(items.findIndex((item) => item.textContent === "Archive thread")).toBeLessThan(items.findIndex((item) => item.textContent === "Mark unread"));
    fireEvent.click(last);
    expect(handlers.onCommand).toHaveBeenCalledWith("thread.delete");
  });

  it("renames inline without invoking title regeneration", async () => {
    const handlers = props();
    render(<ThreadTitleMenu {...handlers} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    fireEvent.click(screen.getByText("Rename thread"));
    const input = screen.getByRole("textbox", { name: "Thread title" });
    fireEvent.change(input, { target: { value: "A precise manual title" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledWith("A precise manual title"));
    expect(handlers.onCommand).not.toHaveBeenCalled();
  });

  it("dispatches pinning and copy actions", () => {
    const handlers = props();
    const view = render(<ThreadTitleMenu {...handlers} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    fireEvent.click(screen.getByText("Pin thread"));
    expect(handlers.onTogglePin).toHaveBeenCalledOnce();

    view.rerender(<ThreadTitleMenu {...handlers} pinned />);
    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    fireEvent.click(screen.getByText("Copy entire chat as Markdown"));
    expect(handlers.onCopy).toHaveBeenCalledWith("chat");

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
  });

  it("dispatches onOpenInstructions when clicked", () => {
    const handlers = { ...props(), onOpenInstructions: vi.fn() };
    render(<ThreadTitleMenu {...handlers} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    fireEvent.click(screen.getByText("Active instructions & prompt…"));
    expect(handlers.onOpenInstructions).toHaveBeenCalledOnce();
  });
});
