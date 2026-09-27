// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

afterEach(cleanup);

describe("a sheet", () => {
  it("is a titled dialog that closes with its X, Escape and a long pull down, not with a tap", () => {
    const onClose = vi.fn();
    render(<Sheet title="Filter pull requests" onClose={onClose}><p>Content</p></Sheet>);
    const sheet = screen.getByRole("dialog", { name: "Filter pull requests" });
    expect(sheet.className).toBe("touch-sheet");
    expect(screen.getByText("Content").parentElement?.className).toBe("touch-sheet-content");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    const content = screen.getByText("Content");
    fireEvent.touchStart(content, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(content, { touches: [] });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.touchStart(content, { touches: [{ clientY: 100 }] });
    for (const y of [120, 160, 220, 260]) fireEvent.touchMove(content, { touches: [{ clientY: y }] });
    fireEvent.touchEnd(content, { touches: [] });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
