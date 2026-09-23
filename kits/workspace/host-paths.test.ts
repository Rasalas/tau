import { describe, expect, it } from "vitest";
import { relativeHostPath } from "./host-paths.js";

describe("relativeHostPath", () => {
  it("reads POSIX and Windows host paths alike", () => {
    expect(relativeHostPath("/work/app/src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(relativeHostPath("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe("src/a.ts");
  });

  it("answers nothing outside the root or for the root itself", () => {
    expect(relativeHostPath("/work/app-other/a.ts", "/work/app")).toBeUndefined();
    expect(relativeHostPath("/work/app", "/work/app")).toBeUndefined();
    expect(relativeHostPath(undefined, "/work/app")).toBeUndefined();
  });
});
