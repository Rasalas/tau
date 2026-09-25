import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** While set to `1`, every target but loopback is refused before ssh starts. */
export const LOOPBACK_ONLY_ENV = "TAU_SERVERS_LOOPBACK_ONLY";

export interface SshHop {
  host: string;
  port?: number;
  username?: string;
}

/**
 * What the SSH transport needs of a server target. The field names are those
 * of an sftp.json target, so one of those fits as it is; an ssh config alias
 * sets `alias` and leaves `HostName`, `User` and `Port` to ssh.
 */
export interface SshTarget {
  /** The target's state-folder key. */
  id: string;
  /** How dialogs name it; falls back to `user@host`. */
  name?: string;
  alias?: string;
  host: string;
  port?: number;
  username?: string;
  remotePath: string;
  /** `~`, `$VAR` and workspace-relative paths are resolved against `baseDir`. */
  privateKeyPath?: string;
  agent?: string;
  sshConfigPath?: string;
  knownHostsPath?: string;
  hop?: readonly SshHop[];
  /** `false` accepts a new host key without asking; a changed one is still refused. */
  hostVerification?: boolean;
  /** Milliseconds, as sftp.json has it. */
  connectTimeout?: number;
  concurrency?: number;
}

export interface SshArgsOptions {
  /** `-F` from the environment (a test instance); a target's own `sshConfigPath` wins. */
  configPath?: string;
  /** The ControlMaster folder; none on Windows. */
  controlDir?: string;
  /** Where relative key paths start: the project. */
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const HOST_PATTERN = /^[A-Za-z0-9_.:%[\]-]+$/u;
const USER_PATTERN = /^[^\s@:/]+$/u;

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare);
}

function checkHost(host: string, what: string): void {
  if (!host || host.startsWith("-") || !HOST_PATTERN.test(host)) throw new Error(`${what} "${host}" is not a host name ssh accepts.`);
}

function checkUser(user: string | undefined): void {
  if (user !== undefined && (user.startsWith("-") || !USER_PATTERN.test(user))) throw new Error(`"${user}" is not a user name ssh accepts.`);
}

/** `~/`, `$VAR`/`${VAR}` and a path relative to `baseDir`, as the sftp.json extension resolves them. */
export function expandLocalPath(path: string, options: Pick<SshArgsOptions, "baseDir" | "env" | "home"> = {}): string {
  const env = options.env ?? process.env;
  let expanded = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, braced: string | undefined, bare: string | undefined) => env[braced ?? bare ?? ""] ?? "");
  if (expanded === "~" || expanded.startsWith("~/")) expanded = join(options.home ?? homedir(), expanded.slice(1));
  if (!isAbsolute(expanded) && options.baseDir) expanded = join(options.baseDir, expanded);
  return expanded;
}

