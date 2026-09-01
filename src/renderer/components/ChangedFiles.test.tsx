// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangedFiles } from "./ChangedFiles";

const changes = {
  files: Array.from({ length: 7 }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    name: `file-${index + 1}.ts`,
    directory: "src",
    status: "modified" as const,
    added: index + 1,
    removed: index,
  })),
  added: 28,
  removed: 21,
};

describe("ChangedFiles", () => {
  it("starts collapsed with a bounded inline file preview", () => {
    const view = render(<ChangedFiles changes={changes} onOpenDiff={vi.fn()} />);

    expect(view.container.querySelector(".changed-files-header")?.getAttribute("aria-expanded")).toBe("false");
    expect(Array.from(view.container.querySelectorAll(".changed-file-pill")).map((pill) => pill.textContent)).toEqual([
      "file-1.ts", "file-2.ts", "file-3.ts",
    ]);
    expect(view.container.querySelector(".changed-files-more")?.textContent).toBe("+4 more");
    expect(view.container.querySelectorAll("[data-file-icon='code']")).toHaveLength(3);
    expect(view.container.querySelector(".changed-files-list")).toBeNull();
  });

  it("reveals the existing file list when expanded", () => {
    const view = render(<ChangedFiles changes={changes} onOpenDiff={vi.fn()} />);
    fireEvent.click(view.container.querySelector(".changed-files-header")!);

    expect(view.container.querySelector(".changed-files-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".changed-files-preview")).toBeNull();
    expect(view.container.querySelector(".changed-files-list")).not.toBeNull();
  });

  it("renders a card when coverage is partial even with no listed files", () => {
    const view = render(<ChangedFiles
      changes={{
        files: [],
        fileCount: 0,
        added: 0,
        removed: 0,
        completeness: "partial",
        incompleteReason: "Snapshot coverage is partial: file-count limit.",
        omittedFileCount: 4,
      }}
      onOpenDiff={vi.fn()}
    />);

    expect(view.container.querySelector(".transcript-card")).not.toBeNull();
    expect(view.getByText(/file-count limit/)).toBeTruthy();
    expect(view.getByText(/4 files omitted/)).toBeTruthy();
  });

  it("keeps a verified no-change checkpoint actionable for restore", () => {
    const onRestore = vi.fn();
    const view = render(<ChangedFiles
      changes={{ files: [], fileCount: 0, added: 0, removed: 0 }}
      onOpenDiff={vi.fn()}
      onRestore={onRestore}
    />);

    fireEvent.click(view.getByText("Restore"));
    expect(onRestore).toHaveBeenCalledOnce();
  });
});
