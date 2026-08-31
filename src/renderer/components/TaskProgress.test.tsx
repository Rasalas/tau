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
  it("shows compact progress and expands the Pi task snapshot", () => {
    render(<TaskProgress progress={progress} placement="dock" />);
    expect(screen.getByText("rendering tasks")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.queryByText("Inspect source")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/u }));
    expect(screen.getByText("Inspect source")).toBeTruthy();
    expect(screen.getByText("Verify behavior")).toBeTruthy();
  });
});
