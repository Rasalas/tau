import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ServerProtocol } from "./protocol.js";

/**
 * SSH targets from an ssh config and typed-in addresses. Aliases come from the
 * `Host` lines (following `Include`); what an alias means comes from `ssh -G`,
 * so `Match`, `ProxyJump` and the rest resolve exactly as ssh itself would.
 */

export interface SshHostAlias {
  alias: string;
  /** The config file and 1-based line that named it. */
  file: string;
  line: number;
}

export interface SshHostList {
  hosts: SshHostAlias[];
  /** Files that could not be read, or an `Include` too deep. */
  problems: string[];
}

export interface SshConfigReadOptions {
  /** Relative `Include` paths start in `<home>/.ssh`, as for a user config. */
  home: string;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
}

/** OpenSSH's own limit on nested `Include`. */
const MAX_INCLUDE_DEPTH = 16;

/** Splits a config line into words, honouring double quotes. */
function words(text: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/gu;
  for (const match of text.matchAll(pattern)) result.push(match[1] ?? match[2]!);
  return result;
}

/** `Keyword value`, `Keyword=value` or `Keyword = value`; `undefined` for blanks and comments. */
function keywordLine(line: string): { keyword: string; args: string[] } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/u.exec(trimmed);
  if (!match) return undefined;
  return { keyword: match[1]!.toLowerCase(), args: words(match[2]!.replace(/\s+#.*$/u, "")) };
}

const isPattern = (value: string) => /[*?!]/u.test(value);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  return new RegExp(`^${escaped}$`, "u");
}

async function expandInclude(pattern: string, options: SshConfigReadOptions, list: (path: string) => Promise<string[]>): Promise<string[]> {
  let path = pattern.startsWith("~/") ? join(options.home, pattern.slice(2)) : pattern;
  if (!isAbsolute(path)) path = join(options.home, ".ssh", path);
  if (!/[*?]/u.test(basename(path))) return [path];
  // Wildcards in the last segment only; that is what configs use (`config.d/*`).
  const matcher = globToRegExp(basename(path));
  try {
    return (await list(dirname(path))).filter((name) => !name.startsWith(".") && matcher.test(name)).sort().map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

/** Every concrete `Host` alias the config names, in order, without wildcard patterns. */
export async function listSshHosts(configPath: string, options: SshConfigReadOptions): Promise<SshHostList> {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const list = options.readdir ?? ((path: string) => readdir(path));
  const hosts: SshHostAlias[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = async (file: string, depth: number, required: boolean): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) { problems.push(`${file}: Include nested too deeply`); return; }
    if (visiting.has(file)) return;
    let text: string;
    try {
      text = await read(file);
    } catch {
      if (required) problems.push(`${file}: cannot be read`);
      return;
    }
    visiting.add(file);
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = keywordLine(lines[index]!);
      if (!parsed) continue;
      if (parsed.keyword === "host") {
        for (const alias of parsed.args) {
          if (isPattern(alias) || seen.has(alias)) continue;
          seen.add(alias);
          hosts.push({ alias, file, line: index + 1 });
        }
      } else if (parsed.keyword === "include") {
        for (const pattern of parsed.args) {
          for (const included of await expandInclude(pattern, options, list)) await visit(included, depth + 1, false);
        }
      }
    }
    visiting.delete(file);
  };

  await visit(configPath, 0, true);
  return { hosts, problems };
}

export interface ResolvedSshHost {
  alias: string;
  hostname: string;
  user?: string;
  port: number;
  identityFiles: string[];
  identityAgent?: string;
  proxyJump?: string;
  userKnownHostsFiles: string[];
  strictHostKeyChecking?: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

const runCommand: CommandRunner = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = !error ? 0 : typeof error.code === "number" ? error.code : 1;
    resolve({ stdout: String(stdout), stderr: String(stderr), code });
  });
});

/** Rejects what ssh would read as an option or what could never be a host. */
export function isSshAlias(value: string): boolean {
  return /^[A-Za-z0-9_.@%+:[\]-]+$/u.test(value) && !value.startsWith("-") && value.length <= 255;
}

