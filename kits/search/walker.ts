import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { escapeRegex, isIgnored, parseGitignore, type IgnoreRule } from "../_shared/gitignore.js";
import { excerpt } from "./ripgrep.js";
import { CONTENT_LIMIT, CONTENT_PER_FILE, FILE_LIMIT, type ContentMatch, type ContentSearchInput } from "./protocol.js";

/**
 * What the kit does without ripgrep: walk the project itself, leaving out what
 * each folder's `.gitignore` names and `.git`, and read the files it found.
 * Slower than ripgrep, and the same answers for the cases people meet.
 */

export { isIgnored, parseGitignore };

const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface WalkOptions {
  limit?: number;
  readPath?(path: string): Promise<string | undefined>;
  /** Asked between folders; `true` stops the walk with what it has. */
  cancelled?(): boolean;
}

/** Every file of the project, relative and POSIX-style; symbolic links are not followed. */
export async function walkProject(root: string, options: WalkOptions = {}): Promise<{ files: string[]; truncated: boolean }> {
  const limit = options.limit ?? FILE_LIMIT;
  const files: string[] = [];
  const queue: Array<{ dir: string; rules: IgnoreRule[] }> = [{ dir: "", rules: [] }];
  let visited = 0;
  while (queue.length > 0) {
    if (options.cancelled?.()) return { files, truncated: true };
    const { dir, rules: inherited } = queue.shift()!;
    const absolute = join(root, dir);
    let rules = inherited;
    try {
      const ignore = join(absolute, ".gitignore");
      if (!options.readPath || await options.readPath(ignore)) rules = [...inherited, ...parseGitignore(await readFile(ignore, "utf8"), dir)];
    } catch { /* no .gitignore here */ }
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      if (options.readPath && !await options.readPath(join(absolute, entry.name))) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isIgnored(rules, path, true)) queue.push({ dir: path, rules });
      } else if (entry.isFile() && !isIgnored(rules, path, false)) {
        files.push(path);
        if (files.length >= limit) return { files, truncated: true };
      }
    }
    visited += 1;
    if (visited % 100 === 0) await yieldToEvents();
  }
  return { files, truncated: false };
}

/** The query as the walker matches it; throws for a regular expression JavaScript refuses. */
export function contentPattern(input: ContentSearchInput): RegExp {
  const source = input.regex ? input.query : escapeRegex(input.query);
  return new RegExp(input.wholeWord ? `\\b(?:${source})\\b` : source, input.caseSensitive ? "g" : "gi");
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Searches the files one by one, in order, until the limit or the caller cancels. */
export async function searchWalkedFiles(
  root: string,
  files: readonly string[],
  pattern: RegExp,
  options: { limit?: number; readPath?(path: string): Promise<string | undefined>; cancelled?(): boolean } = {},
): Promise<{ matches: ContentMatch[]; truncated: boolean }> {
  const limit = options.limit ?? CONTENT_LIMIT;
  const matches: ContentMatch[] = [];
  for (const [index, path] of files.entries()) {
    if (options.cancelled?.()) return { matches, truncated: true };
    if (index % 50 === 49) await yieldToEvents();
    let bytes: Buffer;
    try {
      const target = options.readPath ? await options.readPath(join(root, path)) : join(root, path);
      if (!target) continue;
      if ((await stat(target)).size > MAX_FILE_BYTES) continue;
      bytes = await readFile(target);
    } catch {
      continue;
    }
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    let inFile = 0;
    for (const [number, line] of lines.entries()) {
      pattern.lastIndex = 0;
      const ranges: Array<[number, number]> = [];
      for (let found = pattern.exec(line); found; found = pattern.exec(line)) {
        if (found[0].length === 0) { pattern.lastIndex += 1; continue; }
        ranges.push([found.index, found.index + found[0].length]);
      }
      if (ranges.length === 0) continue;
      const cut = excerpt(line, ranges);
      matches.push({ path, line: number + 1, text: cut.text, ranges: cut.ranges });
      if (matches.length > limit) return { matches: matches.slice(0, limit), truncated: true };
      inFile += 1;
      if (inFile >= CONTENT_PER_FILE) break;
    }
  }
  return { matches, truncated: false };
}
