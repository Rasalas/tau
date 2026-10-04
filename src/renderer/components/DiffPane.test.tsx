// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { DiffPane } from "./DiffPane";

afterEach(cleanup);

it("reports a failed initial diff read", async () => {
  render(<DiffPane path="a.ts" mode="unified" loadDiff={async () => { throw new Error("Workspace is unavailable."); }} />);
  expect(await screen.findByText("Workspace is unavailable.")).toBeTruthy();
});

it("discards an old file's next hunk page after another file is opened", async () => {
  let finishPage!: (diff: UiFileDiff) => void;
  const loadDiff = vi.fn(async (path: string, options?: { hunkOffset?: number }): Promise<UiFileDiff> => {
    if (options?.hunkOffset) return new Promise<UiFileDiff>((resolve) => { finishPage = resolve; });
    return { path, added: 1, removed: 0, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added", newLine: 1, text: path }] }], ...(path === "a.ts" ? { truncated: true, nextHunkOffset: 40 } : {}) };
  });
  const { rerender } = render(<DiffPane path="a.ts" mode="unified" loadDiff={loadDiff} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more diff hunks" }));
  rerender(<DiffPane path="b.ts" mode="unified" loadDiff={loadDiff} />);
  await screen.findByRole("button", { name: "Collapse b.ts" });
  await act(async () => { finishPage({ path: "a.ts", added: 99, removed: 0, hunks: [], truncated: true, nextHunkOffset: 80 }); });
  expect(screen.queryByText("+99")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more diff hunks" })).toBeNull();
  expect(loadDiff).toHaveBeenCalledWith("b.ts", { hunkLimit: 40 });
});
