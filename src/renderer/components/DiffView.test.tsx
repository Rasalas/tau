// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ROW_HEIGHT = 26;
const VIEWPORT_HEIGHT = 260;

function stubbedHeight(element: HTMLElement): number {
  if (element.classList.contains("diff-scroll") || element.classList.contains("review-diff-stream")) return VIEWPORT_HEIGHT;
  return element.classList.contains("diff-stream-row") ? ROW_HEIGHT : 0;
}

/** jsdom reports no layout. Give the virtualizer a viewport and uniform rows. */
function stubDiffLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measure(this: HTMLElement) {
    const height = stubbedHeight(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: height, width: 900, height, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function height(this: HTMLElement) {
    return stubbedHeight(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value(this: Element, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
      this.dispatchEvent(new Event("scroll"));
    },
  });
}

function largeDiff(lines: number): UiFileDiff {
  return {
    path: "src/large.ts",
    added: lines,
    removed: 0,
    hunks: [{
      header: "@@ -1 +1 @@",
      lines: Array.from({ length: lines }, (_, index) => ({ kind: "added" as const, newLine: index + 1, text: `const line${index} = ${index};` })),
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("DiffView", () => {
  it("turns omitted context into compact, expandable rows", () => {
    const onExpandContext = vi.fn();
    render(<DiffView diff={contextDiff} mode="unified" onExpandContext={onExpandContext} />);
    const leadingGap = screen.getByRole("button", { name: "4 unchanged lines" });
    expect(screen.getByRole("button", { name: "6 unchanged lines" })).toBeTruthy();
    fireEvent.click(leadingGap);
    expect(onExpandContext).toHaveBeenCalledOnce();
  });

  it("draws a package's gutter action, selection and row under a line without knowing what they are", () => {
    const onAction = vi.fn();
    const { container } = render(<DiffView path="src/example.ts" diff={contextDiff} mode="unified" lines={{
      onAction,
      selected: ({ line }) => line.newLine === 12,
      render: ({ line }) => line.newLine === 5 ? <em>kit note</em> : undefined,
    }} />);
    expect(screen.getByText("kit note").closest(".diff-line-slot")).toBeTruthy();
    expect(container.querySelectorAll(".diff-row.selected")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 12" }));
    expect(onAction).toHaveBeenCalledWith({ path: "src/example.ts", line: contextDiff.hunks[1]!.lines[0] }, { shiftKey: false });
  });

  it("draws no gutter action without a line slot", () => {
    render(<DiffView diff={contextDiff} mode="unified" />);
    expect(screen.queryByRole("button", { name: /Comment on line/ })).toBeNull();
  });

  it("detects file languages and isolates a one-character edit", () => {
    expect(diffLanguage("src/view.tsx")).toBe("typescript");
    expect(intralineParts("const end = ',';", "const end = ';';")).toEqual([
      { before: "const end = '", changed: ",", after: "';" },
      { before: "const end = '", changed: ";", after: "';" },
    ]);
  });

  it("renders syntax markup and intra-line change marks", async () => {
    const { container } = render(<DiffView path="src/a.ts" mode="unified" diff={{
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

  it("keeps only a window of a large diff in the DOM and renders rows on scroll", async () => {
    stubDiffLayout();
    const { container } = render(<DiffView path="src/large.ts" mode="unified" diff={largeDiff(600)} />);
    const scroll = container.querySelector<HTMLElement>(".diff-scroll")!;

    await waitFor(() => expect(container.querySelectorAll(".diff-stream-row").length).toBeGreaterThan(0));
    expect(container.querySelectorAll(".diff-stream-row").length).toBeLessThan(40);
    expect(container.textContent).toContain("const line0 = 0;");
    expect(container.textContent).not.toContain("const line500 = 500;");
    // The spacer keeps the scrollbar proportional to every row, not the window.
    expect(container.querySelector<HTMLElement>(".diff-stream")!.style.height).toBe(`${601 * ROW_HEIGHT}px`);

    await act(async () => {
      scroll.scrollTop = 500 * ROW_HEIGHT;
      fireEvent.scroll(scroll);
    });
    await waitFor(() => expect(container.textContent).toContain("const line500 = 500;"));
    expect(container.textContent).not.toContain("const line0 = 0;");
    expect(container.querySelectorAll(".diff-stream-row").length).toBeLessThan(40);
  });

  it("navigates through hunks on keyboard shortcuts n/p and ]c/[c", async () => {
    stubDiffLayout();
    const multiHunkDiff: UiFileDiff = {
      path: "src/multihunk.ts",
      added: 2,
      removed: 0,
      hunks: [
        { header: "@@ -10 +10 @@", lines: [{ kind: "added", newLine: 10, text: "const a = 1;" }] },
        { header: "@@ -50 +50 @@", lines: [{ kind: "added", newLine: 50, text: "const b = 2;" }] },
      ],
    };
    const { container } = render(<DiffView path="src/multihunk.ts" mode="unified" diff={multiHunkDiff} />);
    const scroll = container.querySelector<HTMLElement>(".diff-scroll")!;
    expect(scroll.tabIndex).toBe(0);

    fireEvent.keyDown(scroll, { key: "n" });
    fireEvent.keyDown(scroll, { key: "]" });
    fireEvent.keyDown(scroll, { key: "c" });
    fireEvent.keyDown(scroll, { key: "p" });
    fireEvent.keyDown(scroll, { key: "[" });
    fireEvent.keyDown(scroll, { key: "c" });
  });
});
