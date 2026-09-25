import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { gitCall, GitError, type GitCall } from "./git.js";
import { ancestors, hasGitSegment } from "./paths.js";

/*
 * What a sync leaves out, as the union of three sources: the local checkout's
 * Git ignore rules (`git check-ignore --no-index`, so tracked files count too),
 * the target's sftp.json `ignore`/`ignoreFile`, and `.git` at any depth.
 * A folder is pruned only when the folder itself is ignored; `cache/*` ignores
 * what is inside, so a `!cache/keep` still gets through, as in Git.
 */

interface Rule {
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
  /** Matched against the whole path; otherwise against the last name at any depth. */
  anchored: boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function globToRegex(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") { out += "(?:.*/)?"; index += 2; } else { out += ".*"; index += 1; }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[" && glob.indexOf("]", index + 2) > index) {
      const close = glob.indexOf("]", index + 2);
      const body = glob.slice(index + 1, close);
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else if (char === "\\" && index + 1 < glob.length) {
      out += escapeRegex(glob[index + 1]!);
      index += 1;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

/** Gitignore syntax, relative to the target's folder. */
export function parseIgnorePatterns(lines: Iterable<string>): Rule[] {
  const rules: Rule[] = [];
  for (const raw of lines) {
    let line = raw.replace(/(?<!\\)\s+$/u, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    try {
      rules.push({ pattern: new RegExp(`^${globToRegex(line)}$`, "u"), negate, directoryOnly, anchored });
    } catch {
      // A pattern that makes no regular expression ignores nothing.
    }
  }
  return rules;
}

/** The last rule wins, as in Git. */
function ruleIgnores(rules: readonly Rule[], path: string, directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) continue;
    const subject = rule.anchored ? path : path.slice(path.lastIndexOf("/") + 1);
    if (rule.pattern.test(subject)) ignored = !rule.negate;
  }
  return ignored;
}

/** `cache/*`, `logs/**`: the pattern names what is inside a folder, not the folder. */
export function namesContentsOnly(pattern: string): boolean {
  const bare = pattern.replace(/^!/u, "").replace(/\/$/u, "");
  const slash = bare.lastIndexOf("/");
  return slash >= 0 && /^\*+$/u.test(bare.slice(slash + 1));
}

/** `git check-ignore -v -z` answers four fields per match: source, line, pattern, path. */
export function parseCheckIgnore(output: Buffer): Array<{ pattern: string; path: string }> {
  const fields = output.toString("utf8").split("\0");
  const matches: Array<{ pattern: string; path: string }> = [];
  for (let index = 0; index + 3 < fields.length; index += 4) matches.push({ pattern: fields[index + 2]!, path: fields[index + 3]! });
  return matches;
}

export interface SyncIgnoreOptions {
  /** The local folder the target maps to: the checkout plus the target's `context`. It need not exist yet. */
  localDir: string;
  /** sftp.json `ignore`. */
  patterns?: readonly string[];
  /** sftp.json `ignoreFile`: absolute, `~/…`, or relative to `projectDir`. */
  ignoreFile?: string;
  projectDir?: string;
  /** Left out for this run only (folders or files deselected before a download). */
  exclude?: readonly string[];
  /** False: no Git rules, for a folder that gets its own repository only afterwards. */
  gitRules?: boolean;
  git?: GitCall;
  home?: string;
}

interface GitScope {
  top: string;
  /** The local folder below the repository's top, `""` for the top itself. */
  prefix: string;
}

async function existingAncestor(path: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return { real: await realpath(current), rest };
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`${path} has no existing folder above it`);
      rest.unshift(current.slice(parent.length).replace(/^[\\/]/u, ""));
      current = parent;
    }
  }
}

async function findGitScope(localDir: string, git: GitCall): Promise<GitScope | undefined> {
  const { real, rest } = await existingAncestor(localDir);
  const result = await git(["rev-parse", "--show-toplevel"], { cwd: real });
  if (result.code !== 0) return undefined;
  const top = await realpath(result.stdout.toString("utf8").trim());
  const rel = relative(top, join(real, ...rest));
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return { top, prefix: rel.split(sep).filter(Boolean).join("/") };
}

export class SyncIgnore {
  private constructor(
    private readonly rules: readonly Rule[],
    private readonly exclude: readonly string[],
    private readonly scope: GitScope | undefined,
    private readonly git: GitCall,
  ) {}

