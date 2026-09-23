// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Markdown, loadHighlightLanguage, pendingHighlightCount } from "./Markdown";
import { TRICKY_MARKDOWN } from "./markdown-fixtures";

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
