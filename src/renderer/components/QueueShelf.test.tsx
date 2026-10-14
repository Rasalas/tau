// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiQueuedMessage } from "../../shared/contracts";
import { QueueShelf, queueOrder } from "./QueueShelf";
import { TestProviders } from "../test-support/test-providers";

afterEach(cleanup);

const queued = (id: string, text: string, extra: Partial<UiQueuedMessage> = {}): UiQueuedMessage => ({ id, text, attachments: 0, ...extra });
const handlers = () => ({ onSteer: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), onMoveToFront: vi.fn(), onPlan: vi.fn() });

describe("QueueShelf", () => {
  it("draws nothing without a queue", () => {
    const { container } = render(<QueueShelf queue={[]} streaming {...handlers()} />);
    expect(container.textContent).toBe("");
  });

  it("orders the line of the queue first, then planned messages by their time", () => {
    const order = queueOrder([queued("late", "b", { deliverAt: 20 }), queued("line", "a"), queued("soon", "c", { deliverAt: 10 })]);
    expect(order.map((entry) => entry.id)).toEqual(["line", "soon", "late"]);
  });

  it("shows the next message, steers or edits it, and removes it", () => {
    const on = handlers();
    render(<QueueShelf queue={[queued("first", "after this turn"), queued("second", "and then this")]} streaming {...on} />);
    const shelf = screen.getByRole("region", { name: "Queued messages" });
    expect(within(shelf).getByText("Next · sends when the turn ends")).toBeTruthy();
    expect(within(shelf).queryByText("and then this")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button", { name: /Steer now/u }));
    expect(on.onSteer).toHaveBeenCalledWith("first");
    fireEvent.click(within(shelf).getByRole("button", { name: /^Edit$/u }));
    fireEvent.click(within(shelf).getByText("after this turn"));
    expect(on.onEdit).toHaveBeenNthCalledWith(1, "first");
    expect(on.onEdit).toHaveBeenNthCalledWith(2, "first");
    fireEvent.click(within(shelf).getByRole("button", { name: "Remove from the queue" }));
    expect(on.onRemove).toHaveBeenCalledWith("first");
  });

  it("opens the rest, where a message moves to the front, steers or leaves", () => {
    const on = handlers();
    render(<QueueShelf queue={[queued("first", "one"), queued("second", "two"), queued("third", "three")]} streaming={false} {...on} />);
    const more = screen.getByRole("button", { name: /Then 2 more/u });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".queue-shelf-row-text")?.textContent)).toEqual(["two", "three"]);
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /Move to front/u }));
    expect(on.onMoveToFront).toHaveBeenCalledWith("third");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /^Send$/u }));
    expect(on.onSteer).toHaveBeenCalledWith("second");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Remove from the queue" }));
    expect(on.onRemove).toHaveBeenCalledWith("second");
  });

  it("says when a held queue waits for the user", () => {
    render(<QueueShelf queue={[queued("first", "after the restart")]} streaming={false} held {...handlers()} />);
    expect(screen.getByText("Held · sends after your next message")).toBeTruthy();
  });

  it("shows a planned message's time and plans it for another", async () => {
    const on = handlers();
    const at = new Date();
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    render(<TestProviders><QueueShelf queue={[queued("plan", "check the build", { deliverAt: at.getTime() })]} streaming={false} {...on} /></TestProviders>);
    // The time follows the locale: "09:00", or "09:00 AM".
    expect(screen.getByText(/^Planned · .*9:00/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Change time/u }));
    const sheet = await screen.findByRole("dialog", { name: "Change the time" });
    fireEvent.click(await within(sheet).findByRole("option", { name: /Tomorrow afternoon/u }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    at.setHours(14);
    await waitFor(() => expect(on.onPlan).toHaveBeenCalledWith("plan", at.getTime()));
  });

  it("draws a wake by its label, without Edit", () => {
    const on = handlers();
    render(<QueueShelf queue={[queued("wake", "[PR] checks finished", { wake: { source: "pull-request", label: "Checks finished on #12" } })]} streaming {...on} />);
    expect(screen.getByText("Checks finished on #12")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit$/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drop this wake" }));
    expect(on.onRemove).toHaveBeenCalledWith("wake");
  });
});
