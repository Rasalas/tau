// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "tau";
import { githubHtml } from "./github-html.js";

afterEach(cleanup);

const DEPENDABOT = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/gh-pr-view-dependabot.json"), "utf8")) as { body: string }).body;

function html(source: string): HTMLElement {
  return render(<Markdown html={githubHtml}>{source}</Markdown>).container;
}

describe("Markdown with GitHub's HTML", () => {
  it("renders a Dependabot description's details, links, quotes and lists", () => {
    const root = html(DEPENDABOT);
    expect(root.textContent).not.toMatch(/<\/?(details|summary|a|p|em|blockquote|ul|li|code|br)\b/u);
    const summaries = [...root.querySelectorAll("details")].map((entry) => entry.querySelector(":scope > summary")?.textContent);
    expect(summaries).toEqual(["Release notes", "Commits", "Release notes", "Dependabot commands and options"]);
    expect(root.querySelector("details blockquote h2")?.textContent).toBe("Release v3.16.1");
    const commit = root.querySelector<HTMLAnchorElement>("details li a[href*='/commit/5c4f310']")!;
    expect(commit.querySelector("code")?.textContent).toBe("5c4f310");
    expect(commit.target).toBe("_blank");
    expect(commit.rel).toBe("noreferrer noopener");
    // Markdown inside a details block still renders as Markdown.
    expect(root.querySelector("details:last-of-type ul li code")?.textContent).toBe("@dependabot rebase");
    expect(root.querySelector("p code")?.textContent).toBe("knplabs/github-api");
  });

  it("starts details closed and opens them from the summary", () => {
    const root = html("<details open><summary>More</summary>\n\nHidden **text**\n\n</details>");
    const details = root.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("strong")?.textContent).toBe("text");
    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
  });

  it("keeps GitHub's other tags and drops their unsafe attributes", () => {
    const root = html([
      "<table><tr><th align=\"right\" colspan=\"2\" style=\"color:red\">h</th></tr><tr><td>1</td><td>2</td></tr></table>",
      "",
      "<p class=\"sr-only\" id=\"x\" style=\"position:fixed\">H<sub>2</sub>O x<sup>2</sup> <kbd>⌘K</kbd><br>next</p>",
      "",
      "<pre><code class=\"language-js\">let a = <b>1</b>;</code></pre>",
      "",
      "<img src=\"https://example.com/a.png\" alt=\"logo\" width=\"20\" onload=\"alert(1)\"> <font color=red>kept text</font>",
    ].join("\n"));
    const th = root.querySelector("th")!;
    expect(th.colSpan).toBe(2);
    expect(th.style.textAlign).toBe("right");
    expect(th.style.color).toBe("");
    const paragraph = root.querySelector("sub")!.closest("p")!;
    expect(paragraph.className).toBe("");
    expect(paragraph.id).toBe("");
    expect(paragraph.getAttribute("style")).toBeNull();
    expect(root.querySelector("kbd")?.textContent).toBe("⌘K");
    expect(root.querySelector(".md-code pre code")?.textContent).toBe("let a = 1;");
    const image = root.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("https://example.com/a.png");
    expect(image.width).toBe(20);
    expect(image.getAttribute("onload")).toBeNull();
    expect(root.querySelector("font")).toBeNull();
    expect(root.textContent).toContain("kept text");
  });

  const HOSTILE: Record<string, string> = {
    "img onerror": "<img src=x onerror=\"window.xss=1\">",
    "https img onerror": "<img src=\"https://e.com/a.png\" onerror=\"window.xss=1\">",
    "data and http images": "<img src=\"data:image/svg+xml,<svg onload=alert(1)>\"> <img src=\"http://e.com/a.png\">",
    "javascript link": "<a href=\"javascript:window.xss=1\">click</a> <a href=\" JaVaScRiPt:alert(1)\">two</a>",
    "data and relative links": "<a href=\"data:text/html,<script>alert(1)</script>\">d</a> <a href=\"/settings\">rel</a>",
    "link handlers": "<a href=\"https://e.com\" onclick=\"window.xss=1\" target=\"_self\" style=\"position:fixed\">safe</a>",
    "script": "<script>window.xss=1</script>\n\nafter",
    "svg onload": "<svg onload=\"window.xss=1\"><script>window.xss=1</script></svg>",
    "math and iframe": "<math><mi xlink:href=\"javascript:alert(1)\">m</mi></math><iframe src=\"https://e.com\" srcdoc=\"<script>alert(1)</script>\"></iframe>",
    "forms": "<form action=\"https://e.com\"><input name=\"q\" autofocus onfocus=\"window.xss=1\"><button formaction=\"javascript:alert(1)\">go</button></form>",
    "style and objects": "<style>*{display:none}</style><object data=\"x.swf\"></object><embed src=\"x\"><meta http-equiv=\"refresh\" content=\"0;url=https://e.com\">",
    "details handler": "<details ontoggle=\"window.xss=1\" open><summary onclick=\"window.xss=1\">s</summary>b</details>",
    "lightbox button spoof": '<button type="button" class="md-image-link" onclick="window.xss=1">spoof</button>',
    "marker spoof": "<tau-md-abc data-i=\"0\" onclick=\"window.xss=1\">t</tau-md-abc>",
    "broken markup": "<a href=\"https://e.com\"><img src=x onerror=window.xss=1 <b>unclosed",
    "comment breakout": "<!-- --><img src=x onerror=window.xss=1> <!-- <script>alert(1)</script> -->",
  };

  for (const [name, source] of Object.entries(HOSTILE)) {
    it(`renders ${name} without script, handlers or unsafe URLs`, () => {
      const root = html(`before\n\n${source}\n\ntrailing`);
      // Handler-shaped text is fine; attributes and tags are what must not survive.
      expect(root.innerHTML).not.toMatch(/javascript:|data:|<script|<svg|<math|<iframe|<form|<input|<button(?! type="button" class="md-image-link")|<style|<object|<embed|<meta|style="position/iu);
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName === "BUTTON") {
          expect(element.className).toBe("md-image-link");
          expect(element.getAttribute("type")).toBe("button");
          expect(element.querySelector(":scope > img")).not.toBeNull();
        }
        for (const attribute of element.attributes) {
          if (attribute.name === "type" && element.matches("button.md-image-link")) continue;
          expect(attribute.name).toMatch(/^(href|target|rel|src|alt|title|width|height|class|style|colspan|rowspan|start|aria-[a-z]+|data-[a-z-]+|id)$/u);
        }
      }
      for (const link of root.querySelectorAll("a")) expect(link.getAttribute("href")).toMatch(/^https?:\/\//u);
      for (const image of root.querySelectorAll("img")) expect(image.getAttribute("src")).toMatch(/^https:\/\//u);
      expect((window as { xss?: number }).xss).toBeUndefined();
      expect(root.textContent).toContain("before");
    });
  }

  it("keeps the text of a link it refuses", () => {
    const root = html("<a href=\"javascript:alert(1)\">click</a> and <a href=\"/relative\">rel</a>");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("click and rel");
  });

  it("keeps the Markdown's own elements as the plain renderer draws them", () => {
    const source = "- [x] done <kbd>K</kbd>\n\n```js\nlet a = 1;\n```\n\n| a |\n|---|\n| `src/app.ts` |\n";
    const root = html(source);
    const plain = render(<Markdown>{source.replace(" <kbd>K</kbd>", "")}</Markdown>).container;
    expect(root.querySelector(".md-check.on")).not.toBeNull();
    expect(root.querySelector("kbd")?.textContent).toBe("K");
    expect(root.querySelector(".md-code-head span")?.textContent).toBe("js");
    expect(root.querySelector(".md-table-scroll table .md-file-chip")?.textContent).toBe("app.ts");
    expect(root.querySelector(".md-code")?.outerHTML).toBe(plain.querySelector(".md-code")?.outerHTML);
  });
});
