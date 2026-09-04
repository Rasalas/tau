// @vitest-environment jsdom
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
});
