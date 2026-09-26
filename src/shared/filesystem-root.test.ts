import { describe, expect, it } from "vitest";
import { isFilesystemRoot } from "./filesystem-root.js";

describe("isFilesystemRoot", () => {
  it("knows the roots", () => {
    for (const path of ["/", "//", "C:\\", "c:/", "D:", "\\\\server\\share", "\\\\server\\share\\"]) expect(isFilesystemRoot(path), path).toBe(true);
  });

  it("leaves every folder below one alone", () => {
    for (const path of ["/Users/me", "/tmp", "C:\\Users\\me", "\\\\server\\share\\repo", "", "~"]) expect(isFilesystemRoot(path), path).toBe(false);
  });
});
