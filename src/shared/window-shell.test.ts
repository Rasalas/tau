import { describe, expect, it } from "vitest";
import { decodeWindowAction } from "./window-shell.js";

describe("decodeWindowAction", () => {
  it("takes the tau command's three operations, and a folder only for Install", () => {
    expect(decodeWindowAction("window-action", { kind: "command-line", op: "state", folder: "/ignored" })).toEqual({ kind: "command-line", op: "state" });
    expect(decodeWindowAction("window-action", { kind: "command-line", op: "remove" })).toEqual({ kind: "command-line", op: "remove" });
    expect(decodeWindowAction("window-action", { kind: "command-line", op: "install", folder: "/a/bin" })).toEqual({ kind: "command-line", op: "install", folder: "/a/bin" });
  });

  it("refuses an install without a folder and an unknown operation", () => {
    expect(() => decodeWindowAction("window-action", { kind: "command-line", op: "install" })).toThrow(/not a window action/u);
    expect(() => decodeWindowAction("window-action", { kind: "command-line", op: "link" })).toThrow(/not a window action/u);
  });
});
