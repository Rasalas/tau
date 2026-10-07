// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { wakeMessageText } from "../../shared/message-turns";
import { Message } from "./Message";

afterEach(cleanup);

describe("a wake in the transcript", () => {
  it("is a centred note with its source and time, not the user's bubble, and opens what the agent was told", () => {
    const text = wakeMessageText({ source: "pull-request", label: "Woken by PR #42 · check smoke failed" }, "Check smoke failed on 1a2b3c.");
    const { container } = render(<Message message={{ id: "w", role: "user", text, timestamp: Date.UTC(2026, 9, 7, 9, 41) }} />);
    const note = screen.getByRole("note", { name: "Woken by PR #42 · check smoke failed" });
    expect(container.querySelector(".message.user")).toBeNull();
    expect(note.querySelector(".wake-icon")).toBeTruthy();
    expect(note.querySelector("time")).toBeTruthy();
    expect(screen.queryByText("Check smoke failed on 1a2b3c.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Check smoke failed on 1a2b3c.")).toBeTruthy();
  });

  it("draws a goal's next turn, kept as a notice, the same way", () => {
    render(<Message message={{ id: "n", role: "notice", text: wakeMessageText({ source: "goal", label: "Goal continued · turn 3" }, ""), timestamp: 1 }} />);
    expect(screen.getByRole("note", { name: "Goal continued · turn 3" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
