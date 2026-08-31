// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiTaskProgress } from "../../shared/contracts";
import { TaskProgress } from "./TaskProgress";

const progress: UiTaskProgress = {
  completed: 1,
  total: 3,
  tasks: [
    { id: 1, subject: "Inspect source", status: "completed" },
    { id: 2, subject: "Render tasks", activeForm: "rendering tasks", status: "in_progress" },
    { id: 3, subject: "Verify behavior", status: "pending" },
  ],
};

afterEach(cleanup);

describe("TaskProgress", () => {
  it("shows segmented step progress and previews the task snapshot on hover", () => {
    const view = render(<TaskProgress progress={progress} placement="dock" />);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.queryByText("Inspect source")).toBeNull();

    fireEvent.mouseEnter(view.container.querySelector(".task-progress")!);
    expect(screen.getByText("Inspect source")).toBeTruthy();
    expect(screen.getByText("Verify behavior")).toBeTruthy();

    fireEvent.mouseLeave(view.container.querySelector(".task-progress")!);
    expect(screen.queryByText("Inspect source")).toBeNull();
  });

  it("keeps the task snapshot open when the progress control is clicked", () => {
    const view = render(<TaskProgress progress={progress} placement="dock" />);
    const section = view.container.querySelector(".task-progress")!;
    const button = screen.getByRole("button", { name: "Tasks, step 2 of 3" });

    fireEvent.click(button);
    fireEvent.mouseLeave(section);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Inspect source")).toBeTruthy();
  });
});
