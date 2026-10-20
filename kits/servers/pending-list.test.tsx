// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingList } from "./pending-list.js";

afterEach(cleanup);

describe("the pending files", () => {
  it("shows a cut name, folder or withheld path whole in a tooltip", () => {
    const path = "public/assets/very/deep/folder/stylesheet.css";
    render(<PendingList rows={[{ path, change: "modified", selected: true }]} total={1} withheld={[".env.production"]} onOpen={() => undefined} />);
    for (const text of ["stylesheet.css", "public/assets/very/deep/folder", ".env.production"]) {
      const shown = screen.getByText(text);
      expect(shown.dataset.tooltipWhen).toBe("truncated");
      expect(shown.dataset.tooltip).toBe(text === ".env.production" ? text : path);
    }
  });
});
