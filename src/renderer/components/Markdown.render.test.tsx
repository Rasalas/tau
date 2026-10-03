// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Markdown, inlineCodeFile, loadHighlightLanguage, pendingHighlightCount } from "./Markdown";
import { TRICKY_MARKDOWN } from "./markdown-fixtures";
import type { MarkdownHtml } from "./markdown-pipeline";

beforeAll(async () => {
  await Promise.all(["typescript", "bash", "shell", "json", "python", "javascript", "markdown"].map(loadHighlightLanguage));
});

function renderedHtml(text: string): string {
  const { container, unmount } = render(<Markdown>{text}</Markdown>);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("finished Markdown", () => {
  for (const [name, text] of Object.entries(TRICKY_MARKDOWN)) {
    it(`renders ${name} unchanged`, () => {
      expect(renderedHtml(text)).toMatchSnapshot();
    });
  }
});

/** Streams `text` through one Markdown instance, ends the stream, and waits for deferred highlighting. */
async function streamedHtml(text: string, step: number, inspect?: (html: string, prefix: string) => void): Promise<string> {
  const { container, rerender, unmount } = render(<Markdown streaming>{text.slice(0, step)}</Markdown>);
  for (let end = step * 2; end < text.length; end += step) {
    rerender(<Markdown streaming>{text.slice(0, end)}</Markdown>);
    inspect?.(container.innerHTML, text.slice(0, end));
  }
  rerender(<Markdown streaming={false}>{text}</Markdown>);
  do {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  } while (pendingHighlightCount() > 0);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("raw HTML", () => {
  const source = "a <kbd>K</kbd>\n\n<details><summary>s</summary></details>\n";

  it("stays text without html", () => {
    const { container } = render(<Markdown>{source}</Markdown>);
    expect(container.querySelector("kbd, details")).toBeNull();
    expect(container.textContent).toContain("<details><summary>s</summary></details>");
  });

  it("reaches html as raw nodes, and the tree html returns is drawn", () => {
    const seen: string[] = [];
    const html: MarkdownHtml = (tree) => {
      const visit = (node: { type: string; value?: string; children?: unknown[] }) => {
        if (node.type === "raw") seen.push(node.value!);
        node.children?.forEach((child) => visit(child as never));
      };
      visit(tree);
      return { type: "root", children: [{ type: "element", tagName: "kbd", properties: {}, children: [{ type: "text", value: "drawn" }] }] };
    };
    const { container } = render(<Markdown html={html}>{source}</Markdown>);
    expect(seen).toEqual(["<kbd>", "</kbd>", "<details><summary>s</summary></details>"]);
    expect(container.querySelector(".markdown kbd")?.textContent).toBe("drawn");
  });

  it("never reaches html while text streams", () => {
    const html: MarkdownHtml = () => { throw new Error("called"); };
    const { container } = render(<Markdown streaming html={html}>{source}</Markdown>);
    expect(container.textContent).toContain("<details>");
  });
});

describe("streamed Markdown", () => {
  for (const [name, text] of Object.entries(TRICKY_MARKDOWN)) {
    it(`ends identical to a finished message for ${name}`, async () => {
      const finished = renderedHtml(text);
      for (const step of [1, 7]) expect(await streamedHtml(text, step)).toBe(finished);
    });
  }

  it("never shows a fence with blank lines as more than one code block", async () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\n\nconst c = 3;\n```\n\nAfter.\n";
    await streamedHtml(text, 1, (html, prefix) => {
      if (prefix.includes("```ts\n")) expect(html.match(/class="md-code"/gu)).toHaveLength(1);
      // The fence markers never leak into the rendered text.
      expect(html).not.toContain("```");
    });
  });

  it("highlights a growing code block while it streams", async () => {
    const text = "```ts\nconst a = 1;\nconst b = 2;\nconst c";
    const { container } = render(<Markdown streaming>{text}</Markdown>);
    expect(container.querySelectorAll(".md-code .hljs-keyword")).toHaveLength(2);
    expect(container.querySelector(".md-code code")?.textContent).toBe("const a = 1;\nconst b = 2;\nconst c");
  });
});

describe("code block head", () => {
  it("wraps long lines on demand and names its icon buttons", () => {
    const { container, getByRole, unmount } = render(<Markdown>{"```ts\nconst a = 1;\n```"}</Markdown>);
    expect(getByRole("button", { name: "Copy code" })).toBeTruthy();
    const wrap = getByRole("button", { name: "Wrap lines" });
    expect(container.querySelector(".md-code")?.hasAttribute("data-wrap")).toBe(false);
    fireEvent.click(wrap);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(wrap.getAttribute("aria-label")).toBe("Disable line wrap");
    expect(container.querySelector(".md-code")?.hasAttribute("data-wrap")).toBe(true);
    unmount();
  });
});

describe("paths in inline code", () => {
  it("reads a workspace path or a source file's name as a file chip, and leaves other code alone", () => {
    expect(inlineCodeFile("src/main/pi-host.ts")).toBe("pi-host.ts");
    expect(inlineCodeFile("./kits/plan/desktop.tsx")).toBe("desktop.tsx");
    expect(inlineCodeFile("package.json")).toBe("package.json");
    expect(inlineCodeFile("/Users/me/file.ts")).toBe("file.ts");
    expect(inlineCodeFile("/Volumes/disk/project with spaces/file.md")).toBe("file.md");
    expect(inlineCodeFile("C:\\host\\docs\\file.md")).toBe("file.md");
    for (const text of ["npm test", "a.b", "https://example.com/a.js", "src/", "x = y/2.5", "v1.2.3"]) expect(inlineCodeFile(text)).toBeUndefined();
  });

  it("draws the chip with the name and gives the whole path as its tooltip", () => {
    const { container, unmount } = render(<Markdown>{"Pass 1.1 reviewed `src/main/pi-host.ts` and `npm test`."}</Markdown>);
    const [chip, plain] = [...container.querySelectorAll("code")];
    expect(chip!.classList).toContain("md-file-chip");
    expect(chip!.textContent).toBe("pi-host.ts");
    expect(chip!.getAttribute("data-tooltip")).toBe("src/main/pi-host.ts");
    expect(plain!.classList.length).toBe(0);
    expect(plain!.textContent).toBe("npm test");
    unmount();
  });
});
