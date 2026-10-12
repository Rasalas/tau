// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadHeader } from "./ThreadHeader";

afterEach(cleanup);

describe("ThreadHeader", () => {
  it("shows the tools without a stage toggle", () => {
    const { container, rerender } = render(<ThreadHeader
      title={<span className="title-draft">New thread</span>}
      tools={<button type="button">Files</button>}
    />);
    expect(within(screen.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show stage" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();

    rerender(<ThreadHeader title="Thread" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Tools" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();
  });
});
