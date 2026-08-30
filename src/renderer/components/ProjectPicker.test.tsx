// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "./ProjectPicker";

const projects = Array.from({ length: 10_000 }, (_, index) => ({
  path: `/projects/${index}`,
  name: `Project ${index}`,
  lastOpenedAt: 10_000 - index,
}));

afterEach(cleanup);

describe("ProjectPicker large catalogs", () => {
  it("virtualizes 10,000 projects and preserves keyboard selection", () => {
    const onSelect = vi.fn();
    render(<ProjectPicker open projects={projects} onBrowse={() => {}} onClose={() => {}} onSelect={onSelect} />);
    expect(screen.getAllByRole("option").length).toBeLessThan(50);
    const input = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(projects[1]);
    fireEvent.change(input, { target: { value: "Project 9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(projects[9999]);
  });
});
