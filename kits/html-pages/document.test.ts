import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageError, inlineLocalImages, preparePageDocument, readOrigins, readPageFile, readTheme } from "./document.js";

describe("readOrigins", () => {
  it("keeps https origins, reduced to scheme, host and port", () => {
    expect(readOrigins(["https://cdn.jsdelivr.net/npm/chart.js", "https://Unpkg.com", "https://cdn.jsdelivr.net", "https://fonts.example.org:8443/x"]))
      .toEqual(["https://cdn.jsdelivr.net", "https://unpkg.com", "https://fonts.example.org:8443"]);
    expect(readOrigins(undefined)).toEqual([]);
  });

  it.each([
    "http://cdn.example.com",
    "https://localhost:3000",
    "https://127.0.0.1",
    "https://2130706433",
    "https://[::1]",
    "https://192.168.1.4",
    "https://printer.local",
    "https://nas.home.arpa",
    "https://intranet",
    "https://user:pw@cdn.example.com",
    "ftp://cdn.example.com",
    "cdn.example.com",
    "*.example.com",
  ])("refuses %s", (origin) => {
    expect(() => readOrigins([origin])).toThrow(PageError);
  });

  it("refuses a list that is too long or not a list", () => {
    expect(() => readOrigins(Array.from({ length: 9 }, (_, index) => `https://a${String(index)}.example.com`))).toThrow(/At most/u);
    expect(() => readOrigins("https://a.example.com")).toThrow(PageError);
  });
});

describe("local images", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tau-pages-doc-"));
    outside = await mkdtemp(join(tmpdir(), "tau-pages-out-"));
    await mkdir(join(root, "img"));
    await writeFile(join(root, "img", "a.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(root, "b.svg"), "<svg/>");
    await writeFile(join(outside, "secret.png"), Buffer.from([9]));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("embeds images by absolute and relative path, in src and url()", async () => {
    const html = `<img src="${join(root, "img", "a.png")}"><img src='img/a.png?v=2'><div style="background:url(./b.svg)"></div><style>.x{background:url("img/a.png")}</style>`;
    const result = await inlineLocalImages(html, { baseDir: root, roots: [root] });
    expect(result.skipped).toEqual([]);
    expect(result.embedded).toBe(3);
    expect(result.html.match(/data:image\/png;base64,AQID/gu)).toHaveLength(3);
    expect(result.html).toContain("url(./b.svg)".replace("./b.svg", "data:image/svg+xml;base64,PHN2Zy8+"));
  });

  it("leaves remote, data and fragment references alone", async () => {
    const html = '<img src="https://example.com/a.png"><img src="data:image/png;base64,AA=="><a href="#x"><img src="//cdn.example.com/b.png">';
    expect(await inlineLocalImages(html, { baseDir: root, roots: [root] })).toEqual({ html, embedded: 0, skipped: [] });
  });

  it("reads nothing outside its roots, nor through a link out of them", async () => {
    const link = join(root, "link.png");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(outside, "secret.png"), link);
    const html = `<img src="${join(outside, "secret.png")}"><img src="link.png"><img src="missing.png">`;
    const result = await inlineLocalImages(html, { baseDir: root, roots: [root] });
    expect(result.html).toBe(html);
    expect(result.skipped).toEqual([`${join(outside, "secret.png")} (outside the project)`, "link.png (outside the project)", "missing.png (not found)"]);
  });
});

describe("readPageFile", () => {
  it("reads a file under a root and refuses the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-pages-file-"));
    try {
      await writeFile(join(root, "p.html"), "<h1>x</h1>");
      expect((await readPageFile("p.html", { cwd: root, roots: [root] })).html).toBe("<h1>x</h1>");
      await expect(readPageFile("/etc/hosts", { cwd: root, roots: [root] })).rejects.toThrow(/outside/u);
      await expect(readPageFile("nope.html", { cwd: root, roots: [root] })).rejects.toThrow(/No file/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("readTheme", () => {
  it("keeps known variables and strips what could leave the declaration", () => {
    expect(readTheme({
      "--background": "light-dark(#fff, #000)",
      "--foreground": "red; } body { display:none",
      "--accent": "url(https://x.test/a.png)",
      "--unknown": "red",
      "--border": 4,
    })).toEqual({ "--background": "light-dark(#fff, #000)", "--foreground": "red  body  display:none" });
    expect(readTheme("nope")).toEqual({});
  });
});

describe("preparePageDocument", () => {
  const style = (html: string) => /<style id="tau-page-theme">([^<]*)<\/style>/u.exec(html)?.[1] ?? "";

  it("puts the theme and the reporter after <head>, behind the doctype", () => {
    const out = preparePageDocument("<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>", { theme: { "--background": "teal" } });
    expect(out.startsWith("<!DOCTYPE html><html><head><meta charset")).toBe(true);
    expect(out.indexOf("tau-page-theme")).toBeLessThan(out.indexOf("<title>"));
    expect(style(out)).toContain("--background:teal;");
    expect(style(out)).toContain("--chart-1:var(--accent);");
    expect(out).toContain("ui/notifications/size-changed");
    expect(out.endsWith("<body>hi</body></html>")).toBe(true);
  });

  it("takes a fragment as it is and falls back for variables the client did not send", () => {
    const out = preparePageDocument("<p>x</p>");
    expect(out.startsWith("<meta charset")).toBe(true);
    expect(out.endsWith("<p>x</p>")).toBe(true);
    expect(style(out)).toContain("--foreground:light-dark(");
  });

  it("does not take a <head> word from a script far down the page", () => {
    const html = `<body>${"x".repeat(9000)}<script>var s="<head>"</script></body>`;
    expect(preparePageDocument(html).startsWith("<meta charset")).toBe(true);
  });
});
