import { describe, expect, it } from "vitest";
import { linkedFilePath } from "./linked-file-path";

describe("host filesystem links", () => {
  it.each([
    ["../docs/a.md", "../docs/a.md"],
    ["./src/a.ts", "src/a.ts"],
    ["/host/project with spaces/a.md", "/host/project with spaces/a.md"],
    ["C:\\host\\docs\\a.md", "C:/host/docs/a.md"],
  ])("keeps %s for the host to resolve", (path, expected) => {
    expect(linkedFilePath(path)).toBe(expected);
  });
  it.each(["", " ", "a\0.md", "https://example.invalid/a.md", "file:///host/a.md", "C:relative.md"])("rejects non-filesystem link %j", (path) => {
    expect(() => linkedFilePath(path)).toThrow("filesystem path");
  });
});
