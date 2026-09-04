// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { DiffView, diffLanguage, intralineParts } from "./DiffView";

const contextDiff: UiFileDiff = {
  path: "src/example.ts",
  added: 2,
  removed: 0,
  hunks: [
    { header: "@@ -5 +5 @@", lines: [{ kind: "added", newLine: 5, text: "const first = true;" }] },
    { header: "@@ -12 +12 @@", lines: [{ kind: "added", newLine: 12, text: "const second = true;" }] },
  ],
};

afterEach(cleanup);

describe("DiffView", () => {
  it("turns omitted context into compact, expandable rows", () => {
    const onExpandContext = vi.fn();
    render(<DiffView diff={contextDiff} mode="unified" onExpandContext={onExpandContext} />);
    const leadingGap = screen.getByRole("button", { name: "4 unchanged lines" });
    expect(screen.getByRole("button", { name: "6 unchanged lines" })).toBeTruthy();
    fireEvent.click(leadingGap);
    expect(onExpandContext).toHaveBeenCalledOnce();
  });

  it("detects file languages and isolates a one-character edit", () => {
    expect(diffLanguage("src/view.tsx")).toBe("typescript");
    expect(intralineParts("const end = ',';", "const end = ';';")).toEqual([
      { before: "const end = '", changed: ",", after: "';" },
      { before: "const end = '", changed: ";", after: "';" },
    ]);
  });

  it("renders syntax markup and intra-line change marks", async () => {
    const { container } = render(<DiffView embedded path="src/a.ts" mode="unified" diff={{
      path: "src/a.ts",
      added: 1,
      removed: 1,
      hunks: [{ header: "@@ -1 +1 @@", lines: [
        { kind: "removed", oldLine: 1, text: "const value = ',';" },
        { kind: "added", newLine: 1, text: "const value = ';';" },
      ] }],
    }} />);
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).toBeTruthy());
    expect(container.querySelectorAll(".diff-inline-change")).toHaveLength(2);
    expect(screen.getByText(",").classList.contains("diff-inline-change")).toBe(true);
    expect(screen.getByText(";").classList.contains("diff-inline-change")).toBe(true);
  });
});
