// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiTaskProgress } from "../../shared/contracts";
import { installPointerEvents } from "../test-support/pointer-events";
import { TASK_PILL_CLOSE_DELAY_MS, TASK_PILL_OPEN_DELAY_MS, TaskPill, TaskProgress, taskSummary } from "./TaskProgress";

installPointerEvents();
afterEach(() => { cleanup(); vi.useRealTimers(); });

const progress: UiTaskProgress = {
  completed: 1,
  total: 3,
  tasks: [
    { id: 1, subject: "Inspect source", status: "completed" },
    { id: 2, subject: "Render tasks", activeForm: "rendering tasks", status: "in_progress" },
    { id: 3, subject: "Verify behavior", status: "pending" },
  ],
};

// The user's case: the first of two tasks runs, none is done.
const started: UiTaskProgress = {
  completed: 0,
  total: 2,
  tasks: [
    { id: 1, subject: "Write the file", status: "in_progress" },
    { id: 2, subject: "Check it", status: "pending" },
  ],
};

const pill = () => screen.getByRole("button", { name: /^Tasks:/u });

describe("TaskPill", () => {
  it("counts done tasks of all, as many as the bar's solid segments, and says so", () => {
    const view = render(<TaskPill progress={started} />);
    expect(pill().textContent).toBe("0/2");
    expect(pill().getAttribute("aria-label")).toBe("Tasks: 0 of 2 done, now: Write the file");
    expect(view.container.querySelectorAll(".task-progress-segments > i.completed")).toHaveLength(0);
    expect(view.container.querySelectorAll(".task-progress-segments > i.in_progress")).toHaveLength(1);
    expect(pill().classList.contains("control-pill")).toBe(true);

    view.rerender(<TaskPill progress={progress} />);
    expect(pill().textContent).toBe("1/3");
    expect(view.container.querySelectorAll(".task-progress-segments > i.completed")).toHaveLength(1);
    expect(pill().getAttribute("aria-label")).toBe("Tasks: 1 of 3 done, now: rendering tasks");

    const done = { ...progress, completed: 3, tasks: progress.tasks.map((task) => ({ ...task, status: "completed" as const })) };
    view.rerender(<TaskPill progress={done} />);
    expect(pill().textContent).toBe("3/3");
    expect(pill().getAttribute("aria-label")).toBe("Tasks: 3 of 3 done");
    expect(pill().classList.contains("done")).toBe(true);
    expect(taskSummary(started)).toBe("0 of 2 done");
  });

  it("opens the list above it on click, headed by the count in words, until Escape", async () => {
    render(<TaskPill progress={started} />);
    expect(pill().getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(pill());
    const list = await screen.findByRole("dialog", { name: "Tasks" });
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(list.querySelector(".task-progress-head")?.textContent).toBe("Tasks0 of 2 done");
    expect(list.textContent).toContain("Write the file");
    expect(list.textContent).toContain("Check it");
    // The list lives in a portal, so neither the composer nor a banner clips it.
    expect(list.closest(".region-composer-controls")).toBeNull();

    // A press that leaves the mouse on the pill keeps it open.
    fireEvent.pointerLeave(pill(), { pointerType: "mouse" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pill().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(pill());
    await screen.findByRole("dialog");
    fireEvent.click(pill());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on a resting mouse and closes after it leaves; a touch opens nothing", async () => {
    render(<TaskPill progress={progress} />);
    fireEvent.click(pill());
    await screen.findByRole("dialog");
    fireEvent.click(pill());

    vi.useFakeTimers();
    fireEvent.pointerEnter(pill(), { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(TASK_PILL_OPEN_DELAY_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.pointerEnter(pill(), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TASK_PILL_OPEN_DELAY_MS - 1); });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("dialog", { name: "Tasks" }).textContent).toContain("Verify behavior");

    fireEvent.pointerLeave(pill(), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TASK_PILL_CLOSE_DELAY_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("TaskProgress in the transcript", () => {
  it("names the current task and unfolds the snapshot on click", () => {
    render(<TaskProgress progress={progress} />);
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("rendering tasks")).toBeTruthy();
    expect(screen.queryByText("Inspect source")).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Inspect source")).toBeTruthy();
  });
});
