// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { DiffView } from "./DiffView";

const diff: UiFileDiff = {
  path: "src/example.ts",
  added: 2,
  removed: 0,
  hunks: [
    {
      header: "@@ -5 +5 @@",
      lines: [{ kind: "added", newLine: 5, text: "const first = true;" }],
    },
    {
      header: "@@ -12 +12 @@",
      lines: [{ kind: "added", newLine: 12, text: "const second = true;" }],
    },
  ],
};

describe("DiffView", () => {
  it("turns omitted context into compact, expandable rows", () => {
    const onExpandContext = vi.fn();
    render(<DiffView diff={diff} mode="unified" onExpandContext={onExpandContext} />);

    const leadingGap = screen.getByRole("button", { name: "4 unchanged lines" });
    expect(screen.getByRole("button", { name: "6 unchanged lines" })).toBeTruthy();
    fireEvent.click(leadingGap);
    expect(onExpandContext).toHaveBeenCalledOnce();
  });
});
