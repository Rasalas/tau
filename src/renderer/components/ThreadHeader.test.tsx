// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadHeader } from "./ThreadHeader";

afterEach(cleanup);

describe("ThreadHeader", () => {
  it("puts the stage's tools before its toggle while the stage is hidden, set off by a rule (design 1k)", () => {
    const { container, rerender } = render(<ThreadHeader
      title={<span className="title-draft">New thread</span>}
      tools={<button type="button">Files</button>}
      stage={{ shown: false, onToggle: vi.fn() }}
    />);
    const header = container.querySelector(".thread-header") as HTMLElement;
    expect(within(screen.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Files" })).toBeTruthy();
    expect([...header.children].map((child) => child.className).slice(-3)).toEqual(["thread-header-tools", "thread-header-separator", "stage-tool"]);

    rerender(<ThreadHeader title="Thread" stage={{ shown: true, onToggle: vi.fn() }} />);
    expect(screen.queryByRole("toolbar", { name: "Tools" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();
  });
});
