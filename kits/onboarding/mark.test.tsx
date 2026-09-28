// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TauMark } from "./mark.js";

afterEach(cleanup);

describe("TauMark", () => {
  it("draws the committed mark, coloured by the theme's brand tokens", () => {
    const { container } = render(<TauMark />);
    const asset = readFileSync(join(process.cwd(), "assets/icon/mark-light.svg"), "utf8");
    const drawn = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
    expect(drawn).toEqual([...asset.matchAll(/ d="([^"]+)"/gu)].map((match) => match[1]));
    expect(container.querySelector("rect")?.getAttribute("rx")).toBe(asset.match(/<rect[^>]* rx="([^"]+)"/u)?.[1]);
    // Colours come from --brand/--brand-on in styles.css, not from the asset's fixed light ones.
    expect(container.innerHTML).not.toMatch(/fill="#|stroke="#/u);
  });
});
