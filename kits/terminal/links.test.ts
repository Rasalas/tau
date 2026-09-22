import { describe, expect, it } from "vitest";
import { classifyTerminalLink, findTerminalLinks, positionIn, wrappedLineAt } from "./links.js";

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
});
