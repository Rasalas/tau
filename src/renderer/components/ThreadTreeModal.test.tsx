// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiThreadTree } from "../../shared/contracts";
import { ThreadTreeModal } from "./ThreadTreeModal";

const tree: UiThreadTree = {
  sessionId: "s1",
  leafId: "a2",
  nodes: [
    { id: "u1", depth: 0, kind: "user", text: "Plan the feature", timestamp: 1, onBranch: true, isLeaf: false, forkable: true },
    { id: "a1", parentId: "u1", depth: 1, kind: "assistant", text: "Sure.", label: "start", timestamp: 2, onBranch: true, isLeaf: false, forkable: false },
    { id: "u2", parentId: "a1", depth: 2, kind: "user", text: "Go on", timestamp: 3, onBranch: true, isLeaf: false, forkable: true },
    { id: "a2", parentId: "u2", depth: 3, kind: "assistant", text: "Done.", timestamp: 4, onBranch: true, isLeaf: true, forkable: false },
  ],
};

afterEach(cleanup);

describe("ThreadTreeModal", () => {
  it("navigates to an entry with the summarize choice and closes on Escape", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<ThreadTreeModal tree={tree} mode="navigate" onClose={onClose} onNavigate={onNavigate} onFork={() => {}} />);
    expect(screen.getByText("start")).toBeTruthy();
    expect((screen.getByText("Done.").closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Summarize the abandoned branch into the context"));
    fireEvent.click(screen.getByText("Sure."));
    expect(onNavigate).toHaveBeenCalledWith("a1", true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("forks only through user messages", () => {
    const onFork = vi.fn();
    render(<ThreadTreeModal tree={tree} mode="fork" onClose={() => {}} onNavigate={() => {}} onFork={onFork} />);
    expect((screen.getByText("Sure.").closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Go on"));
    expect(onFork).toHaveBeenCalledWith("u2");
    expect(screen.queryByLabelText("Summarize the abandoned branch into the context")).toBeNull();
  });
});
