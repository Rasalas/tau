// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Message } from "./Message";

afterEach(cleanup);

describe("Message reasoning presentation", () => {
  it("keeps provider reasoning summaries out of the transcript", () => {
    const view = render(<Message message={{
      id: "assistant",
      role: "assistant",
      text: "Visible answer",
      thinking: "Internal reasoning summary",
      timestamp: 0,
    }} />);

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("Internal reasoning summary")).toBeNull();
    expect(view.container.textContent).not.toContain("thinking");
  });

  it("does not render an empty thinking placeholder", () => {
    const view = render(<Message message={{ id: "working", role: "assistant", text: "", timestamp: 0 }} />);
    expect(view.container.textContent).toBe("");
  });
});

describe("Message async activity", () => {
  it("collapses subagent completion payloads behind a compact activity row", () => {
    const payload = 'Background task completed: **workflow** Workflow completed with 2 child run(s). Return: [{"key":"review","output":"large payload"}]';
    render(<Message message={{ id: "activity", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("2 subagent runs completed")).toBeTruthy();
    expect(screen.queryByText(/large payload/)).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/large payload/)).toBeTruthy();
  });

  it("collapses subagent attention notices", () => {
    const payload = "Subagent needs attention: reviewer Run: abc Signal: reviewer has had tool grep open for 240s";
    render(<Message message={{ id: "attention", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("Subagent needs attention")).toBeTruthy();
    expect(screen.queryByText(/tool grep open/)).toBeNull();
  });
});
