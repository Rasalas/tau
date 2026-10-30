import { describe, expect, it } from "vitest";
import { classifyTerminalLink, findTerminalFileLinks, findTerminalLinks, positionIn, resolveTerminalPath, wrappedLineAt } from "./links.js";

describe("findTerminalLinks", () => {
  it("finds http and https URLs with their offsets", () => {
    expect(findTerminalLinks("  ➜  Local:   http://localhost:5173/ and https://example.com/a?b=1#c")).toEqual([
      { url: "http://localhost:5173/", start: 14, end: 36 },
      { url: "https://example.com/a?b=1#c", start: 41, end: 68 },
    ]);
  });

  it("leaves out the sentence around a URL but keeps brackets it opened", () => {
    expect(findTerminalLinks("see (http://localhost:3000).").map((link) => link.url)).toEqual(["http://localhost:3000"]);
    expect(findTerminalLinks("docs: https://en.wikipedia.org/wiki/Tau_(letter), ok").map((link) => link.url)).toEqual(["https://en.wikipedia.org/wiki/Tau_(letter)"]);
    expect(findTerminalLinks("\"http://127.0.0.1:8080/x\"").map((link) => link.url)).toEqual(["http://127.0.0.1:8080/x"]);
  });

  it("ignores what is not a web URL", () => {
    expect(findTerminalLinks("ftp://host file:///etc/hosts http:// nothttp://x")).toEqual([]);
  });
});

describe("classifyTerminalLink", () => {
  it("opens a server on this machine in the Preview", () => {
    expect(classifyTerminalLink("http://localhost:3000")).toEqual({ kind: "preview", url: "http://localhost:3000/" });
    expect(classifyTerminalLink("http://127.0.0.1:8080/app")).toEqual({ kind: "preview", url: "http://127.0.0.1:8080/app" });
    expect(classifyTerminalLink("https://app.localhost/")).toEqual({ kind: "preview", url: "https://app.localhost/" });
    expect(classifyTerminalLink("http://[::1]:4000/")).toEqual({ kind: "preview", url: "http://[::1]:4000/" });
  });

  it("visits 0.0.0.0 as localhost", () => {
    expect(classifyTerminalLink("http://0.0.0.0:5173/path?q=1")).toEqual({ kind: "preview", url: "http://localhost:5173/path?q=1" });
  });

  it("sends every other host to the browser", () => {
    expect(classifyTerminalLink("https://github.com/owner/repo")).toEqual({ kind: "external", url: "https://github.com/owner/repo" });
    expect(classifyTerminalLink("http://localhost.example.com")).toEqual({ kind: "external", url: "http://localhost.example.com/" });
    expect(classifyTerminalLink("http://10.0.0.2:3000")).toEqual({ kind: "external", url: "http://10.0.0.2:3000/" });
  });

  it("answers nothing for what is not an http URL", () => {
    expect(classifyTerminalLink("javascript:alert(1)")).toBeUndefined();
    expect(classifyTerminalLink("not a url")).toBeUndefined();
  });
});

