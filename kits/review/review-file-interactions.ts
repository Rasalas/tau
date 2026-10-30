const TEST_DIRECTORIES = new Set([
  "__tests__", "__test__", "cypress", "e2e", "spec", "specs", "test", "tests",
  "__fixtures__", "__mocks__", "__snapshots__", "fakes", "fixture", "fixtures",
  "mock", "mocks", "stubs", "testdata",
]);

/** Test code and its support files, identified by path conventions rather than contents. */
export function isReviewTestFile(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.pop() ?? "";
  return segments.some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))
    || /(\.(test|spec|e2e)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i.test(name)
    // Keep this case-sensitive: Latest.java is production code, FooTest.java is a test.
    || /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/.test(name)
    || /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/.test(name);
}

/** Both endpoints, in the current visible order. An absent anchor changes only the clicked file. */
export function viewedFileRange<T extends { path: string }>(files: readonly T[], path: string, anchor?: string): readonly T[] {
  const index = files.findIndex((file) => file.path === path);
  if (index < 0) return [];
  const from = files.findIndex((file) => file.path === anchor);
  return from < 0 ? files.slice(index, index + 1) : files.slice(Math.min(index, from), Math.max(index, from) + 1);
}
