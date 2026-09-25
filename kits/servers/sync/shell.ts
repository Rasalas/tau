import type { ServerExecStream, ServerFs } from "../server-fs.js";

/*
 * The fast ways over a shell: one `find` for the listing, `sha256sum` for
 * hashes, a `tar` stream for a download. Every command runs in `remotePath`,
 * takes relative `./` paths (never an option by accident) and prunes `.git`.
 * GNU find has `-printf`; BusyBox and GNU stat take `-c`; BSD stat takes `-f`.
 */

export const LIST_SCRIPT = [
  "if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then",
  "printf 'tau-list gnu\\n'; find . -mindepth 1 -name .git -prune -o -printf '%y %m %s %T@ %P\\0';",
  "elif stat -c '' . >/dev/null 2>&1; then",
  "printf 'tau-list statc\\n'; find . -mindepth 1 -name .git -prune -o -exec stat -c '%f %s %Y %n' {} +;",
  "else",
  "printf 'tau-list bsd\\n'; find . -mindepth 1 -name .git -prune -o -exec stat -f '%Hp %Lp %z %m %N' {} +;",
  "fi",
].join(" ");

export const HASH_SCRIPT = "if command -v sha256sum >/dev/null 2>&1; then xargs -0 sha256sum --; else xargs -0 shasum -a 256 --; fi";

/** 97: no tar here, the caller falls back to SFTP. */
export const TAR_SCRIPT = "command -v tar >/dev/null 2>&1 || exit 97; COPYFILE_DISABLE=1 xargs -0 tar -cf -";
export const NO_TAR = 97;

export type EntryType = "file" | "directory" | "symlink" | "other";

export interface ListedEntry {
  path: string;
  type: EntryType;
  size: number;
  /** Whole seconds, as SFTP has them. */
  mtime: number;
  /** Permission bits. */
  mode: number;
}

const GNU_TYPES: Record<string, EntryType> = { f: "file", d: "directory", l: "symlink" };

function typeOfMode(mode: number): EntryType {
  switch (mode & 0o170000) {
    case 0o100000: return "file";
    case 0o040000: return "directory";
    case 0o120000: return "symlink";
    default: return "other";
  }
}

const stripDot = (path: string) => path.replace(/^\.\//u, "");

// A name with a newline continues on the next line; a line that does not start a record belongs to the one before.
function parseLines(text: string, record: RegExp, build: (match: RegExpExecArray) => ListedEntry): ListedEntry[] {
  const entries: ListedEntry[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = record.exec(line);
    if (match) entries.push(build(match));
    else if (entries.length) entries.at(-1)!.path += `\n${line}`;
  }
  return entries;
}

/** What `LIST_SCRIPT` printed; undefined when it did not run as expected. */
export function parseListing(output: Buffer): ListedEntry[] | undefined {
  const text = output.toString("utf8");
  const newline = text.indexOf("\n");
  const header = text.slice(0, newline);
  const body = text.slice(newline + 1);
  if (header === "tau-list gnu") {
    const entries: ListedEntry[] = [];
    for (const record of body.split("\0")) {
      const match = /^(\S) ([0-7]+) (\d+) (\d+)(?:\.\d+)? (.+)$/su.exec(record);
      if (!match) continue;
      entries.push({ type: GNU_TYPES[match[1]!] ?? "other", mode: parseInt(match[2]!, 8) & 0o7777, size: Number(match[3]), mtime: Number(match[4]), path: match[5]! });
    }
    return entries;
  }
  if (header === "tau-list statc") {
    return parseLines(body, /^([0-9a-f]+) (\d+) (\d+) (\.\/.*)$/u, (match) => {
      const raw = parseInt(match[1]!, 16);
      return { type: typeOfMode(raw), mode: raw & 0o7777, size: Number(match[2]), mtime: Number(match[3]), path: stripDot(match[4]!) };
    });
  }
  if (header === "tau-list bsd") {
    return parseLines(body, /^([0-7]+) ([0-7]+) (\d+) (\d+) (\.\/.*)$/u, (match) => {
      const high = parseInt(match[1]!, 8);
      return { type: typeOfMode(high << 12), mode: parseInt(match[2]!, 8) & 0o7777, size: Number(match[3]), mtime: Number(match[4]), path: stripDot(match[5]!) };
    });
  }
  return undefined;
}

/** `sha256sum` output; a name with a backslash or newline comes escaped behind a leading `\`. */
export function parseHashes(output: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^(\\?)([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (!match) continue;
    const name = match[1] ? match[3]!.replace(/\\(\\|n)/gu, (_, char: string) => (char === "n" ? "\n" : "\\")) : match[3]!;
    hashes.set(stripDot(name), match[2]!);
  }
  return hashes;
}

/** The list a script reads on stdin: `./`-prefixed, NUL-separated. */
export function pathList(paths: Iterable<string>): string {
  let list = "";
  for (const path of paths) list += `./${path}\0`;
  return list;
}

export async function collect(stream: ServerExecStream): Promise<{ stdout: Buffer; code: number | null; stderr: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream.stdout) chunks.push(chunk);
  const done = await stream.done;
  return { stdout: Buffer.concat(chunks), code: done.code, stderr: done.stderr };
}

export const hasShell = (fs: ServerFs): fs is ServerFs & Required<Pick<ServerFs, "execStream">> => fs.caps.exec && typeof fs.execStream === "function";

const HASH_BATCH = 5_000;

/** SHA-256 of the files the shell could read; the others are left out. */
export async function shellHashes(fs: ServerFs, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (!hasShell(fs) || !fs.caps.hash) return hashes;
  for (let start = 0; start < paths.length; start += HASH_BATCH) {
    const batch = paths.slice(start, start + HASH_BATCH);
    const result = await collect(await fs.execStream(HASH_SCRIPT, { input: pathList(batch), ...(signal ? { signal } : {}) }));
    const wanted = new Set(batch);
    for (const [path, hash] of parseHashes(result.stdout.toString("utf8"))) if (wanted.has(path)) hashes.set(path, hash);
  }
  return hashes;
}