describe("wrapped lines", () => {
  const rows = [
    { isWrapped: false, translateToString: () => "$ echo x" },
    { isWrapped: false, translateToString: () => "http://local" },
    { isWrapped: true, translateToString: () => "host:3000/lo" },
    { isWrapped: true, translateToString: (trim?: boolean) => trim ? "ng" : "ng          " },
    { isWrapped: false, translateToString: () => "next" },
  ];
  const getRow = (index: number) => rows[index];

  it("joins a URL the terminal wrapped, from any of its rows", () => {
    const line = wrappedLineAt(3, getRow)!;
    expect(line.text).toBe("http://localhost:3000/long");
    expect(line.rows).toEqual([{ row: 2, start: 0 }, { row: 3, start: 12 }, { row: 4, start: 24 }]);
    expect(wrappedLineAt(4, getRow)?.text).toBe(line.text);
    expect(wrappedLineAt(5, getRow)?.text).toBe("next");
    expect(wrappedLineAt(9, getRow)).toBeUndefined();
  });

  it("maps an offset in the joined text back to row and column", () => {
    const line = wrappedLineAt(2, getRow)!;
    expect(positionIn(line, 0)).toEqual({ x: 1, y: 2 });
    expect(positionIn(line, 13)).toEqual({ x: 2, y: 3 });
    expect(positionIn(line, 25)).toEqual({ x: 2, y: 4 });
  });

  it("maps Unicode offsets to terminal cells across a wrapped link", () => {
    const bufferRow = (isWrapped: boolean, cells: Array<[string, number]>) => ({
      isWrapped,
      length: cells.length,
      translateToString: () => cells.map(([chars, width]) => width === 0 ? "" : chars || " ").join(""),
      getCell: (column: number) => cells[column] && ({ getChars: () => cells[column]![0], getWidth: () => cells[column]![1] }),
    });
    const buffer = [
      bufferRow(false, [["文", 2], ["", 0], ["", 1], ["𐐀", 1], ["e\u0301", 1], ["/", 1]]),
      bufferRow(true, [["说", 2], ["", 0], ["明", 2], ["", 0], [".", 1], ["m", 1], ["d", 1]]),
    ];
    const line = wrappedLineAt(2, (index) => buffer[index])!;
    expect(line.text).toBe("文 𐐀e\u0301/说明.md");
    const [link] = findTerminalFileLinks(line.text);
    expect(link?.path).toBe("𐐀e\u0301/说明.md");
    expect(positionIn(line, link!.start)).toEqual({ x: 4, y: 1 });
    // Both halves of a surrogate pair and both codepoints of a combined cell share a column.
    expect(positionIn(line, link!.start + 1)).toEqual({ x: 4, y: 1 });
    expect(positionIn(line, link!.start + 3)).toEqual({ x: 5, y: 1 });
    expect(positionIn(line, link!.end - 1, "end")).toEqual({ x: 7, y: 2 });
    const wide = line.text.indexOf("明");
    expect(positionIn(line, wide)).toEqual({ x: 3, y: 2 });
    expect(positionIn(line, wide, "end")).toEqual({ x: 4, y: 2 });
  });
});

