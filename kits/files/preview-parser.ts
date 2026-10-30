import type { ArchiveEntry, PassiveContent, PassiveKind, PassivePreview, PreviewBlock, PreviewSheet } from "./passive-preview.js";

/**
 * Self-contained program serialized into a disposable Node worker. No closure
 * values or imported runtime code: the bundled host needs no extra worker asset.
 * All data is text, tables or metadata; no authored markup reaches the renderer.
 */
export function previewParser(input: { bytes: Uint8Array; path: string; kind: PassiveKind; databasePath?: string; table?: string }): PassivePreview {
  const zlib = process.getBuiltinModule("zlib");
  const bytes = Buffer.from(input.bytes);
  const start = Date.now();
  const MAX_UNPACKED = 100 * 1024 * 1024;
  const MAX_PART = 4 * 1024 * 1024;
  const MAX_TEXT = 200_000;
  const notices: string[] = [];
  let textLeft = MAX_TEXT;
  let inflated = 0;
  let xmlNodes = 0;
  let tableCells = 0;
  function accountCells(count: number) { tableCells += count; if (tableCells > 50_000) limit("Preview exceeds 50,000 table cells. Open it in another app."); }
  function limit(message = "Preview limit reached. Open it in another app for the full file."): never { throw new Error(`LIMIT:${message}`); }
  function check() { if (Date.now() - start > 2_500) limit("Reading this file took too long. Open it in another app."); }
  function text(value: string): string {
    const kept = value.slice(0, Math.max(0, textLeft));
    textLeft -= kept.length;
    if (kept.length < value.length && !notices.includes("Document text limited to 200,000 characters.")) notices.push("Document text limited to 200,000 characters.");
    return kept;
  }
  function decode(data: Uint8Array): string {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    return new TextDecoder(encoding, { fatal: true }).decode(data).replace(/^\uFEFF/u, "");
  }
  type Xml = { name: string; attrs: Record<string, string>; children: (Xml | string)[] };
  function entity(value: string): string {
    return value.replace(/&([^;]*);/gu, (_all, name: string) => {
      const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (Object.hasOwn(known, name)) return known[name]!;
      const code = /^#x[\da-f]+$/iu.test(name) ? Number.parseInt(name.slice(2), 16) : /^#\d+$/u.test(name) ? Number(name.slice(1)) : NaN;
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Error("Unsupported XML entity");
      return String.fromCodePoint(code);
    });
  }
  // A deliberately small XML subset. No DTD, entities, styles, resource loads,
  // HTML repair or namespaces-as-code. Unsupported input fails closed.
  function xml(data: Uint8Array): Xml {
    if (data.byteLength > MAX_PART) limit("XML part exceeds 4 MB. Open it in another app.");
    const source = decode(data);
    const root: Xml = { name: "root", attrs: {}, children: [] };
    const stack = [root];
    const tags: string[] = [];
    let offset = 0;
    while (offset < source.length) {
      check();
      const end = source.indexOf("<", offset);
      const raw = source.slice(offset, end < 0 ? source.length : end);
      if (raw.includes("&") && /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/iu.test(raw)) throw new Error("Unsupported XML entity");
      if (stack.length === 1 && raw.trim()) throw new Error("Text outside XML root");
      if (raw) stack.at(-1)!.children.push(entity(raw));
      if (end < 0) break;
      if (source.startsWith("<!--", end)) {
        const stop = source.indexOf("-->", end + 4); if (stop < 0) throw new Error("Bad XML comment"); offset = stop + 3; continue;
      }
      if (source.startsWith("<![CDATA[", end)) {
        const stop = source.indexOf("]]>", end + 9); if (stop < 0) throw new Error("Bad CDATA");
        stack.at(-1)!.children.push(source.slice(end + 9, stop)); offset = stop + 3; continue;
      }
      if (source.startsWith("<?xml ", end) && end < 5) {
        const stop = source.indexOf("?>", end + 5); if (stop < 0) throw new Error("Bad XML declaration"); offset = stop + 2; continue;
      }
      if (input.kind === "book" && /^<!DOCTYPE html\s*>/iu.test(source.slice(end, end + 64))) {
        offset = source.indexOf(">", end) + 1; continue;
      }
      if (source.startsWith("<!", end) || source.startsWith("<?", end)) throw new Error("Unsupported XML declaration");
      // Scan quoted attributes before accepting a closing >.
      let stop = end + 1; let quote = "";
      for (; stop < source.length; stop++) {
        const char = source[stop]!;
        if (quote) { if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      if (stop >= source.length || stop - end > 64 * 1024) throw new Error("Bad XML tag");
      const tag = source.slice(end + 1, stop);
      offset = stop + 1;
      if (tag.startsWith("/")) {
        if (stack.length <= 1 || tags.pop() !== tag.slice(1).trim()) throw new Error("Unbalanced XML");
        stack.pop(); continue;
      }
      const match = /^([\w:.-]+)([\s\S]*?)(\/?)$/u.exec(tag);
      if (!match) throw new Error("Bad XML element");
      if (++xmlNodes > 250_000 || stack.length > 64) limit("XML structure is too large for preview.");
      const attrs: Record<string, string> = Object.create(null);
      let rest = match[2]!; let count = 0;
      while (rest.trim()) {
        const attr = /^\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u.exec(rest);
        if (!attr || ++count > 64 || Object.hasOwn(attrs, attr[1]!)) throw new Error("Bad XML attributes");
        attrs[attr[1]!] = entity(attr[2] ?? attr[3] ?? ""); rest = rest.slice(attr[0].length);
      }
      const node: Xml = { name: match[1]!.split(":").at(-1)!, attrs, children: [] };
      stack.at(-1)!.children.push(node);
      if (!match[3]) { stack.push(node); tags.push(match[1]!); }
    }
    if (stack.length !== 1 || root.children.filter((child) => typeof child !== "string").length !== 1) throw new Error("Unbalanced XML");
    return root;
  }
  function children(node: Xml, name?: string): Xml[] { return node.children.filter((child): child is Xml => typeof child !== "string" && (!name || child.name === name)); }
  function all(node: Xml, name: string): Xml[] { return children(node).flatMap((child) => child.name === name ? [child] : all(child, name)); }
  function plain(node: Xml): string {
    if (["script", "style", "iframe", "object", "embed", "binary-data"].includes(node.name)) return "";
    if (["img", "image", "drawing", "pict"].includes(node.name)) return "[Image]";
    if (["br", "line-break"].includes(node.name)) return "\n";
    if (node.name === "tab") return "\t";
    return node.children.map((child) => typeof child === "string" ? child : plain(child)).join("");
  }
  function blocks(node: Xml): PreviewBlock[] {
    const result: PreviewBlock[] = [];
    function visit(current: Xml) {
      if (result.length >= 5_000 || textLeft <= 0) return;
      const name = current.name;
      if (["script", "style", "iframe", "object", "embed"].includes(name)) return;
      if (["tbl", "table"].includes(name)) {
        const rows = [...all(current, "tr"), ...all(current, "table-row")].slice(0, 1000).map((row) => children(row).filter((cell) => ["tc", "table-cell", "td", "th"].includes(cell.name)).slice(0, 50).map((cell) => text(plain(cell).trim())));
        accountCells(rows.reduce((sum, row) => sum + row.length, 0)); result.push({ kind: "table", rows }); return;
      }
      if (["p", "h", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(name)) {
        const style = all(current, "pStyle")[0]?.attrs["w:val"] ?? "";
        const heading = /heading\s*([1-6])/iu.exec(style)?.[1] ?? /^h([1-6])$/u.exec(name)?.[1];
        const isHeading = Boolean(heading) || name === "h";
        result.push({ kind: isHeading ? "heading" : name === "li" || all(current, "numPr").length > 0 ? "list" : "paragraph", text: text(plain(current).trim()), ...(isHeading ? { level: Number(heading ?? 2) } : {}) }); return;
      }
      for (const child of children(current)) visit(child);
    }
    visit(node); return result;
  }
  type Entry = ArchiveEntry & { offset: number; packed: number; method: number; crc?: number };
  let entries: Entry[] = [];
  let archive: Buffer = bytes;
  let unpacked = 0;
  function zip() {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Unsupported ZIP directory");
    const count = bytes.readUInt16LE(end + 10);
    if (count > 10_000) limit("Archive exceeds 10,000 entries.");
    const size = bytes.readUInt32LE(end + 12);
    let offset = bytes.readUInt32LE(end + 16);
    if (offset + size !== end || bytes.readUInt16LE(end + 8) !== count) throw new Error("Bad ZIP directory");
    for (let i = 0; i < count; i++) {
      check();
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad ZIP entry");
      const flags = bytes.readUInt16LE(offset + 8);
      const length = bytes.readUInt16LE(offset + 28);
      const extra = bytes.readUInt16LE(offset + 30);
      const comment = bytes.readUInt16LE(offset + 32);
      if (length > 4096 || offset + 46 + length + extra + comment > end) throw new Error("Bad ZIP name");
      const name = bytes.subarray(offset + 46, offset + 46 + length).toString(flags & 0x800 ? "utf8" : "latin1");
      const packed = bytes.readUInt32LE(offset + 20); const entrySize = bytes.readUInt32LE(offset + 24);
      unpacked += entrySize;
      if (unpacked > MAX_UNPACKED || packed > bytes.length || entrySize === 0xffffffff) limit("Archive exceeds 100 MB unpacked or uses ZIP64.");
      const date = bytes.readUInt16LE(offset + 14); const time = bytes.readUInt16LE(offset + 12);
      const modified = date ? `${1980 + (date >> 9)}-${String(date >> 5 & 15).padStart(2, "0")}-${String(date & 31).padStart(2, "0")} ${String(time >> 11).padStart(2, "0")}:${String(time >> 5 & 63).padStart(2, "0")}` : undefined;
      entries.push({ name, size: entrySize, packed, offset: bytes.readUInt32LE(offset + 42), method: bytes.readUInt16LE(offset + 10), encrypted: Boolean(flags & 1), directory: name.endsWith("/"), modified, crc: bytes.readUInt32LE(offset + 16) });
      offset += 46 + length + extra + comment;
    }
    if (offset !== end) throw new Error("Bad ZIP directory size");
  }
  function tar() {
    if (/\.(tgz|gz)$/iu.test(input.path)) archive = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED });
    function field(offset: number, length: number) { return archive.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/su, ""); }
    function octal(offset: number, length: number) { const raw = field(offset, length).trim(); if (!/^[0-7]*$/u.test(raw)) throw new Error("Unsupported TAR number"); return raw ? Number.parseInt(raw, 8) : 0; }
    let nextName: string | undefined;
    let pending: Record<string, string> = Object.create(null);
    let headers = 0;
    for (let offset = 0; offset + 512 <= archive.length;) {
      check();
      if (archive.subarray(offset, offset + 512).every((b) => b === 0)) return;
      if (++headers > 10_000) limit("Archive exceeds 10,000 entries.");
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : archive[offset + index]!;
      if (checksum !== octal(offset + 148, 8)) throw new Error("Bad TAR checksum");
      const size = octal(offset + 124, 12); const type = field(offset + 156, 1);
      const body = offset + 512;
      if (!Number.isSafeInteger(size) || body + size > archive.length || size > MAX_UNPACKED) throw new Error("Bad TAR length");
      if (type === "L") {
        if (size > 4096) limit(); nextName = field(body, size);
      } else if (type === "x" || type === "g") {
        if (size > 1024 * 1024 || type === "g") throw new Error("Unsupported TAR metadata");
        let position = body;
        pending = Object.create(null);
        while (position < body + size) {
          const space = archive.indexOf(32, position); const len = Number(field(position, space - position));
          if (!Number.isSafeInteger(len) || len < 5 || position + len > body + size || space < position) throw new Error("Bad PAX length");
          const line = field(space + 1, position + len - space - 2); const equal = line.indexOf("=");
          if (equal > 0) pending[line.slice(0, equal)] = line.slice(equal + 1); position += len;
        }
      } else {
        const name = pending.path ?? nextName ?? [field(offset + 345, 155), field(offset, 100)].filter(Boolean).join("/");
        if (name.length > 4096 || Object.keys(pending).some((key) => key.startsWith("GNU.sparse") || key === "size" && Number(pending[key]) !== size)) throw new Error("Unsupported TAR metadata");
        unpacked += size; if (unpacked > MAX_UNPACKED) limit("Archive exceeds 100 MB unpacked.");
        const seconds = Number(pending.mtime ?? octal(offset + 136, 12));
        const date = new Date(seconds * 1000);
        entries.push({ name, size, packed: size, offset: body, method: 0, directory: type === "5", encrypted: false, ...(Number.isFinite(date.getTime()) ? { modified: date.toISOString() } : {}), ...(["1", "2"].includes(type) ? { link: pending.linkpath ?? field(offset + 157, 100) } : {}) });
        pending = Object.create(null); nextName = undefined;
      }
      offset = body + Math.ceil(size / 512) * 512;
    }
    throw new Error("Truncated TAR");
  }
  function part(name: string): Buffer {
    // Resolve only names in the directory, never host paths or archive links.
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("Invalid package path");
    const matches = entries.filter((entry) => entry.name === name);
    if (matches.length !== 1) throw new Error("Missing or duplicate package part");
    const entry = matches[0]!;
    if (entry.size > MAX_PART || entry.encrypted || ![0, 8].includes(entry.method)) throw new Error("Unsupported package part");
    inflated += entry.size; if (inflated > 32 * 1024 * 1024) limit("Package exceeds 32 MB of parsed parts.");
    const offset = entry.offset;
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid local ZIP entry");
    const begin = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (begin + entry.packed > bytes.length) throw new Error("Truncated ZIP part");
    const compressed = bytes.subarray(begin, begin + entry.packed);
    const result = entry.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: MAX_PART }) : compressed;
    if (result.length !== entry.size) throw new Error("ZIP size mismatch");
    let crc = 0xffffffff;
    for (const byte of result) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    if ((crc ^ 0xffffffff) >>> 0 !== entry.crc) throw new Error("ZIP checksum mismatch");
    check(); return result;
  }
  function parsed(name: string) { return xml(part(name)); }
  function relation(base: string, target: string): string {
    target = decodeURIComponent(target);
    if (/^[a-z]+:|^[\\/]/iu.test(target)) throw new Error("External package relation");
    const output = base.split("/"); output.pop();
    for (const segment of target.split("/")) { if (segment === "..") { if (!output.length) throw new Error("Package escape"); output.pop(); } else if (segment && segment !== ".") output.push(segment); }
    return output.join("/");
  }
  function relationships(name: string): Map<string, string> {
    const [folder, leaf] = [name.slice(0, name.lastIndexOf("/") + 1), name.slice(name.lastIndexOf("/") + 1)];
    const path = `${folder}_rels/${leaf}.rels`;
    const map = new Map<string, string>();
    if (!entries.some((entry) => entry.name === path)) return map;
    for (const rel of all(parsed(path), "Relationship")) {
      if (rel.attrs.TargetMode === "External") continue;
      if (rel.attrs.Id && rel.attrs.Target) map.set(rel.attrs.Id, relation(name, rel.attrs.Target));
    }
    return map;
  }
  function sheets(): PassiveContent {
    const shared = entries.some((entry) => entry.name === "xl/sharedStrings.xml") ? all(parsed("xl/sharedStrings.xml"), "si").map((node) => plain(node).slice(0, 32 * 1024)) : [];
    const workbook = parsed("xl/workbook.xml"); const rels = relationships("xl/workbook.xml");
    const names = all(workbook, "sheet");
    if (names.length > 50) notices.push("Showing the first 50 sheets.");
    const result: PreviewSheet[] = [];
    for (const sheet of names.slice(0, 50)) {
      check(); const path = rels.get(sheet.attrs["r:id"] ?? ""); if (!path) continue;
      const node = parsed(path); const sourceRows = all(node, "row");
      const dimension = all(node, "dimension")[0]?.attrs.ref ?? "";
      const last = Number(/\d+$/u.exec(dimension)?.[0] ?? 0);
      const rowCount = sourceRows.reduce((count, row) => Math.max(count, Number(row.attrs.r) || 0), last);
      const rows: PreviewSheet["rows"] = [];
      for (const row of sourceRows) {
        const rowIndex = Number(row.attrs.r) || rows.length + 1;
        if (!Number.isSafeInteger(rowIndex) || rowIndex < 1) throw new Error("Bad worksheet row");
        if (rowIndex > 1000) continue;
        while (rows.length < rowIndex) rows.push([]);
        const values = rows[rowIndex - 1]!;
        for (const cell of children(row, "c")) {
          const letters = /^[A-Z]+/u.exec(cell.attrs.r ?? "")?.[0];
          const column = letters ? [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1 : values.length;
          if (column >= 50) { if (!notices.includes("Showing the first 50 columns.")) notices.push("Showing the first 50 columns."); continue; }
          const raw = plain(all(cell, "v")[0] ?? { name: "empty", attrs: {}, children: [] });
          const value = cell.attrs.t === "s" ? shared[Number(raw)] ?? "" : cell.attrs.t === "inlineStr" ? plain(cell) : cell.attrs.t === "b" ? raw === "1" ? "TRUE" : "FALSE" : raw;
          while (values.length <= column) values.push({ value: "" });
          const formula = all(cell, "f")[0]; values[column] = { value: text(value), ...(formula ? { formula: text(plain(formula)) } : {}) };
        }
      }
      accountCells(rows.reduce((sum, row) => sum + row.length, 0));
      result.push({ name: text(sheet.attrs.name ?? `Sheet ${result.length + 1}`), rowCount, rows });
      if (rowCount > 1000) notices.push(`Showing the first 1,000 rows of ${rowCount.toLocaleString("en-US")}.`);
    }
    return { kind: "sheet", sheets: result };
  }
  function rtf(): PassiveContent {
    if (bytes.length > MAX_PART) limit("RTF file exceeds the 4 MB parsing limit.");
    const source = bytes.toString("latin1");
    if (!source.startsWith("{\\rtf")) throw new Error("Invalid RTF");
    const stack = [{ skip: false, unicode: 1 }];
    let output = ""; let fallback = 0;
    for (let offset = 0; offset < source.length && output.length <= MAX_TEXT; offset++) {
      check();
      const state = stack.at(-1)!; const char = source[offset]!;
      if (char === "{") { if (stack.length > 64) limit("RTF nesting limit reached."); stack.push({ ...state }); }
      else if (char === "}") { if (stack.length <= 1) throw new Error("Bad RTF group"); stack.pop(); }
      else if (char === "\\") {
        const escaped = source[++offset];
        if (escaped === "\\" || escaped === "{" || escaped === "}") { if (!state.skip && !fallback) output += escaped; else if (fallback) fallback--; }
        else if (escaped === "*") state.skip = true;
        else if (escaped === "'") {
          const hex = source.slice(offset + 1, offset + 3); if (!/^[\da-f]{2}$/iu.test(hex)) throw new Error("Bad RTF escape");
          if (!state.skip && !fallback) output += new TextDecoder("windows-1252").decode(Uint8Array.of(Number.parseInt(hex, 16))); else if (fallback) fallback--;
          offset += 2;
        } else {
          const match = /^([a-z]+)(-?\d+)? ?/iu.exec(source.slice(offset));
          if (!match) continue;
          offset += match[0].length - 1; const word = match[1]!; const number = Number(match[2]);
          if (["fonttbl", "colortbl", "stylesheet", "info", "object", "fldinst", "header", "footer", "filetbl", "datastore"].includes(word)) state.skip = true;
          else if (word === "pict") { if (!state.skip) output += "[Image]"; state.skip = true; }
          else if (word === "bin") { if (!Number.isSafeInteger(number) || number < 0 || offset + number >= source.length) throw new Error("Bad RTF binary length"); offset += number; }
          else if (word === "uc") state.unicode = Math.max(0, Math.min(16, number || 0));
          else if (!state.skip && word === "u") { output += String.fromCharCode(number & 0xffff); fallback = state.unicode; }
          else if (!state.skip && ["par", "line", "tab"].includes(word)) output += word === "tab" ? "\t" : "\n";
        }
      } else if (!state.skip && char !== "\r" && char !== "\n") { if (fallback) fallback--; else output += char; }
    }
    if (output.length <= MAX_TEXT && stack.length !== 1) throw new Error("Unbalanced RTF");
    if (output.split("\n").length > 5000) notices.push("Showing the first 5,000 paragraphs.");
    if (output.length > MAX_TEXT) notices.push("Document text limited to 200,000 characters.");
    return { kind: "document", blocks: output.split("\n").slice(0, 5000).map((line) => ({ kind: "paragraph", text: text(line) })) };
  }
  function database(): PassiveContent {
    if (bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\0" || !input.databasePath) throw new Error("Not SQLite");
    const sqlite = process.getBuiltinModule("node:sqlite");
    const db = new sqlite.DatabaseSync(input.databasePath, { readOnly: true, allowExtension: false, timeout: 100 });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;");
      const rawTables = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 101").all().slice(0, 100);
      // Safety decisions use the original schema, never budgeted display text.
      const virtualTables = new Set(rawTables.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(String(row.sql ?? ""))).map((row) => String(row.name)));
      const tables = rawTables.map((row) => ({ name: String(row.name).slice(0, 1024), type: String(row.type), schema: text(String(row.sql ?? "").slice(0, 8192)) }));
      if (tables.length === 100) notices.push("Showing at most 100 tables and views.");
      const selected = tables.find((table) => table.name === input.table) ?? tables[0];
      if (!selected) return { kind: "database", tables, selected: "", columns: [], rows: [] };
      if (selected.type === "view" || virtualTables.has(selected.name)) {
        notices.push("Rows of views and virtual tables are omitted. Their schema is shown without executing stored SQL.");
        return { kind: "database", tables, selected: selected.name, columns: [], rows: [] };
      }
      const columns = db.prepare("SELECT name FROM pragma_table_info(?) LIMIT 51").all(selected.name).map((row) => String(row.name));
      if (columns.length > 50) notices.push("Showing the first 50 columns.");
      let approximateRows: number | undefined;
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_stat1'").get()) {
        const stat = db.prepare("SELECT substr(stat,1,32) AS stat FROM sqlite_stat1 WHERE tbl=? LIMIT 1").get(selected.name);
        const count = Number(String(stat?.stat ?? "").split(" ")[0]);
        if (/^\d+(?: |$)/u.test(String(stat?.stat ?? "")) && Number.isSafeInteger(count) && count >= 0) approximateRows = count;
      }
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const kept = columns.slice(0, 50);
      if (!kept.length) throw new Error("No readable columns");
      const sql = kept.map((name) => `CASE WHEN typeof(${quote(name)})='blob' THEN 'BLOB · ' || length(${quote(name)}) || ' B' ELSE substr(CAST(${quote(name)} AS TEXT),1,1024) END`).join(",");
      const statement = db.prepare(`SELECT ${sql} FROM ${quote(selected.name)} LIMIT 201`);
      statement.setReturnArrays(true);
      const values = statement.all() as unknown as unknown[][];
      if (values.length > 200) notices.push("Showing the first 200 rows. Open it in another app for the full database.");
      notices.push("Snapshot of the database file. Uncheckpointed WAL changes are not included.");
      return { kind: "database", tables, selected: selected.name, ...(approximateRows !== undefined ? { approximateRows } : {}), columns: kept, rows: values.slice(0, 200).map((row) => row.map((value) => text(value === null ? "NULL" : String(value)))) };
    } finally { db.close(); }
  }
  try {
    if (bytes.length > 20 * 1024 * 1024) return { ok: false, reason: "size", error: "This file is larger than 20 MB. Open it in another app." };
    let content: PassiveContent;
    if (input.kind === "database") content = database();
    else if (/\.rtf$/iu.test(input.path)) content = rtf();
    else {
      if (input.kind === "archive" && /\.(tar|tgz|tar\.gz)$/iu.test(input.path)) tar(); else zip();
      if (input.kind === "archive") content = { kind: "archive", entries: entries.map(({ name, size, directory, modified, encrypted, link }) => ({ name, size, directory, modified, encrypted, link })), unpackedBytes: unpacked };
      else if (/\.(odt|ods|odp)$/iu.test(input.path)) {
        const node = parsed("content.xml");
        if (input.kind === "document") content = { kind: "document", blocks: blocks(node) };
        else if (input.kind === "slides") content = { kind: "slides", slides: all(node, "page").slice(0, 200).map((page, index) => ({ title: text(page.attrs["draw:name"] ?? `Slide ${index + 1}`), blocks: blocks(page), notes: [] })) };
        else {
          content = { kind: "sheet", sheets: all(node, "table").slice(0, 50).map((table) => {
            let rowCount = 0; const rows: PreviewSheet["rows"] = [];
            for (const row of all(table, "table-row")) {
              const repeat = Math.min(1_000_000, Math.max(1, Number(row.attrs["table:number-rows-repeated"]) || 1)); rowCount += repeat;
              const values: PreviewSheet["rows"][number] = [];
              for (const cell of children(row).filter((child) => ["table-cell", "covered-table-cell"].includes(child.name))) {
                const count = Math.min(50, Math.max(1, Number(cell.attrs["table:number-columns-repeated"]) || 1));
                for (let i = 0; i < count && values.length < 50; i++) values.push({ value: plain(cell).trim() || cell.attrs["office:value"] || "", ...(cell.attrs["table:formula"] ? { formula: cell.attrs["table:formula"] } : {}) });
              }
              for (let i = 0; i < repeat && rows.length < 1000; i++) { accountCells(values.length); rows.push(values.map((cell) => ({ value: text(cell.value), ...(cell.formula ? { formula: text(cell.formula) } : {}) }))); }
            }
            if (rowCount > 1000) notices.push(`Showing the first 1,000 rows of ${rowCount.toLocaleString("en-US")}.`);
            return { name: text(table.attrs["table:name"] ?? "Sheet"), rowCount, rows };
          }) };
        }
      } else if (input.kind === "document") content = { kind: "document", blocks: blocks(parsed("word/document.xml")) };
      else if (input.kind === "sheet") content = sheets();
      else if (input.kind === "slides") {
        const presentation = parsed("ppt/presentation.xml"); const rels = relationships("ppt/presentation.xml");
        const ids = all(presentation, "sldId"); if (ids.length > 200) notices.push("Showing the first 200 slides.");
        content = { kind: "slides", slides: ids.slice(0, 200).map((id, index) => {
          const path = rels.get(id.attrs["r:id"] ?? ""); if (!path) throw new Error("Missing slide");
          const node = parsed(path); const slideRels = relationships(path);
          const notesPath = [...slideRels.values()].find((value) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(value));
          return { title: `Slide ${index + 1}`, blocks: blocks(node), notes: notesPath ? blocks(parsed(notesPath)) : [] };
        }) };
      } else {
        const container = parsed("META-INF/container.xml"); const path = all(container, "rootfile")[0]?.attrs["full-path"]; if (!path) throw new Error("Missing EPUB package");
        const packageNode = parsed(path);
        const manifest = new Map(all(packageNode, "item").map((item) => [item.attrs.id, item]));
        const spine = all(packageNode, "itemref"); if (spine.length > 100) notices.push("Showing the first 100 chapters.");
        content = { kind: "book", title: text(plain(all(packageNode, "title")[0] ?? packageNode)), author: text(all(packageNode, "creator").map(plain).join(", ")), chapters: spine.slice(0, 100).map((ref, index) => {
          const item = manifest.get(ref.attrs.idref); if (!item || item.attrs["media-type"] !== "application/xhtml+xml" || !item.attrs.href) throw new Error("Unsupported EPUB chapter");
          const node = parsed(relation(path, item.attrs.href.split("#")[0]!));
          const heading = ["h1", "h2", "title"].flatMap((tag) => all(node, tag))[0];
          return { title: text(heading ? plain(heading) : `Chapter ${index + 1}`), blocks: blocks(node) };
        }) };
      }
    }
    check(); return { ok: true, content, notices };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return message.startsWith("LIMIT:") ? { ok: false, reason: "limit", error: message.slice(6) } : { ok: false, reason: "invalid", error: `Couldn't read this file as ${input.kind === "document" ? "a Word document" : input.kind === "sheet" ? "a spreadsheet" : input.kind === "slides" ? "a presentation" : input.kind === "database" ? "a SQLite database" : input.kind === "book" ? "an EPUB book" : "an archive"}. It may be damaged or password-protected.` };
  }
}
