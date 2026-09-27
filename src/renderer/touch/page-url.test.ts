import { describe, expect, it } from "vitest";
import { pageFromUrl, urlWithPage } from "./page-url";

describe("page url", () => {
  it("reads and writes the page beside the thread", () => {
    expect(pageFromUrl("https://tau.test/app?thread=t1&page=usage")).toBe("usage");
    expect(pageFromUrl("https://tau.test/app?thread=t1")).toBeUndefined();
    expect(urlWithPage("https://tau.test/app?thread=t1#x", "usage")).toBe("/app?thread=t1&page=usage#x");
    expect(urlWithPage("https://tau.test/app?page=usage&thread=t1", undefined)).toBe("/app?thread=t1");
  });
});
