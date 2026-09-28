// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

describe("TitleBar (a phone's bar over its chat)", () => {
  it("goes back to the list, names the thread over its details and lends a region to extensions", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "kit.actions", placement: "title-bar", Component: () => <button>Kit action</button> });
    } });
    const onBack = vi.fn();
    const view = render(<TitleBar
      registry={registry}
      actions={{} as WorkbenchActions}
      thread={<button>Fix the rail</button>}
      details={<span>fix/rail · turn 2</span>}
      onBack={onBack}
    />);
    fireEvent.click(view.getByRole("button", { name: "Back to threads" }));
    expect(onBack).toHaveBeenCalled();
    expect(document.querySelector(".title-heading")?.textContent).toBe("Fix the railfix/rail · turn 2");
    expect(view.getByText("Kit action")).toBeTruthy();
  });

  it("keeps the first panel as its glyph and folds the rest into one More menu", async () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const files = vi.fn();
    const review = vi.fn();
    const sheets = [
      { id: "files", label: "Files", open: false, onToggle: files },
      { id: "review", label: "Review", open: false, onToggle: review },
      { id: "terminal", label: "Terminal", open: true, onToggle: vi.fn() },
    ];
    const bar = (shown: typeof sheets) => <TitleBar registry={registry} actions={{} as WorkbenchActions} sheets={shown} foldSheets />;
    const view = render(bar(sheets));
    fireEvent.click(view.getByRole("button", { name: "Files" }));
    expect(files).toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Review" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "More" }));
    const menu = await view.findByRole("menu", { name: "Panels" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Review", "false"], ["Terminal", "true"]]);
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Review" }));
    expect(review).toHaveBeenCalled();
    view.rerender(bar(sheets.slice(0, 2)));
    expect(view.queryByRole("button", { name: "More" })).toBeNull();
    expect(view.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("keeps the pinned tools' glyphs, Files and Terminal, and folds the others", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const sheet = (id: string, pinned?: boolean) => ({ id, label: id, open: false, onToggle: vi.fn(), ...(pinned ? { pinned } : {}) });
    const view = render(<TitleBar registry={registry} actions={{} as WorkbenchActions} foldSheets sheets={[sheet("Files", true), sheet("Review"), sheet("Terminal", true), sheet("Agents")]} />);
    expect(view.getByRole("button", { name: "Files" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Review" })).toBeNull();
    expect(view.getByRole("button", { name: "More" })).toBeTruthy();
  });
});
