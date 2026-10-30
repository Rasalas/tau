import { describe, expect, it } from "vitest";
import { fileViewKind, RENDERED_BY_DEFAULT, renderedMode, renderedToggleLabel, tableDelimiter } from "./file-kind.js";
import { parseDelimited, TABLE_MAX_ROWS } from "./delimited.js";

describe("how a file is drawn", () => {
  it("routes passive formats to document previews without a source toggle", () => {
    for (const [path, kind] of [["A.DOCX", "document"], ["a.odt", "document"], ["a.rtf", "document"], ["a.xlsx", "sheet"], ["a.ods", "sheet"], ["a.pptx", "slides"], ["a.odp", "slides"], ["a.tar.gz", "archive"], ["a.zip", "archive"], ["a.sqlite3", "database"], ["a.db", "database"], ["a.epub", "book"]]) {
      expect(fileViewKind(path!)).toBe(kind); expect(renderedMode(path!)).toBeUndefined();
    }
  });
  it("chooses the viewer by the file's extension", () => {
    expect(fileViewKind("docs/paper.PDF")).toBe("pdf");
    expect(fileViewKind("assets/logo.svg")).toBe("image");
    expect(fileViewKind("a/b/clip.mov")).toBe("video");
    expect(fileViewKind("sound.m4a")).toBe("audio");
    expect(fileViewKind("src/index.ts")).toBe("text");
    expect(fileViewKind("Makefile")).toBe("text");
    expect(fileViewKind(".png")).toBe("text");
  });

  it("offers a rendered view for Markdown, HTML, tables and notebooks", () => {
    expect(renderedMode("README.md")).toBe("markdown");
    expect(renderedMode("site/index.htm")).toBe("html");
    expect(renderedMode("data.tsv")).toBe("table");
    expect(fileViewKind("analysis.IPYNB")).toBe("text");
    expect(renderedMode("analysis.IPYNB")).toBe("notebook");
    expect(renderedMode(".ipynb")).toBeUndefined();
    expect(renderedMode("analysis.ipynb.txt")).toBeUndefined();
    expect(RENDERED_BY_DEFAULT.notebook).toBe(true);
    expect(tableDelimiter("data.tsv")).toBe("\t");
    expect(tableDelimiter("data.csv")).toBe(",");
    expect(renderedMode("src/app.tsx")).toBeUndefined();
    expect(renderedToggleLabel("markdown", false)).toBe("Show rendered markdown");
    expect(renderedToggleLabel("table", true)).toBe("Show source");
    expect(renderedToggleLabel("notebook", true)).toBe("Show notebook source");
    expect(renderedToggleLabel("notebook", false)).toBe("Show rendered notebook");
  });
});

describe("parseDelimited", () => {
  it("reads quoted fields with delimiters, quotes and line breaks inside", () => {
    const table = parseDelimited('name,note\n"Smith, J","said ""hi""\nthen left"\r\nDoe,\n', ",");
    expect(table).toEqual({ rows: [["name", "note"], ["Smith, J", "said \"hi\"\nthen left"], ["Doe", ""]], truncated: false });
    expect(parseDelimited("a\tb\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("stops at the rows and columns the table draws and says so", () => {
    const many = Array.from({ length: TABLE_MAX_ROWS + 5 }, (_, index) => `${index},x`).join("\n");
    const table = parseDelimited(many, ",");
    expect(table.rows).toHaveLength(TABLE_MAX_ROWS);
    expect(table.truncated).toBe(true);
    expect(parseDelimited(Array.from({ length: 40 }, (_, index) => String(index)).join(","), ",")).toMatchObject({ truncated: true });
    expect(parseDelimited(Array.from({ length: TABLE_MAX_ROWS }, () => "a").join("\n") + "\n", ",").truncated).toBe(false);
  });
});
