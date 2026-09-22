/** How much of a CSV or TSV the table draws; the source view keeps every byte. */
export const TABLE_MAX_ROWS = 100;
export const TABLE_MAX_COLUMNS = 30;

export interface DelimitedTable {
  rows: string[][];
  truncated: boolean;
}

/**
 * RFC 4180 fields: quotes wrap a field, `""` is a quote inside one, and a
 * quoted field may hold the delimiter and line breaks. Stops reading once the
 * table has as many rows as it will draw.
 */
export function parseDelimited(text: string, delimiter: "," | "\t"): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > TABLE_MAX_COLUMNS) { truncated = true; row = row.slice(0, TABLE_MAX_COLUMNS); }
    rows.push(row);
    row = [];
  };
  let index = 0;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
      continue;
    }
    if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
      if (rows.length >= TABLE_MAX_ROWS) { index += 1; break; }
    } else field += char;
  }
  if (rows.length >= TABLE_MAX_ROWS) {
    if (text.slice(index).trim() !== "") truncated = true;
  } else if (field !== "" || row.length > 0) endRow();
  return { rows, truncated };
}
