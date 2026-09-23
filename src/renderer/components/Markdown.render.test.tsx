// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Markdown, loadHighlightLanguage } from "./Markdown";

/** Inputs whose block structure a naive streaming split gets wrong. */
export const TRICKY_MARKDOWN: Record<string, string> = {
  "nested fences": "Outer:\n\n````markdown\n```ts\nconst inner = 1;\n```\n````\n\nAfter.\n",
  "tilde fence with blank lines": "~~~python\nprint('x')\n\n\n# still code\n~~~\n\nDone.\n",
  "backtick fence with blank lines": "```typescript\nconst a = 1;\n\nconst b = 2;\n\n\nexport { a, b };\n```\n",
  "fences inside lists": "- step one\n\n  ```bash\n  npm test\n\n  npm run build\n  ```\n- step two\n  ~~~\n  plain\n  ~~~\n\n1. ordered\n\n   ```json\n   { \"a\": 1 }\n   ```\n",
  "unterminated fence": "Intro paragraph.\n\n```ts\nconst x = 1;\n\nconst y = 2;",
  "table": "| name | value |\n| --- | :-: |\n| `code` | **bold** |\n| a \\| b | [link](https://example.com) |\n\nAfter the table.\n",
  "footnotes": "Text with a note[^1] and another[^named].\n\n[^1]: First note.\n[^named]: Second note with `code`.\n",
  "reference links": "See [the docs][docs] and [docs].\n\n[docs]: https://example.com/docs \"Docs\"\n",
  "html-ish text": "<div class=\"x\">hi</div>\n\ntext <b>bold</b> & <script>alert(1)</script>\n\n<!-- comment -->\n\na < b > c\n",
  "indented code": "Paragraph.\n\n    indented code\n    more code\n\nAfter.\n",
  "loose ordered list": "1. first\n\n2. second\n\n   continued\n\n3. third\n",
  "headings and quotes": "# Title\n\nSetext\n======\n\n> quote with a fence:\n>\n> ```js\n> quoted();\n> ```\n\n---\n\n- [x] done\n- [ ] open\n\nline one  \nline two\nline three ~~gone~~ https://example.com/auto\n",
  "language aliases": "```tsx\nconst View = () => <div />;\n```\n\n```c++\nint x = 0;\n```\n\n```\nno language\n```\n",
  "fence right after a paragraph": "Look:\n```sh\necho one\n\necho two\n```\nThen text.\n",
};

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
