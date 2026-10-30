import { describe, expect, it } from "vitest";
import { passiveKind, type PassiveContent, type PassiveKind } from "./passive-preview.js";
import { previewParser } from "./preview-parser.js";
import { DOCX, EPUB, PPTX, XLSX, tarFixture, zipFixture } from "./preview-fixtures.js";

function parse(parts: Record<string, string | Uint8Array>, path: string) {
  return previewParser({ bytes: zipFixture(parts, { compressed: true }), path, kind: passiveKind(path)! });
}
function content<K extends PassiveKind>(parts: Record<string, string | Uint8Array>, path: string, kind: K): Extract<PassiveContent, { kind: K }> {
  const result = parse(parts, path); if (!result.ok) throw new Error(result.error);
  expect(result.content.kind).toBe(kind); return result.content as Extract<PassiveContent, { kind: K }>;
}

describe("bounded passive document parser", () => {
  it("extracts DOCX headings, paragraphs, image placeholders and tables", () => {
    expect(content(DOCX, "file.docx", "document").blocks).toEqual([
      { kind: "heading", level: 1, text: "Saved title" }, { kind: "paragraph", text: "Text & detail[Image]" }, { kind: "table", rows: [["Cell"]] },
    ]);
  });
  it("shows XLSX cached values and inert formula titles, bounded by row and column", () => {
    const result = parse(XLSX, "file.xlsx"); expect(result.ok).toBe(true); if (!result.ok || result.content.kind !== "sheet") return;
    const sheet = result.content.sheets[0]!;
    expect(sheet.rowCount).toBe(25300); expect(sheet.rows).toHaveLength(1); expect(sheet.rows[0]).toHaveLength(50);
    expect(sheet.rows[0]?.[0]).toEqual({ value: "Saved cell" });
    expect(sheet.rows[0]?.[1]).toEqual({ value: "42", formula: 'WEBSERVICE("https://example.test")' });
    expect(JSON.stringify(result)).not.toContain("omitted row"); expect(JSON.stringify(result)).not.toContain("omitted column");
    expect(result.notices).toContain("Showing the first 1,000 rows of 25,300.");
  });
  it("follows internal presentation ordering and speaker notes", () => {
    expect(content(PPTX, "file.pptx", "slides").slides).toEqual([{ title: "Slide 1", blocks: [{ kind: "paragraph", text: "Saved slide" }], notes: [{ kind: "paragraph", text: "Saved notes" }] }]);
  });
  it("extracts EPUB metadata and spine text without executable content or links", () => {
    const book = content(EPUB, "file.epub", "book"); expect(book.title).toBe("Saved book"); expect(book.author).toBe("Writer");
    expect(book.chapters[0]?.title).toBe("First chapter"); expect(JSON.stringify(book)).toContain("Saved link label");
    expect(JSON.stringify(book)).not.toMatch(/execute|https:/u);
  });
  it("lists encrypted ZIP entries, nested archives and traversal names without reading their contents", () => {
    const bytes = zipFixture({ "../outside": "secret", "folder/nested.zip": "nested", "folder/": "" }, { encrypted: true });
    const result = previewParser({ bytes, path: "file.zip", kind: "archive" });
    expect(result).toMatchObject({ ok: true, content: { entries: [{ name: "../outside", encrypted: true }, { name: "folder/nested.zip" }, { directory: true }] } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each([false, true])("lists TAR links and parent paths without following them, gzip=%s", (gzip) => {
    const bytes = tarFixture([{ name: "../outside", body: "secret" }, { name: "link", link: "/etc/passwd" }], gzip);
    const result = previewParser({ bytes, path: gzip ? "file.tgz" : "file.tar", kind: "archive" });
    expect(result).toMatchObject({ ok: true, content: { entries: [{ name: "../outside" }, { name: "link", link: "/etc/passwd" }] } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("reads OpenDocument text and repeated spreadsheet cells within limits", () => {
    const document = content({ "content.xml": '<document><text><h>Title</h><p>Text</p></text></document>' }, "a.odt", "document");
    expect(document.blocks[0]).toMatchObject({ kind: "heading", text: "Title" });
    const sheet = content({ "content.xml": '<document><table table:name="Sheet"><table-row table:number-rows-repeated="100000"><table-cell table:number-columns-repeated="100000"><p>Saved</p></table-cell></table-row></table></document>' }, "a.ods", "sheet");
    expect(sheet.sheets[0]?.rowCount).toBe(100000); expect(sheet.sheets[0]?.rows).toHaveLength(1000); expect(sheet.sheets[0]?.rows[0]).toHaveLength(50);
  });
  it("reads passive RTF text, Unicode and image placeholders while omitting destinations", () => {
    expect(previewParser({ bytes: Buffer.from('{\\rtf1{\\fonttbl hidden}Hello \\u252?nicode\\par{\\pict 1234}{\\object dangerous}}'), path: "a.rtf", kind: "document" })).toMatchObject({ ok: true, content: { blocks: [{ text: "Hello ünicode" }, { text: "[Image]" }] } });
  });
  it.each(['<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>', '<doc><p>bad</doc>', '<doc>&unknown;</doc>', '<doc>' + '<p>'.repeat(70) + 'x' + '</p>'.repeat(70) + '</doc>'])("fails closed on unsupported or malformed XML", (xml) => {
    expect(parse({ "word/document.xml": xml }, "a.docx")).toMatchObject({ ok: false });
  });
  it("refuses external package relationships and never decodes a nested archive", () => {
    const result = parse({ ...XLSX, "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="sheet1" Target="file:///etc/passwd"/></Relationships>' }, "a.xlsx");
    expect(result).toMatchObject({ ok: false });
  });
  it("caps ZIP entries, declared unpacked size, actual inflated XML and output text", () => {
    const tooMany = zipFixture({ x: "" }); tooMany.writeUInt16LE(10001, tooMany.length - 12);
    expect(previewParser({ bytes: tooMany, path: "a.zip", kind: "archive" })).toMatchObject({ ok: false, reason: "limit" });
    const bomb = zipFixture(DOCX); const directory = bomb.readUInt32LE(bomb.length - 6); bomb.writeUInt32LE(101 * 1024 * 1024, directory + 24);
    expect(previewParser({ bytes: bomb, path: "a.docx", kind: "document" })).toMatchObject({ ok: false, reason: "limit" });
    expect(parse({ "word/document.xml": '<doc><p>' + 'x'.repeat(4 * 1024 * 1024) + '</p></doc>' }, "a.docx")).toMatchObject({ ok: false });
    const result = parse({ "word/document.xml": '<doc><p>' + 'x'.repeat(200001) + '</p></doc>' }, "a.docx");
    expect(result).toMatchObject({ ok: true, content: { blocks: [{ text: 'x'.repeat(200000) }] }, notices: [expect.stringContaining("200,000")] });
  });
  it("detects corrupt CRCs, encrypted document parts, truncated data and binary .db files", () => {
    const corrupt = zipFixture(DOCX); corrupt[60] = corrupt[60]! ^ 1;
    expect(previewParser({ bytes: corrupt, path: "a.docx", kind: "document" })).toMatchObject({ ok: false });
    expect(previewParser({ bytes: zipFixture(DOCX, { encrypted: true }), path: "a.docx", kind: "document" })).toMatchObject({ ok: false });
    for (const bytes of [Buffer.alloc(0), Buffer.from("not a database"), zipFixture(DOCX).subarray(0, 20)]) expect(previewParser({ bytes, path: "a.docx", kind: "document" })).toMatchObject({ ok: false });
    expect(previewParser({ bytes: Buffer.from("opaque"), path: "a.db", kind: "database" })).toMatchObject({ ok: false });
  });
});

it("charges repeated ODS rows against the serialized text budget", () => {
  const result = parse({ "content.xml": '<document><table><table-row table:number-rows-repeated="1000"><table-cell><p>' + 'x'.repeat(200000) + '</p></table-cell></table-row></table></document>' }, "large.ods");
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThan(300000);
});
