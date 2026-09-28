// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReloadCurtain } from "./ReloadCurtain";

afterEach(cleanup);

describe("ReloadCurtain", () => {
  it.each([
    ["building", "Building Tau"],
    ["extensions", "Reloading extensions"],
    ["restarting", "Restarting Tau"],
  ] as const)("announces the %s phase", (phase, message) => {
    render(<ReloadCurtain phase={phase} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(message);
    expect(screen.getByRole("heading", { name: message })).toBeTruthy();
  });

  it("draws the τ of the committed glyph", () => {
    const { container } = render(<ReloadCurtain phase="building" />);
    const drawn = [...container.querySelectorAll(".reload-glyph path")].map((path) => path.getAttribute("d"));
    const asset = readFileSync(join(process.cwd(), "assets/icon/tau-glyph.svg"), "utf8");
    expect(drawn).toEqual([...asset.matchAll(/ d="([^"]+)"/gu)].map((match) => match[1]));
    expect(container.textContent).not.toContain("τ");
  });
});
