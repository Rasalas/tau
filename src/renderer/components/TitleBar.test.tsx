// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiWorkspaceChanges, WorkspaceInfo } from "../../shared/contracts";
import { TitleBar } from "./TitleBar";

const dirty: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1,
  removed: 0,
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    root: "/project",
    isRepo: true,
    isDirty: true,
    branch: "main",
    worktrees: [],
    refs: [],
    worktreeParent: "/worktrees",
    ...patch,
  };
}

function setup(workspaceInfo = workspace()) {
  const handlers = {
    onOpenInEditor: vi.fn(),
    onChooseEditor: vi.fn(),
    onOpenReview: vi.fn(),
    onPush: vi.fn(),
    onRunAction: vi.fn(),
    onToggleDock: vi.fn(),
  };
  render(<TitleBar
    cwd="/project"
    editors={[{ id: "code", name: "VS Code" }, { id: "zed", name: "Zed" }]}
    activeEditor={{ id: "code", name: "VS Code" }}
    changes={dirty}
    workspace={workspaceInfo}
    gitBusy={false}
    dockOpen
    {...handlers}
  />);
  return handlers;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("TitleBar actions", () => {
  it("opens the preferred editor and opens a selected editor from the split menu", () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(handlers.onOpenInEditor).toHaveBeenCalledWith("code");

    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
    expect(handlers.onChooseEditor).toHaveBeenCalledWith("zed");
    expect(handlers.onOpenInEditor).toHaveBeenCalledWith("zed");
  });

  it("chooses commit versus commit and push from upstream state", () => {
    const withoutUpstream = setup();
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(withoutUpstream.onOpenReview).toHaveBeenCalledWith(false);
    cleanup();

    const withUpstream = setup(workspace({ upstream: "origin/main" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    expect(withUpstream.onOpenReview).toHaveBeenCalledWith(true);
  });

  it("adds and runs a hidden Pi shell action", () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.change(screen.getByPlaceholderText("Test"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByPlaceholderText("!! npm test"), { target: { value: "!! npm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(handlers.onRunAction).toHaveBeenCalledWith("npm test", false, "Tests");
  });
});