/** An `-o` value is one argv entry, but ssh still splits it on spaces unless quoted. */
const optionPath = (path: string) => (/[\s"]/u.test(path) ? `"${path.replaceAll("\"", "\\\"")}"` : path);

const hopSpec = (hop: SshHop) => {
  checkHost(hop.host, "The jump host");
  checkUser(hop.username);
  const host = hop.host.includes(":") && !hop.host.startsWith("[") ? `[${hop.host}]` : hop.host;
  return `${hop.username ? `${hop.username}@` : ""}${host}${hop.port ? `:${hop.port}` : ""}`;
};

/**
 * The options every ssh call of a target shares, then `--` and the
 * destination. Nothing asks on a terminal: questions go through askpass.
 */
export function sshBaseArgs(target: SshTarget, options: SshArgsOptions = {}): { args: string[]; destination: string } {
  const args: string[] = [];
  const config = target.sshConfigPath ? expandLocalPath(target.sshConfigPath, options) : options.configPath;
  if (config) args.push("-F", config);
  if (target.alias) {
    checkHost(target.alias, "The ssh host");
  } else {
    checkHost(target.host, "The host");
    checkUser(target.username);
    if (target.username) args.push("-l", target.username);
    if (target.port) args.push("-p", String(target.port));
  }
  if (target.privateKeyPath) args.push("-i", expandLocalPath(target.privateKeyPath, options), "-o", "IdentitiesOnly=yes");
  if (target.agent) args.push("-o", `IdentityAgent=${optionPath(expandLocalPath(target.agent, options))}`);
  if (target.knownHostsPath) args.push("-o", `UserKnownHostsFile=${optionPath(expandLocalPath(target.knownHostsPath, options))}`);
  if (target.hostVerification === false) args.push("-o", "StrictHostKeyChecking=accept-new");
  if (target.hop?.length) args.push("-J", target.hop.map(hopSpec).join(","));
  args.push("-o", `ConnectTimeout=${Math.max(1, Math.round((target.connectTimeout ?? 10_000) / 1000))}`);
  args.push("-o", "BatchMode=no", "-o", "ServerAliveInterval=30", "-o", "ForwardAgent=no", "-o", "ForwardX11=no");
  if (options.controlDir) {
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${optionPath(join(options.controlDir, "%C"))}`, "-o", "ControlPersist=10m");
  }
  return { args, destination: target.alias ?? target.host };
}

/** How ssh itself resolves the destination, from `ssh -G`. */
export interface SshResolved {
  hostname: string;
  port: number;
  user?: string;
  proxyJump?: string;
  proxyCommand?: string;
}

export function parseSshResolution(stdout: string): SshResolved {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    if (!values.has(key)) values.set(key, line.slice(space + 1).trim());
  }
  const none = (value: string | undefined) => (value && value !== "none" ? value : undefined);
  const resolved: SshResolved = { hostname: values.get("hostname") ?? "", port: Number(values.get("port") ?? 22) };
  const user = values.get("user");
  if (user) resolved.user = user;
  const jump = none(values.get("proxyjump"));
  if (jump) resolved.proxyJump = jump;
  const command = none(values.get("proxycommand"));
  if (command) resolved.proxyCommand = command;
  return resolved;
}

/** The host part of one `[user@]host[:port]` or `ssh://` ProxyJump entry. */
function jumpHost(entry: string): string {
  let rest = entry.replace(/^ssh:\/\//u, "");
  rest = rest.slice(rest.lastIndexOf("@") + 1);
  const bracket = /^\[([^\]]+)\]/u.exec(rest);
  if (bracket) return bracket[1]!;
  return rest.split(":")[0]!;
}

/**
 * The loopback guard: what ssh would connect to (and every jump on the way)
 * must be loopback. A ProxyCommand could go anywhere, so it is refused too.
 */
export function loopbackRefusal(resolved: SshResolved): string | undefined {
  if (!isLoopbackHost(resolved.hostname)) return `${resolved.hostname} is not loopback`;
  if (resolved.proxyCommand) return "a ProxyCommand can reach any host";
  for (const entry of resolved.proxyJump?.split(",") ?? []) {
    const host = jumpHost(entry.trim());
    // A jump named by alias resolves in the same config; only an address can be checked here.
    if (!isLoopbackHost(host)) return `the jump host ${host} is not loopback`;
  }
  return undefined;
}

export const loopbackOnly = (env: NodeJS.ProcessEnv = process.env) => env[LOOPBACK_ONLY_ENV] === "1";

/**
 * `/tmp/tau-<uid>`: short enough for a socket path (104 bytes on macOS),
 * created 0700 and refused unless it is a real directory this user owns.
 */
export async function ensureControlDir(root = "/tmp", uid = process.getuid?.()): Promise<string> {
  if (uid === undefined) throw new Error("ControlMaster needs a POSIX user id.");
  const dir = join(root, `tau-${uid}`);
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a directory; Tau does not put its ssh sockets there.`);
  if (info.uid !== uid) throw new Error(`${dir} belongs to another user; Tau does not put its ssh sockets there.`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
  return dir;
}

/** One POSIX shell word. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
