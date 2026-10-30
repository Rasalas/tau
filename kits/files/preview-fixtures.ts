/** Tiny generated fixtures, independent of office software and external files. */
import { deflateRawSync, gzipSync } from "node:zlib";
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFixture(parts: Record<string, string | Uint8Array>, { compressed = false, encrypted = false } = {}): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [path, value] of Object.entries(parts)) {
    const name = Buffer.from(path); const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const packed = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(encrypted ? 1 : 0, 6); header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(encrypted ? 1 : 0, 8); entry.writeUInt16LE(compressed ? 8 : 0, 10); entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function tarFixture(entries: { name: string; body?: string; link?: string }[], gzip = false): Buffer {
  const pieces: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512); const body = Buffer.from(entry.body ?? "");
    header.write(entry.name, 0, 100); header.write("0000600\0", 100); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write(entry.link ? "2" : "0", 156); if (entry.link) header.write(entry.link, 157, 100); header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    pieces.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  pieces.push(Buffer.alloc(1024)); const result = Buffer.concat(pieces); return gzip ? gzipSync(result) : result;
}
export const DOCX = { "word/document.xml": '<w:document xmlns:w="word"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Saved title</w:t></w:r></w:p><w:p><w:r><w:t>Text &amp; detail</w:t></w:r><w:drawing/></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' };
export const XLSX = {
  "xl/workbook.xml": '<workbook><sheets><sheet name="Numbers" r:id="sheet1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><t>Saved cell</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><dimension ref="A1:AX25300"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>WEBSERVICE("https://example.test")</f><v>42</v></c><c r="AX1"><v>last column</v></c><c r="AY1"><v>omitted column</v></c></row><row r="1001"><c r="A1001"><v>omitted row</v></c></row></sheetData></worksheet>',
};
export const PPTX = {
  "ppt/presentation.xml": '<presentation><sldIdLst><sldId r:id="one"/></sldIdLst></presentation>',
  "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="one" Target="slides/slide1.xml"/></Relationships>',
  "ppt/slides/slide1.xml": '<sld><p><r><t>Saved slide</t></r></p></sld>',
  "ppt/slides/_rels/slide1.xml.rels": '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  "ppt/notesSlides/notesSlide1.xml": '<notes><p><t>Saved notes</t></p></notes>',
};
export const EPUB = {
  "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
  "OEBPS/book.opf": '<package><metadata><title>Saved book</title><creator>Writer</creator></metadata><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  "OEBPS/one.xhtml": '<html><head><title>Chapter one</title><script>execute()</script></head><body><h1>First chapter</h1><p>Saved <a href="https://example.test">link label</a></p></body></html>',
};