  static async create(options: SyncIgnoreOptions): Promise<SyncIgnore> {
    const git = options.git ?? gitCall();
    const lines = [...(options.patterns ?? [])];
    if (options.ignoreFile) {
      const home = options.home ?? homedir();
      const file = options.ignoreFile.startsWith("~/") ? join(home, options.ignoreFile.slice(2))
        : isAbsolute(options.ignoreFile) ? options.ignoreFile : join(options.projectDir ?? options.localDir, options.ignoreFile);
      // A missing ignore file ignores nothing, as in the extension.
      lines.push(...(await readFile(file, "utf8").catch(() => "")).split(/\r?\n/u));
    }
    const exclude = (options.exclude ?? []).map((path) => path.replace(/^\/+|\/+$/gu, "")).filter(Boolean);
    const scope = options.gitRules === false ? undefined : await findGitScope(options.localDir, git);
    return new SyncIgnore(parseIgnorePatterns(lines), exclude, scope, git);
  }

  /** Whether the local checkout's `.gitignore` rules take part. */
  get gitRules(): boolean {
    return this.scope !== undefined;
  }

  private excluded(path: string): boolean {
    return this.exclude.some((entry) => path === entry || path.startsWith(`${entry}/`));
  }

  private ownRule(path: string, directory: boolean): boolean {
    return hasGitSegment(path) || this.excluded(path) || ruleIgnores(this.rules, path, directory);
  }

  /**
   * Git refuses a path beyond a local symlink ("beyond a symbolic link"), so
   * such a path is asked about as the link itself: `css/a.css` as `css` when
   * `css` is a link here.
   */
  private async queries(paths: readonly string[], directory: boolean): Promise<Map<string, string[]>> {
    const { top, prefix } = this.scope!;
    const links = new Map<string, boolean>();
    const isLink = async (repoPath: string) => {
      let hit = links.get(repoPath);
      if (hit === undefined) {
        hit = await lstat(join(top, ...repoPath.split("/"))).then((info) => info.isSymbolicLink(), () => false);
        links.set(repoPath, hit);
      }
      return hit;
    };
    const byQuery = new Map<string, string[]>();
    for (const path of paths) {
      const repoPath = prefix ? `${prefix}/${path}` : path;
      let query = `${repoPath}${directory ? "/" : ""}`;
      for (const folder of [...ancestors(repoPath), ...(directory ? [repoPath] : [])]) {
        if (await isLink(folder)) { query = folder; break; }
      }
      byQuery.set(query, [...(byQuery.get(query) ?? []), path]);
    }
    return byQuery;
  }

  private async askGit(queries: readonly string[]): Promise<Array<{ pattern: string; path: string }>> {
    const args = ["check-ignore", "--no-index", "-v", "-z", "--stdin"];
    const result = await this.git(args, { cwd: this.scope!.top, input: `${queries.join("\0")}\0` });
    // 1: nothing ignored.
    if (result.code === 0 || result.code === 1) return parseCheckIgnore(result.stdout);
    if (result.code !== 128) throw new GitError(args, result);
    // One path Git will not take fails the batch: halve until it stands alone, and let Git's rules pass on it.
    if (queries.length === 1) return [];
    const half = Math.ceil(queries.length / 2);
    return [...(await this.askGit(queries.slice(0, half))), ...(await this.askGit(queries.slice(half)))];
  }

  private async checkGit(paths: readonly string[], directory: boolean): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (!this.scope || paths.length === 0) return ignored;
    const byQuery = await this.queries(paths, directory);
    for (const match of await this.askGit([...byQuery.keys()])) {
      if (match.pattern.startsWith("!")) continue;
      if (directory && match.path.endsWith("/") && namesContentsOnly(match.pattern)) continue;
      for (const path of byQuery.get(match.path) ?? []) ignored.add(path);
    }
    return ignored;
  }

  /** The folders among `paths` to leave out whole; what is below them is not asked about. */
  async dirs(paths: readonly string[]): Promise<Set<string>> {
    const ignored = new Set(paths.filter((path) => this.ownRule(path, true)));
    const rest = paths.filter((path) => !ignored.has(path));
    for (const hit of await this.checkGit(rest, true)) ignored.add(hit);
    return ignored;
  }

  /**
   * The files among `paths` to leave out. `ancestors`: also through the
   * folders above them, for paths no walk reached (the mirror's entries).
   */
  async files(paths: readonly string[], options: { ancestors?: boolean } = {}): Promise<Set<string>> {
    const ignored = new Set<string>();
    const folderIgnored = new Map<string, boolean>();
    for (const path of paths) {
      if (this.ownRule(path, false)) { ignored.add(path); continue; }
      if (!options.ancestors) continue;
      for (const folder of ancestors(path)) {
        let hit = folderIgnored.get(folder);
        if (hit === undefined) { hit = this.ownRule(folder, true); folderIgnored.set(folder, hit); }
        if (hit) { ignored.add(path); break; }
      }
    }
    // Git answers for a file below an ignored folder by itself.
    const rest = paths.filter((path) => !ignored.has(path));
    for (const hit of await this.checkGit(rest, false)) ignored.add(hit);
    return ignored;
  }
}
