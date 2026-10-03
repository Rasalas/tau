// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiQueuedMessage } from "../../shared/contracts";
import { QueuedMessages } from "./QueuedMessages";

afterEach(cleanup);

const queued = (id: string, text: string, files = 0): UiQueuedMessage => ({ id, text, attachments: files });

describe("QueuedMessages", () => {
  it("draws nothing without a queue", () => {
    const { container } = render(<QueuedMessages queue={[]} streaming onSteer={vi.fn()} onReturn={vi.fn()} onReorder={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("sends one now, returns one to the composer and reorders them", () => {
    const onSteer = vi.fn();
    const onReturn = vi.fn();
    const onReorder = vi.fn();
    render(<QueuedMessages queue={[queued("first", "after this turn"), queued("second", "and then this", 2)]} streaming onSteer={onSteer} onReturn={onReturn} onReorder={onReorder} />);
    const rows = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["after this turn", "and then this"]);
    expect(rows[1]!.textContent).toContain("2 attachments");

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Send now" }));
    expect(onSteer).toHaveBeenCalledWith("second");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Cancel and return to the composer" }));
    expect(onReturn).toHaveBeenCalledWith("first");

    fireEvent.keyDown(within(rows[0]!).getByRole("button", { name: /Reorder queued message 1/u }), { key: "ArrowDown", altKey: true });
    expect(onReorder).toHaveBeenCalledWith("first", 1);
    fireEvent.pointerDown(within(rows[1]!).getByRole("button", { name: /Reorder queued message 2/u }));
    fireEvent.dragStart(rows[1]!, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    fireEvent.dragOver(rows[0]!, { dataTransfer: { dropEffect: "" } });
    fireEvent.drop(rows[0]!, { dataTransfer: {} });
    expect(onReorder).toHaveBeenLastCalledWith("second", 0);
  });

  it("moves messages with visible buttons and disables moves past either end", () => {
    const onReorder = vi.fn();
    render(<QueuedMessages queue={[queued("first", "first task"), queued("second", "second task"), queued("third", "third task")]} streaming onSteer={vi.fn()} onReturn={vi.fn()} onReorder={onReorder} />);
    const rows = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem");
    const firstUp = within(rows[0]!).getByRole<HTMLButtonElement>("button", { name: "Move queued message up" });
    const lastDown = within(rows[2]!).getByRole<HTMLButtonElement>("button", { name: "Move queued message down" });
    expect(firstUp.disabled).toBe(true);
    expect(lastDown.disabled).toBe(true);
    fireEvent.click(firstUp);
    fireEvent.click(lastDown);
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Move queued message up" }));
    expect(onReorder).toHaveBeenLastCalledWith("second", 0);
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Move queued message down" }));
    expect(onReorder).toHaveBeenLastCalledWith("second", 2);
  });

  it("says when a restored or stopped queue waits for the user", () => {
    render(<QueuedMessages queue={[queued("first", "after the restart")]} streaming={false} held onSteer={vi.fn()} onReturn={vi.fn()} onReorder={vi.fn()} />);
    expect(screen.getByRole("listitem").textContent).toContain("Held");
  });
});
