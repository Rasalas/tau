import { describe, expect, it } from "vitest";
import { forGround, isLightGround, LIGHT_ANSI } from "./palette.js";

describe("terminal palette", () => {
  it("tells a light ground from a dark one", () => {
    expect(isLightGround("rgb(251, 250, 248)")).toBe(true);
    expect(isLightGround("rgb(17, 17, 17)")).toBe(false);
    expect(isLightGround(undefined)).toBe(false);
  });

  it("gives the light theme ANSI colours that read on paper, and leaves a dark ground to xterm's own", () => {
    const light = forGround({ background: "rgb(240, 238, 234)", foreground: "rgb(28, 27, 25)" });
    expect(light.yellow).toBe(LIGHT_ANSI.yellow);
    expect(light.foreground).toBe("rgb(28, 27, 25)");
    expect(forGround({ background: "rgb(20, 20, 20)" }).yellow).toBeUndefined();
  });
});
