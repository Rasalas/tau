import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGES, REPO_URL, buildDocs, expandIncludes, renderMarkdown, rewriteHref, sharedBlock, slugify } from "./build-docs.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("docs build", () => {
  it("makes GitHub's heading anchors", () => {
    expect(slugify("2. A minimal example: `examples/hello-package/`")).toBe("2-a-minimal-example-exampleshello-package");
    expect(slugify("Types for a package of your own")).toBe("types-for-a-package-of-your-own");
  });

  it("points links at rendered pages, the site, or the file on GitHub", () => {
    const source = "docs/site/make-a-change.md";
    expect(rewriteHref("../EXTENSIONS.md#your-first-package", source)).toBe("extensions.html#your-first-package");
    expect(rewriteHref("../../CONTRIBUTING.md", source)).toBe("contributing.html");
    expect(rewriteHref("../../site/index.html#download", source)).toBe("../#download");
    expect(rewriteHref("../../kits/README.md", source)).toBe(`${REPO_URL}/blob/main/kits/README.md`);
    expect(rewriteHref("../adr/", source)).toBe(`${REPO_URL}/tree/main/docs/adr`);
    expect(rewriteHref("#install", source)).toBe("#install");
    expect(rewriteHref("https://example.com/x", source)).toBe("https://example.com/x");
  });

  it("inlines an included file as a code block at the list item's indent", () => {
    const markdown = "1. The manifest:\n\n   <!-- include: a/b.json -->\n";
    expect(expandIncludes(markdown, () => "{\n  \"id\": \"x\"\n}\n")).toBe("1. The manifest:\n\n   ```json\n   {\n     \"id\": \"x\"\n   }\n   ```\n");
  });

  it("renders anchors, focusable code and escaped raw HTML", () => {
    const { html, title, headings } = renderMarkdown("# Page\n\nIntro with <name> in it.\n\n## Part one\n\n```bash\nnpm test\n```\n\n## Part one\n", { source: "docs/x.md", readFile: () => "" });
    expect(title).toBe("Page");
    expect(headings.map((heading) => heading.id)).toEqual(["part-one", "part-one-1"]);
    expect(html).toContain('<h2 id="part-one">Part one<a class="anchor" href="#part-one" aria-label="Link to Part one">#</a></h2>');
    expect(html).toContain('<div class="code"><pre tabindex="0"><code class="language-bash">npm test\n</code></pre></div>');
    expect(html).toContain("Intro with &lt;name&gt; in it.");
  });

  it("copies the landing page's header with its links one folder down", () => {
    const index = '<!-- site-header: note -->\n<header><a href="./">Tau</a><a href="./#download">Download</a><a href="docs/">Docs</a><a href="https://x.test/">X</a></header>\n<!-- /site-header -->';
    expect(sharedBlock(index, "site-header", { current: "../docs/" })).toBe('<header><a href="../">Tau</a><a href="../#download">Download</a><a href="../docs/" aria-current="page">Docs</a><a href="https://x.test/">X</a></header>\n');
  });

  it("lists pages whose sources exist", () => {
    for (const page of PAGES) expect(existsSync(join(ROOT, page.source)), page.source).toBe(true);
  });
});

describe("the built docs", () => {
  let out;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "tau-site-docs-"));
    buildDocs({ out });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes every page and an index, and every link inside them resolves", () => {
    const files = readdirSync(out).sort();
    expect(files).toEqual([...PAGES.map((page) => `${page.slug}.html`), "index.html"].sort());
    const ids = new Map(files.map((file) => [file, new Set([...readFileSync(join(out, file), "utf8").matchAll(/ id="([^"]+)"/g)].map((match) => match[1]))]));
    const broken = [];
    for (const file of files) {
      for (const [, href] of readFileSync(join(out, file), "utf8").matchAll(/href="([^"]+)"/g)) {
        if (/^[a-z]+:/i.test(href) || href.startsWith("../")) continue;
        const [path, hash] = href.split("#");
        const target = path || file;
        if (!ids.has(target)) broken.push(`${file} → ${href}`);
        else if (hash && !ids.get(target).has(hash)) broken.push(`${file} → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
