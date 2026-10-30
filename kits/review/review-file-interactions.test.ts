import { describe, expect, it } from "vitest";
import { isReviewTestFile, viewedFileRange } from "./review-file-interactions.js";

describe("review file interactions", () => {
  it.each([
    "src/view.test.tsx", "src/view.spec.ts", "src/view.e2e.ts", "view_test.go",
    "tests/contract.json", "src/__tests__/view.ts", "test_widget.py", "conftest.py",
    "FooTest.java", "FooTests.cs", "vitest.setup.ts", "src/__snapshots__/view.snap",
    "src/fixtures/data.json", "src/view.mock.ts", "src/mockClient.ts", "src\\tests\\view.ts",
  ])("hides test code or support at %s", (path) => expect(isReviewTestFile(path)).toBe(true));

  it.each(["src/view.ts", "Latest.java", "src/testimonials.ts", "docs/testing.md", "package.json"])(
    "keeps production and documentation at %s", (path) => expect(isReviewTestFile(path)).toBe(false),
  );

  it("takes inclusive ranges in visible order in either direction, falling back for a hidden anchor", () => {
    const files = ["c.ts", "a.ts", "d.ts"].map((path) => ({ path }));
    expect(viewedFileRange(files, "d.ts", "c.ts")).toEqual(files);
    expect(viewedFileRange(files, "c.ts", "d.ts")).toEqual(files);
    expect(viewedFileRange(files, "a.ts", "a.ts")).toEqual([files[1]]);
    expect(viewedFileRange(files, "a.ts", "hidden.test.ts")).toEqual([files[1]]);
    expect(viewedFileRange(files, "a.ts")).toEqual([files[1]]);
    expect(viewedFileRange(files, "hidden.test.ts", "a.ts")).toEqual([]);
  });
});