/** Parses `ssh -G` output: one `keyword value` per line, keywords lower-case. */
export function parseSshG(alias: string, stdout: string): ResolvedSshHost {
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/u)) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    values.set(key, [...(values.get(key) ?? []), line.slice(space + 1).trim()]);
  }
  const first = (key: string) => values.get(key)?.[0];
  const none = (value: string | undefined) => (value && value !== "none" ? value : undefined);
  const port = Number.parseInt(first("port") ?? "22", 10);
  const resolved: ResolvedSshHost = {
    alias,
    hostname: first("hostname") ?? alias,
    port: Number.isInteger(port) ? port : 22,
    identityFiles: values.get("identityfile") ?? [],
    userKnownHostsFiles: (first("userknownhostsfile") ?? "").split(/\s+/u).filter(Boolean),
  };
  const user = first("user");
  if (user) resolved.user = user;
  const agent = none(first("identityagent"));
  if (agent) resolved.identityAgent = agent;
  const jump = none(first("proxyjump"));
  if (jump) resolved.proxyJump = jump;
  const strict = first("stricthostkeychecking");
  if (strict) resolved.strictHostKeyChecking = strict;
  return resolved;
}

export interface ResolveSshHostOptions {
  /** Path of `ssh`, from `findCommand("ssh")`. */
  ssh: string;
  /** Passed as `-F`; without it ssh reads the user's own config. */
  configPath?: string;
  run?: CommandRunner;
}

/** What ssh itself makes of an alias, without connecting. */
export async function resolveSshHost(alias: string, options: ResolveSshHostOptions): Promise<ResolvedSshHost> {
  if (!isSshAlias(alias)) throw new Error(`"${alias}" is not a host name ssh accepts.`);
  const args = ["-G", ...(options.configPath ? ["-F", options.configPath] : []), "--", alias];
  const result = await (options.run ?? runCommand)(options.ssh, args);
  if (result.code !== 0) throw new Error(`ssh -G ${alias} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return parseSshG(alias, result.stdout);
}

export interface ManualTarget {
  protocol: ServerProtocol;
  username?: string;
  host: string;
  port: number;
  remotePath: string;
}

/**
 * A typed-in `[sftp://|ftp://][user@]host[:port]`, IPv6 in brackets, and a
 * remote path. A path after the host (`host:/var/www` or a URL path) is taken
 * when `remotePath` is empty.
 */
export function parseManualTarget(address: string, remotePath = "", defaultProtocol: ServerProtocol = "sftp"): { target?: ManualTarget; error?: string } {
  let rest = address.trim();
  let protocol = defaultProtocol;
  const scheme = /^(sftp|ssh|ftp):\/\//iu.exec(rest);
  if (scheme) {
    protocol = scheme[1]!.toLowerCase() === "ftp" ? "ftp" : "sftp";
    rest = rest.slice(scheme[0].length);
  }
  let path = remotePath.trim();
  const slash = scheme ? rest.indexOf("/") : -1;
  if (slash >= 0) {
    if (!path) path = decodeURIComponent(rest.slice(slash));
    rest = rest.slice(0, slash);
  }
  const at = rest.lastIndexOf("@");
  const username = at >= 0 ? decodeURIComponent(rest.slice(0, at)) : undefined;
  rest = at >= 0 ? rest.slice(at + 1) : rest;
  let host: string;
  let portText: string | undefined;
  const bracket = /^\[([0-9A-Fa-f:.]+)\](?::(.*))?$/u.exec(rest);
  if (bracket) {
    host = bracket[1]!;
    portText = bracket[2];
  } else {
    const colon = rest.indexOf(":");
    host = colon < 0 ? rest : rest.slice(0, colon);
    portText = colon < 0 ? undefined : rest.slice(colon + 1);
  }
  // scp style: `host:/path` puts the path where a port would be.
  if (portText !== undefined && portText.startsWith("/") && !scheme) {
    if (!path) path = portText;
    portText = undefined;
  }
  if (!host || !/^[A-Za-z0-9_.:%-]+$/u.test(host) || host.startsWith("-")) return { error: "Enter a host name or address." };
  if (username !== undefined && (!username || /[\s:/]/u.test(username) || username.startsWith("-"))) return { error: "The user name is not valid." };
  let port = protocol === "ftp" ? 21 : 22;
  if (portText !== undefined && portText !== "") {
    if (!/^\d{1,5}$/u.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) return { error: "The port must be a number from 1 to 65535." };
    port = Number(portText);
  }
  if (!path) return { error: "Enter the folder on the server." };
  if (!path.startsWith("/") && !path.startsWith("~")) return { error: "The folder on the server must be absolute (start with / or ~)." };
  return { target: { protocol, ...(username ? { username } : {}), host, port, remotePath: path } };
}
