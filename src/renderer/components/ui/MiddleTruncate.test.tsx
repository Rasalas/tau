// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MiddleTruncate, splitMiddle } from "./MiddleTruncate";

afterEach(cleanup);

describe("splitMiddle", () => {
  it("keeps a short last path segment whole", () => {
    expect(splitMiddle("src/renderer/components/ThreadRow.tsx")).toEqual({ head: "src/renderer/components/", tail: "ThreadRow.tsx" });
  });

  it("keeps ten characters of a branch whose last segment is long", () => {
    expect(splitMiddle("fix/cache-main-20260918-180825")).toEqual({ head: "fix/cache-main-20260", tail: "918-180825" });
  });

  it("does not cut what is barely longer than the tail", () => {
    expect(splitMiddle("main")).toBeUndefined();
    expect(splitMiddle("feature-x-1", 10)).toBeUndefined();
  });

  it("never splits a surrogate pair", () => {
    const split = splitMiddle("🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", 3)!;
    expect(split.tail).toBe("🚀🚀🚀");
    expect(Array.from(split.head)).toHaveLength(13);
  });
});

describe("MiddleTruncate", () => {
  it("renders the whole value as text in two halves", () => {
    const { container } = render(<MiddleTruncate className="thread-branch" value="feature/rail-complete-and-more" />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toBe("thread-branch");
    expect(outer.textContent).toBe("feature/rail-complete-and-more");
    expect(outer.children).toHaveLength(2);
    expect((outer.children[1] as HTMLElement).style.flexShrink).toBe("0");
  });
});
