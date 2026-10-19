// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |\n";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom has no layout: say how wide the scroll box's content is.
function overflowing(scrollWidth: number, clientWidth: number): void {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
}

describe("wide Markdown tables", () => {
  it("offers no toggle for a table that fits", () => {
    overflowing(300, 300);
    render(<Markdown>{TABLE}</Markdown>);
    expect(screen.queryByRole("button", { name: /table/iu })).toBeNull();
  });

  it("offers a wrap toggle for a table that scrolls sideways, and a way back", async () => {
    overflowing(900, 300);
    const { container } = render(<Markdown>{TABLE}</Markdown>);
    const wrap = await screen.findByRole("button", { name: "Wrap table cells" });
    expect(container.querySelector(".md-table-scroll")?.hasAttribute("data-wrap")).toBe(false);
    fireEvent.click(wrap);
    // Wrapped cells fit, so the measurement says nothing more; the toggle stays.
    overflowing(300, 300);
    const back = await screen.findByRole("button", { name: "Scroll table sideways" });
    expect(back.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".md-table-scroll")?.hasAttribute("data-wrap")).toBe(true);
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole("button", { name: /table/iu })).toBeNull());
  });

  it("remeasures when the table is resized", async () => {
    overflowing(300, 300);
    let notify: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { notify = callback; } observe() {} disconnect() {} });
    render(<Markdown>{TABLE}</Markdown>);
    expect(screen.queryByRole("button", { name: /table/iu })).toBeNull();
    overflowing(900, 300);
    notify?.();
    await screen.findByRole("button", { name: "Wrap table cells" });
    vi.unstubAllGlobals();
  });
});
