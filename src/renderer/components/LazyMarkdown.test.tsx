// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, preloadMarkdown } from "./LazyMarkdown";

describe("preloaded transcript Markdown", () => {
  it("renders formatted content synchronously without a loading frame", async () => {
    await preloadMarkdown();
    const view = render(<Markdown>**A response** with [a link](https://example.com).</Markdown>);
    expect(screen.getByText("A response").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "a link" }).getAttribute("href")).toBe("https://example.com");
    expect(view.container.querySelector(".lazy-feature-loading")).toBeNull();
  });
});