describe("findTerminalFileLinks", () => {
  const found = (text: string) => findTerminalFileLinks(text).map(({ path, line, column }) => ({ path, ...(line ? { line } : {}), ...(column ? { column } : {}) }));

  it("finds relative, rooted, home and Windows paths with their position", () => {
    expect(found("error in src/app.ts:12:3: bad")).toEqual([{ path: "src/app.ts", line: 12, column: 3 }]);
    expect(found("see ./a.txt and ../b/c and ~/notes.md:4")).toEqual([{ path: "./a.txt" }, { path: "../b/c" }, { path: "~/notes.md", line: 4 }]);
    expect(found("at C:\\work\\app\\main.cs:7 now")).toEqual([{ path: "C:\\work\\app\\main.cs", line: 7 }]);
    expect(found("at src\\dir\\main.rs and \\\\host\\share\\f.txt")).toEqual([{ path: "src\\dir\\main.rs" }, { path: "\\\\host\\share\\f.txt" }]);
    expect(found("(see /etc/hosts).")).toEqual([{ path: "/etc/hosts" }]);
  });

  it("reports offsets that cover the position", () => {
    const text = "x src/app.ts:12 y";
    const [match] = findTerminalFileLinks(text);
    expect(text.slice(match!.start, match!.end)).toBe("src/app.ts:12");
  });

  it.each([
    ["src/żółć.ts:12:7", "src/żółć.ts", 12, 7],
    ["żółć/main.ts:12", "żółć/main.ts", 12, undefined],
    [String.raw`żółć\main.ts:12`, String.raw`żółć\main.ts`, 12, undefined],
    ["src/cafe\u0301.ts:12", "src/cafe\u0301.ts", 12, undefined],
    ["src/𐐀.ts:12", "src/𐐀.ts", 12, undefined],
    ["文档/说明.md", "文档/说明.md", undefined, undefined],
  ])("keeps the complete Unicode path %s and its position", (printed, path, line, column) => {
    const text = `see ${printed} for details`;
    expect(findTerminalFileLinks(text)).toEqual([{ path, line, column, start: 4, end: 4 + printed.length }]);
  });

  it.each([
    ['"src/My File.ts":12:3', "src/My File.ts", 12, 3],
    ["'src/My File.ts:12:3'", "src/My File.ts", 12, 3],
    ['"/tmp/a b.txt:7"', "/tmp/a b.txt", 7, undefined],
    ['"./my folder/file.ts":5', "./my folder/file.ts", 5, undefined],
    ["'../my folder/file.ts'", "../my folder/file.ts", undefined, undefined],
    ['"~/My Notes/today.md"', "~/My Notes/today.md", undefined, undefined],
    [String.raw`"C:\Program Files\app\main.cs":7:2`, String.raw`C:\Program Files\app\main.cs`, 7, 2],
    [String.raw`'\\host\my share\f.txt:8'`, String.raw`\\host\my share\f.txt`, 8, undefined],
    ['`文档/我的 说明.md`:2:4', "文档/我的 说明.md", 2, 4],
    ['"żółć/cafe\u0301 notes.ts":9', "żółć/cafe\u0301 notes.ts", 9, undefined],
    ['"𐐀 docs/文档.md"', "𐐀 docs/文档.md", undefined, undefined],
    [String.raw`"src/a\"quoted\" file.ts":2`, 'src/a"quoted" file.ts', 2, undefined],
    [String.raw`'src/it\'s here.ts:3:2'`, "src/it's here.ts", 3, 2],
    ['"My File.ts":10', "My File.ts", 10, undefined],
    ['"/tmp/odd [name].ts".', "/tmp/odd [name].ts", undefined, undefined],
  ])("reads the whole quoted path and preserves source offsets: %s", (printed, path, line, column) => {
    const text = `see ${printed} for details`;
    const [match] = findTerminalFileLinks(text);
    const source = printed.endsWith(".") ? printed.slice(0, -1) : printed;
    expect(findTerminalFileLinks(text)).toEqual([{ path, line, column, start: 4, end: 4 + source.length }]);
    expect(text.slice(match!.start, match!.end)).toBe(source);
  });

  it("resolves decoded quoted paths using the terminal cwd", () => {
    const [posix] = findTerminalFileLinks(String.raw`"./My \"Notes\".md":4`);
    expect(resolveTerminalPath(posix!.path, "/project")).toBe('/project/My "Notes".md');
    const [windows] = findTerminalFileLinks(String.raw`"C:\Program Files\app\main.cs":7`);
    expect(resolveTerminalPath(windows!.path, undefined)).toBe("C:/Program Files/app/main.cs");
  });

  it("orders quoted and unquoted paths together and leaves web links to the URL provider", () => {
    const text = 'src/a.ts "src/My File.ts":3 https://example.com/a/b.md "https://example.com/a b.md" ./end.ts';
    const urls = findTerminalLinks(text);
    expect(findTerminalFileLinks(text, urls).map((link) => link.path)).toEqual(["src/a.ts", "src/My File.ts", "./end.ts"]);
    const quoted = '"src/a b.ts"';
    expect(findTerminalFileLinks(quoted, [{ start: 4, end: 5 }])).toEqual([]);
  });

  it.each([
    "use and/or 5/10 without spaces becoming paths",
    '"use and/or words"',
    '"not a file"',
    '"5/10"',
    '"file:///tmp/My File.ts"',
    '"https://example.com/a b.ts"',
    '"src/unclosed file.ts',
  ])("does not invent partial paths from prose or incomplete quoting: %s", (text) => {
    expect(findTerminalFileLinks(text)).toEqual([]);
  });

  it("preserves contractions in prose around unquoted and quoted links", () => {
    expect(found(`don't truncate src/file.ts or 'src/My File.ts'`)).toEqual([{ path: "src/file.ts" }, { path: "src/My File.ts" }]);
  });

  it("maps wrapped quoted paths to wide, combining and escaped-quote cells using source offsets", () => {
    const row = (isWrapped: boolean, cells: Array<[string, number]>) => ({
      isWrapped, length: cells.length,
      translateToString: () => cells.map(([chars, width]) => width === 0 ? "" : chars || " ").join(""),
      getCell: (column: number) => cells[column] && ({ getChars: () => cells[column]![0], getWidth: () => cells[column]![1] }),
    });
    const buffer = [
      row(false, [["文", 2], ["", 0], [" ", 1], ['"', 1], ["𐐀", 1], ["e\u0301", 1], [" ", 1], ["/", 1]]),
      row(true, [["说", 2], ["", 0], [" ", 1], ["\\", 1], ['"', 1], ["明", 2], ["", 0], [".", 1], ["t", 1], ["s", 1], ['"', 1], [":", 1], ["2", 1], [":", 1], ["4", 1]]),
    ];
    const line = wrappedLineAt(2, (index) => buffer[index])!;
    const [link] = findTerminalFileLinks(line.text);
    expect(link?.path).toBe('𐐀e\u0301 /说 "明.ts');
    expect(link).toMatchObject({ line: 2, column: 4 });
    expect(positionIn(line, link!.start)).toEqual({ x: 4, y: 1 });
    expect(positionIn(line, link!.end - 1, "end")).toEqual({ x: 15, y: 2 });
    const quote = line.text.indexOf('\\"');
    expect(positionIn(line, quote)).toEqual({ x: 4, y: 2 });
    expect(positionIn(line, quote + 1)).toEqual({ x: 5, y: 2 });
    expect(positionIn(line, line.text.indexOf("明"), "end")).toEqual({ x: 7, y: 2 });
  });

  it("does not treat the slash within Unicode prose as a rooted path", () => {
    expect(found("żółć/bez and 文档/说明")).toEqual([]);
  });

  it("leaves prose, URLs and bare names without an extension alone", () => {
    expect(found("use and/or 5/10 and https://example.com/a/b.html or file:///etc/hosts")).toEqual([]);
    expect(found("// a comment, a//b")).toEqual([]);
    expect(findTerminalFileLinks("https://example.com/a/b.html", findTerminalLinks("https://example.com/a/b.html"))).toEqual([]);
  });
});

