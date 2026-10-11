// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { headingSlug } from "./markdown-pipeline";

const scrolled: Element[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const DOC = "[Setup](#setup) [Again](#setup-1) [Fancy](#whats-new-2) [Note](#user-content-fn-a)\n\n# Setup\n\n## Setup\n\n### What's new? (2)\n\ntext[^a]\n\n[^a]: footnote\n";

describe("heading anchors", () => {
  it("slugs as GitHub does", () => {
    expect(headingSlug("What's new? (2)")).toBe("whats-new-2");
    expect(headingSlug("  Über Café_x  ")).toBe("über-café_x");
    expect(headingSlug("A -- B")).toBe("a----b");
  });

  it("gives headings prefixed, de-duplicated ids", () => {
    const { container } = render(<Markdown>{DOC}</Markdown>);
    expect([...container.querySelectorAll("h1, h2, h3")].map((heading) => heading.id).filter((id) => id !== "footnote-label")).toEqual(["user-content-setup", "user-content-setup-1", "user-content-whats-new-2"]);
  });

  it("scrolls to the heading in the same document instead of opening a window", () => {
    const { container } = render(<Markdown>{DOC}</Markdown>);
    const links = [...container.querySelectorAll("a")];
    expect(links[0]!.getAttribute("target")).toBeNull();
    expect(fireEvent.click(links[0]!)).toBe(false);
    expect(fireEvent.click(links[1]!)).toBe(false);
    expect(scrolled.map((element) => element.id)).toEqual(["user-content-setup", "user-content-setup-1"]);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("finds a footnote by its generated id and ignores a fragment nothing names", () => {
    const { container } = render(<Markdown>{`${DOC}\n[Nowhere](#nowhere)`}</Markdown>);
    const links = [...container.querySelectorAll("a")];
    fireEvent.click(links.find((link) => link.textContent === "Note")!);
    expect(scrolled.map((element) => element.id)).toEqual(["user-content-fn-a"]);
    expect(fireEvent.click(links.find((link) => link.textContent === "Nowhere")!)).toBe(false);
    expect(scrolled).toHaveLength(1);
  });

  it("looks only inside its own message", () => {
    const { container } = render(<><div data-m="one"><Markdown>{"[Go](#intro)\n\n# Intro"}</Markdown></div><div data-m="two"><Markdown>{"# Intro"}</Markdown></div></>);
    fireEvent.click(container.querySelector("[data-m=one] a")!);
    expect(scrolled).toHaveLength(1);
    expect(container.querySelector("[data-m=one]")!.contains(scrolled[0]!)).toBe(true);
  });

  it("finds the Nth repeat in a message that streamed block by block", () => {
    const text = "[Two](#setup-1)\n\n# Setup\n\nbody\n\n# Setup\n\nmore\n";
    const { container, rerender } = render(<Markdown streaming>{text.slice(0, 20)}</Markdown>);
    rerender(<Markdown streaming>{text}</Markdown>);
    rerender(<Markdown streaming={false}>{text}</Markdown>);
    fireEvent.click(container.querySelector("a")!);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(container.querySelectorAll("h1")[1]);
  });

  it("leaves the headings of a file preview and other links alone", () => {
    const { container } = render(<Markdown>{"[ext](https://example.com) [mail](mailto:a@b.c)\n"}</Markdown>);
    const [ext] = [...container.querySelectorAll("a")];
    expect(ext!.getAttribute("target")).toBe("_blank");
  });
});
