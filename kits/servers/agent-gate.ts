import type { TargetLevel } from "./protocol.js";

/*
 * What the agent may do on a server without asking (plan-I §1.6): reading is
 * free; commands and writes to ~/tmp follow the stricter of the target's level
 * and the thread's; Git on the server is never written, at any level. Reading
 * a shell command is a heuristic, not a boundary: it catches what a model
 * writes, not what someone hides on purpose.
 */

const STRICTNESS: Record<TargetLevel, number> = { "read-only": 0, ask: 1, full: 2 };

export function stricterLevel(target: TargetLevel, thread: TargetLevel | undefined): TargetLevel {
  return thread !== undefined && STRICTNESS[thread] < STRICTNESS[target] ? thread : target;
}

// Splits commands: `;`, `&&`, `||`, `|`, `&`, newlines, subshells and substitutions.
const SEPARATOR = /\|\||&&|;;|[;&|\n(){}`]|\$\(/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time"]);
/** Commands that run the rest of their words as a command. */
const PREFIXES = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "ionice", "timeout", "xargs", "eval", "stdbuf", "caffeinate", "sshpass", "unbuffer", "chronic"]);
/** Options of those prefixes that take the next word. */
const PREFIX_OPTIONS_WITH_VALUE = new Set(["-u", "-g", "-n", "-s", "-k", "-p", "-f", "-e", "-C", "-h", "-I", "-L", "-P", "-d", "--user", "--group", "--signal", "--kill-after"]);

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** Words of each simple command; quotes are dropped, so `sh -c "git commit"` reads as words too. */
export function commandSegments(command: string): string[][] {
  return command
    .replace(/\\\n/gu, " ")
    .split(SEPARATOR)
    .map((segment) => segment.replace(/["'\\]/gu, " ").split(/\s+/u).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** The words from the command itself on: assignments, keywords and wrappers like `sudo` or `sh -c` skipped. */
export function commandWords(words: readonly string[]): string[] {
  let rest = [...words];
  for (;;) {
    while (rest.length && (ASSIGNMENT.test(rest[0]!) || KEYWORDS.has(rest[0]!))) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined) return rest;
    const name = basename(head);
    if (PREFIXES.has(name)) {
      rest = rest.slice(1);
      // Options, their values, a duration or priority, and assignments before the command.
      while (rest.length && (rest[0]!.startsWith("-") || ASSIGNMENT.test(rest[0]!) || /^\d+(\.\d+)?[smhd]?$/u.test(rest[0]!))) {
        const option = rest[0]!;
        rest = rest.slice(PREFIX_OPTIONS_WITH_VALUE.has(option) ? 2 : 1);
      }
      continue;
    }
    if (SHELLS.has(name)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
      if (flag < 0) return rest;
      rest = rest.slice(flag + 1);
      continue;
    }
    return rest;
  }
}

/** Git's options before the subcommand that take the next word. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);

/** Subcommands that only read, whatever their arguments. */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "blame", "annotate", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "cat-file",
  "describe", "grep", "shortlog", "whatchanged", "version", "help", "show-ref", "show-branch", "name-rev", "merge-base",
  "for-each-ref", "count-objects", "var", "check-ignore", "check-attr", "diff-tree", "diff-files", "diff-index", "cherry", "range-diff",
]);

const BRANCH_WRITES = /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track|--create-reflog)$/u;
const TAG_WRITES = /^(-d|-a|-s|-u|-f|-m|-F|-e|--delete|--annotate|--sign|--local-user.*|--force|--message.*|--file.*|--edit|--create-reflog)$/u;

/** Whether `git <subcommand> <args>` only reads; unknown subcommands count as writes. */
function gitReads(subcommand: string, args: readonly string[]): boolean {
  if (GIT_READS.has(subcommand)) return true;
  const first = args.find((arg) => !arg.startsWith("-"));
  switch (subcommand) {
    case "branch": {
      if (args.some((arg) => BRANCH_WRITES.test(arg))) return false;
      // A name without `--list` creates a branch.
      return first === undefined || args.includes("--list") || args.includes("-l") || args.some((arg) => /^--(contains|no-contains|merged|no-merged|points-at|sort|format)$/u.test(arg));
    }
    case "tag":
      if (args.some((arg) => TAG_WRITES.test(arg))) return false;
      return first === undefined || args.includes("--list") || args.includes("-l");
    case "remote":
      return first === undefined || first === "show" || first === "get-url";
    case "config":
      return first === "get" || first === "list" || args.some((arg) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/u.test(arg));
    case "stash":
    case "notes":
      return first === "list" || first === "show";
    case "reflog":
      return first === undefined || first === "show";
    case "worktree":
      return first === "list";
    case "submodule":
      return first === "status" || first === "summary";
    default:
      return false;
  }
}

/** The subcommand of one `git` invocation, its global options skipped. */
function gitSubcommand(words: readonly string[]): { subcommand: string | undefined; args: string[] } {
  let index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (!word.startsWith("-")) break;
    index += GIT_OPTIONS_WITH_VALUE.has(word) ? 2 : 1;
  }
  return { subcommand: words[index], args: words.slice(index + 1) };
}

/**
 * The first Git invocation in `command` that could write, as `git <sub>`;
 * undefined when every one only reads. Git needs a subcommand, so `git`
 * alone reads (it prints its help).
 */
export function gitWriteIn(command: string): string | undefined {
  for (const segment of commandSegments(command)) {
    const words = commandWords(segment);
    const found = gitWriteInWords(words);
    if (found) return found;
  }
  return undefined;
}

function gitWriteInWords(words: readonly string[]): string | undefined {
  if (!words.length || basename(words[0]!) !== "git") return undefined;
  const { subcommand, args } = gitSubcommand(words);
  if (subcommand === undefined || subcommand === "--version" || subcommand === "--help") return undefined;
  return gitReads(subcommand, args) ? undefined : `git ${subcommand}`;
}

/** A target as the bypass check knows it: its host and, for an ssh alias, that name. */
export interface BypassTarget {
  id: string;
  label: string;
  host: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const sameHost = (a: string, b: string) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || (LOOPBACK.has(left) && LOOPBACK.has(right));
};

/** The host a word names: `user@host`, `host:path`, `[host]:port`, `scheme://user@host:port/path`. */
export function hostOfWord(word: string): string | undefined {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/iu.exec(word);
  if (url) return url[1];
  const at = word.lastIndexOf("@");
  const rest = at >= 0 ? word.slice(at + 1) : word;
  const bracket = /^\[([^\]]+)\]/u.exec(rest);
  if (bracket) return bracket[1];
  const host = rest.split(":")[0];
  return host || undefined;
}