describe("resolveTerminalPath", () => {
  it("joins a relative path onto the shell's directory and folds dots", () => {
    expect(resolveTerminalPath("src/a.ts", "/project")).toBe("/project/src/a.ts");
    expect(resolveTerminalPath("./x/../y.ts", "/project/")).toBe("/project/y.ts");
    expect(resolveTerminalPath("../b.ts", "/project/api")).toBe("/project/b.ts");
    expect(resolveTerminalPath("../../../b.ts", "/project")).toBeUndefined();
    expect(resolveTerminalPath("src/a.ts", undefined)).toBeUndefined();
  });

  it("keeps a rooted path and infers the home for ~", () => {
    expect(resolveTerminalPath("/etc/hosts", undefined)).toBe("/etc/hosts");
    expect(resolveTerminalPath("~/n.md", "/Users/ann/work")).toBe("/Users/ann/n.md");
    expect(resolveTerminalPath("~/n.md", "/srv/work")).toBeUndefined();
    expect(resolveTerminalPath("~\\n.md", "C:\\Users\\ann\\work")).toBe("C:/Users/ann/n.md");
  });

  it("reads backslashes as separators only for Windows shells and paths", () => {
    expect(resolveTerminalPath("C:\\work\\a.ts", undefined)).toBe("C:/work/a.ts");
    expect(resolveTerminalPath("src\\a.ts", "C:\\work")).toBe("C:/work/src/a.ts");
    expect(resolveTerminalPath("\\\\host\\share\\a.ts", undefined)).toBe("//host/share/a.ts");
    expect(resolveTerminalPath("src\\a.ts", "/project")).toBeUndefined();
  });
});
