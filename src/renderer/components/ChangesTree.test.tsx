// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiChangedFile } from "../../shared/contracts";
import { buildChangesTree, ChangesTree } from "./ChangesTree";

const files: UiChangedFile[] = [
  { path: "src/components/App.tsx", name: "App.tsx", directory: "src/components", status: "modified", added: 2, removed: 1, staged: false },
  { path: "src/index.ts", name: "index.ts", directory: "src", status: "added", added: 4, removed: 0, staged: true },
  { path: "README.md", name: "README.md", directory: "", status: "modified", added: 1, removed: 0, staged: false },
];

describe("ChangesTree", () => {
  it("groups paths into sorted expandable directories", () => {
    const tree = buildChangesTree(files);
    expect(tree.map((node) => node.path)).toEqual(["src", "README.md"]);
  });

  it("offers stage, unstage, and confirmed revert per file", () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    const onRevert = vi.fn();
    render(<ChangesTree files={files} onOpen={() => undefined} onStage={onStage} onUnstage={onUnstage} onRevert={onRevert} />);

    fireEvent.click(screen.getByRole("button", { name: "Stage src/components/App.tsx" }));
    expect(onStage).toHaveBeenCalledWith("src/components/App.tsx");
    fireEvent.click(screen.getByRole("button", { name: "Unstage src/index.ts" }));
    expect(onUnstage).toHaveBeenCalledWith("src/index.ts");
    fireEvent.click(screen.getByRole("button", { name: "Revert README.md" }));
    expect(onRevert).not.toHaveBeenCalled();
    const popover = screen.getByRole("dialog", { name: "Confirm revert README.md" });
    fireEvent.click(within(popover).getByRole("button", { name: "Revert" }));
    expect(onRevert).toHaveBeenCalledWith("README.md");
  });
});