const SSH_OPTIONS_WITH_VALUE = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B", "-P"]);
const FTP_SCHEMES = /^(s?ftps?|scp):\/\//iu;
const FILE_TOOLS = new Set(["scp", "sftp", "rsync", "lftp", "ftp", "sshfs"]);

export interface ServerBypass {
  target: BypassTarget;
  tool: string;
  /** For `ssh host command`: the command it runs there, up to the next separator. */
  remoteCommand?: string;
}

/**
 * A local shell command that reaches one of the project's servers with ssh,
 * scp, sftp, rsync, lftp or curl on an FTP/SFTP URL; the agent should use
 * `server_exec` for that, so it is held to the same rules.
 */
export function serverBypassIn(command: string, targets: readonly BypassTarget[]): ServerBypass | undefined {
  if (!targets.length) return undefined;
  const match = (word: string) => {
    const host = hostOfWord(word);
    return host ? targets.find((target) => sameHost(target.host, host)) : undefined;
  };
  for (const segment of commandSegments(command)) {
    const words = commandWords(segment);
    const tool = words[0] ? basename(words[0]) : undefined;
    if (!tool) continue;
    if (tool === "ssh" || tool === "mosh") {
      let index = 1;
      while (index < words.length && words[index]!.startsWith("-")) index += SSH_OPTIONS_WITH_VALUE.has(words[index]!) ? 2 : 1;
      const destination = words[index];
      const target = destination ? match(destination) : undefined;
      if (target) {
        const remote = words.slice(index + 1).join(" ");
        return { target, tool, ...(remote ? { remoteCommand: remote } : {}) };
      }
      continue;
    }
    if (FILE_TOOLS.has(tool)) {
      // scp and rsync name a server as `host:path`; the others may take a bare host.
      const remoteOnly = tool === "scp" || tool === "rsync";
      const target = words.slice(1).filter((word) => !word.startsWith("-") && (!remoteOnly || word.includes(":") || word.includes("@"))).map(match).find(Boolean);
      if (target) return { target, tool };
      continue;
    }
    if (tool === "curl" || tool === "wget") {
      const target = words.slice(1).filter((word) => FTP_SCHEMES.test(word)).map(match).find(Boolean);
      if (target) return { target, tool };
    }
  }
  return undefined;
}

