/** Only inert data crosses from the machine's parser to the workbench. */
export type PassiveKind = "document" | "sheet" | "slides" | "archive" | "database" | "book";
export interface PreviewBlock {
  kind: "paragraph" | "heading" | "list" | "table";
  text?: string;
  level?: number;
  rows?: string[][];
}
export interface PreviewSheet {
  name: string;
  rowCount: number;
  rows: { value: string; formula?: string }[][];
}
export interface ArchiveEntry {
  name: string;
  size: number;
  modified?: string;
  directory: boolean;
  encrypted: boolean;
  link?: string;
}
export type PassiveContent =
  | { kind: "document"; blocks: PreviewBlock[] }
  | { kind: "sheet"; sheets: PreviewSheet[] }
  | { kind: "slides"; slides: { title: string; blocks: PreviewBlock[]; notes: PreviewBlock[] }[] }
  | { kind: "archive"; entries: ArchiveEntry[]; unpackedBytes: number }
  | { kind: "database"; tables: { name: string; type: string; schema: string }[]; selected: string; approximateRows?: number; columns: string[]; rows: string[][] }
  | { kind: "book"; title: string; author: string; chapters: { title: string; blocks: PreviewBlock[] }[] };
export type PassivePreview =
  | { ok: true; content: PassiveContent; notices: string[] }
  | { ok: false; reason: "size" | "invalid" | "limit" | "unsupported"; error: string };

export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TIMEOUT_MS = 3_000;
export function passiveKind(path: string): PassiveKind | undefined {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name.lastIndexOf(".") <= 0) return undefined;
  if (/\.(docx|odt|rtf)$/u.test(name)) return "document";
  if (/\.(xlsx|ods)$/u.test(name)) return "sheet";
  if (/\.(pptx|odp)$/u.test(name)) return "slides";
  if (/\.(zip|jar|tar|tgz|tar\.gz)$/u.test(name)) return "archive";
  if (/\.(sqlite|sqlite3|db)$/u.test(name)) return "database";
  if (/\.epub$/u.test(name)) return "book";
  return undefined;
}