export type ServerCallKind = "exec" | "put-tmp" | "bypass";

export type ServerVerdict =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "ask"; title: string; message: string };

export interface ServerCallRequest {
  kind: ServerCallKind;
  target: { label: string; address: string };
  targetLevel: TargetLevel;
  /** The thread's level from Access Kit; undefined without one, which limits nothing. */
  threadLevel?: TargetLevel;
  /** The command for `exec` and `bypass`. */
  command?: string;
  /** Where it runs or what it writes, in words: `~/tmp`, `the site's folder`, `~/tmp/probe.php`. */
  where?: string;
  /** For `bypass`: the local tool (`ssh`, `scp`…). */
  tool?: string;
  /** For `bypass`: the command `ssh` runs on the server. */
  remoteCommand?: string;
}

/**
 * The one decision for a server call, whichever door it came through (Pi's
 * `tool_call` hook, the MCP gate, the tool itself). Git writes are refused
 * first, then the stricter level decides.
 */
export function decideServerCall(request: ServerCallRequest): ServerVerdict {
  const { target } = request;
  if (request.kind !== "put-tmp") {
    const gitWrite = gitWriteIn(request.remoteCommand ?? request.command ?? "") ?? (request.kind === "bypass" ? gitWriteIn(request.command ?? "") : undefined);
    if (gitWrite) {
      return { kind: "block", reason: `Blocked by Tau: \`${gitWrite}\` would write Git on the server ${target.label}, and Git there is read-only at every level. Commit, branch and merge in the local project instead; only the user uploads.` };
    }
  }
  const level = stricterLevel(request.targetLevel, request.threadLevel);
  const doing = request.kind === "put-tmp" ? "writing to ~/tmp" : "running commands";
  if (level === "read-only") {
    const whose = request.targetLevel === "read-only" ? `the server ${target.label} is set to read-only for the agent` : "this thread is read-only";
    return { kind: "block", reason: `Blocked by Tau: ${whose}, so ${doing} there is not allowed. Reading with server_read, server_list and server_diff still works.` };
  }
  if (level === "full") return { kind: "allow" };
  // At "ask", Access Kit already asked for this very bash command; one question is enough.
  if (request.kind === "bypass" && request.threadLevel === "ask") return { kind: "allow" };
  if (request.kind === "put-tmp") {
    return { kind: "ask", title: `Write to ~/tmp on ${target.label}?`, message: `${request.where ?? "~/tmp"} on ${target.address}` };
  }
  const via = request.kind === "bypass" ? ` (through local ${request.tool ?? "ssh"})` : "";
  const where = request.where ? ` in ${request.where}` : "";
  return { kind: "ask", title: `Run on the server ${target.label}?`, message: `${request.command ?? ""}\n\n${target.address}${where}${via}` };
}
