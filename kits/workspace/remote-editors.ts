import type { EditorPosition, InstalledEditor } from "./editors.js";
import { FILE_MANAGER_ID } from "./protocol.js";

/**
 * Opening a project of another machine in an editor of the window's own
 * machine: the destination it reaches that machine at over SSH, and the
 * command or URL each editor takes for a remote folder. No Node here; the
 * desktop half reads the same rules to say what an editor can do.
 */

/** `[user@]host[:port]`, or an `~/.ssh/config` alias as `host`. */
export interface SshDestination {
  user?: string;
  host: string;
  port?: number;
}

/** Where the window's editor finds the project. */
export type RemoteLocation =
  | { kind: "ssh"; destination: string }
  | { kind: "wsl"; distro: string };

/** The machine's path on its own system: a Windows one is written `/C:/…` in a remote URI. */
export type RemotePlatform = "win32" | "posix";

const HOST_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/u;
const IPV6 = /^[0-9A-Fa-f]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9._-]+)?$/u;
// `user@domain` and `DOMAIN\user` are both names Windows accounts sign in with.
const USER = /^[A-Za-z0-9._][A-Za-z0-9._@\\-]{0,63}$/u;
const SSH_HINT = "Enter user@host, host:port or an ~/.ssh/config alias.";

export function parseSshDestination(text: string): { destination: SshDestination } | { error: string } {
  let rest = text.trim();
  if (!rest) return { error: SSH_HINT };
  if (/\s/u.test(rest)) return { error: `No spaces. ${SSH_HINT}` };
  if (/^ssh:\/\//iu.test(rest)) {
    rest = rest.slice("ssh://".length).replace(/\/$/u, "");
    if (rest.includes("/")) return { error: "An SSH destination has no path. Enter the folder's machine only." };
  }
  const at = rest.lastIndexOf("@");
  const user = at >= 0 ? rest.slice(0, at) : undefined;
  const authority = at >= 0 ? rest.slice(at + 1) : rest;
  if (user !== undefined && !USER.test(user)) return { error: `"${user}" is not a user name SSH takes.` };
  let host: string;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return { error: "An IPv6 address in brackets needs its closing ]." };
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after && !after.startsWith(":")) return { error: SSH_HINT };
    if (after) port = after.slice(1);
    if (!IPV6.test(host)) return { error: `"${host}" is not an IPv6 address.` };
  } else if ((authority.match(/:/gu)?.length ?? 0) >= 2) {
    // A bare IPv6 address has no room for a port.
    host = authority;
    if (!IPV6.test(host)) return { error: `"${host}" is not an IPv6 address.` };
  } else {
    const colon = authority.indexOf(":");
    host = colon >= 0 ? authority.slice(0, colon) : authority;
    if (colon >= 0) port = authority.slice(colon + 1);
    if (!HOST_NAME.test(host)) return { error: host ? `"${host}" is not a host name or an SSH alias.` : SSH_HINT };
  }
  if (port !== undefined) {
    const number = /^\d{1,5}$/u.test(port) ? Number(port) : Number.NaN;
    if (!(number >= 1 && number <= 65_535)) return { error: `"${port}" is not a port (1–65535).` };
    return { destination: { ...(user ? { user } : {}), host, port: number } };
  }
  return { destination: { ...(user ? { user } : {}), host } };
}

/** The destination as Settings shows and stores it: `user@host`, `user@[::1]:2222`. */
export function formatSshDestination(destination: SshDestination): string {
  const host = destination.host.includes(":") ? `[${destination.host}]` : destination.host;
  return `${destination.user ? `${destination.user}@` : ""}${host}${destination.port ? `:${destination.port}` : ""}`;
}

/** How the window reaches a machine, as `UiEnvironment.route` says it. */
export type MachineRoute =
  | { kind: "ssh"; target: string }
  | { kind: "wsl"; distro: string }
  | { kind: "connect" }
  | { kind: "direct"; hosts: readonly string[] };

/** Where a remote location came from, for Settings to say. */
export type RemoteLocationSource = "saved" | "tau-ssh" | "wsl" | "address";

export type RemoteLocationChoice =
  | { location: RemoteLocation; source: RemoteLocationSource; problem?: undefined }
  | { location?: undefined; problem: string };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./u.test(host) || host.endsWith(".localhost");

/**
 * The SSH destination of a machine: the one the user entered for it, else
 * the target of Tau's own SSH route, its WSL distribution, or the best name
 * of its addresses. A machine reached only through Tau Connect has none,
 * nor one known only at a loopback address: that may be another Tau on this
 * computer or a forward to any other, and nothing names which, so its paths
 * are never taken for this machine's.
 */
export function chooseRemoteLocation(input: { name: string; saved?: string; route?: MachineRoute; address?: string }): RemoteLocationChoice {
  const saved = input.saved?.trim();
  if (saved) {
    const parsed = parseSshDestination(saved);
    return "error" in parsed
      ? { problem: `The SSH destination saved for ${input.name} is not valid: ${parsed.error}` }
      : { location: { kind: "ssh", destination: formatSshDestination(parsed.destination) }, source: "saved" };
  }
  const route = input.route;
  if (route?.kind === "wsl") return { location: { kind: "wsl", distro: route.distro }, source: "wsl" };
  if (route?.kind === "ssh") {
    const parsed = parseSshDestination(route.target);
    if (!("error" in parsed)) return { location: { kind: "ssh", destination: formatSshDestination(parsed.destination) }, source: "tau-ssh" };
  }
  if (route?.kind === "connect") {
    return { problem: `${input.name} is reached through Tau Connect, which carries no SSH. Enter how this device reaches it over SSH under Settings → Machines.` };
  }
  let hosts = route?.kind === "direct" ? [...route.hosts] : [];
  if (hosts.length === 0 && input.address) {
    try { hosts = [new URL(input.address).hostname.replace(/^\[(.*)\]$/u, "$1")].filter(Boolean); } catch { /* no address to read */ }
  }
  const remote = hosts.find((host) => !isLoopback(host));
  if (remote) {
    const parsed = parseSshDestination(remote.includes(":") ? `[${remote}]` : remote);
    if (!("error" in parsed)) return { location: { kind: "ssh", destination: formatSshDestination(parsed.destination) }, source: "address" };
  }
  if (hosts.length > 0) {
    return { problem: `Tau reaches ${input.name} only at a local address (a forward, or another Tau on this machine). Enter its SSH destination under Settings → Machines.` };
  }
  return { problem: `Tau does not know how this device reaches ${input.name} over SSH. Enter its SSH destination under Settings → Machines.` };
}

type RemoteFamily = { family: "vscode"; scheme?: string } | { family: "zed" };

/**
 * The editors that open a remote folder, by the ids `EDITORS` gives them.
 * VS Code's own CLI and URL forms (code.visualstudio.com/docs/configure/command-line):
 * `--remote ssh-remote+<host> <path>`, `vscode://vscode-remote/ssh-remote+<host><path>`;
 * its forks take the same with an SSH extension of theirs. Zed's
 * (zed.dev/docs/remote-development): `zed ssh://[user@]host[:port]/path`,
 * `zed://ssh/[user@]host[:port]/path`.
 */
const REMOTE_EDITORS: Readonly<Record<string, RemoteFamily>> = {
  code: { family: "vscode", scheme: "vscode" },
  "code-insiders": { family: "vscode", scheme: "vscode-insiders" },
  cursor: { family: "vscode", scheme: "cursor" },
  windsurf: { family: "vscode", scheme: "windsurf" },
  codium: { family: "vscode", scheme: "vscodium" },
  trae: { family: "vscode" },
  kiro: { family: "vscode" },
  antigravity: { family: "vscode" },
  zed: { family: "zed" },
};

const JETBRAINS = new Set(["idea", "aqua", "clion", "datagrip", "dataspell", "goland", "phpstorm", "pycharm", "rider", "rubymine", "rustrover", "webstorm"]);

/**
 * Why an editor of this device cannot open a project at `location`, or
 * nothing when it can. `launch` is how it is installed here: a macOS bundle
 * without its launcher can only be handed a URL.
 */
export function remoteEditorUnsupported(editor: { id: string; name: string; launch?: { kind: string } }, location: RemoteLocation): string | undefined {
  if (editor.id === FILE_MANAGER_ID) return `${editor.name} shows this device's files only.`;
  const family = REMOTE_EDITORS[editor.id];
  if (!family) {
    return JETBRAINS.has(editor.id)
      ? `${editor.name} opens remote projects through JetBrains Gateway, which Tau does not start.`
      : `${editor.name} cannot open a folder on another machine.`;
  }
  if (family.family === "zed" && location.kind === "wsl") return "Zed opens a WSL folder only from its own “Open WSL” command.";
  if (family.family === "vscode" && editor.launch?.kind === "app" && !family.scheme) return `${editor.name} needs its command-line launcher to open a remote project.`;
  return undefined;
}

const hex = (text: string) => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The remote authority a VS Code-family editor resolves: `ssh-remote+alias`
 * or `ssh-remote+user@host` as Remote-SSH's own picker writes it, and its
 * hex-encoded JSON form (`{"hostName":"user@host -p 2222"}`) for a port, an
 * IPv6 address or a user with `@` or `\` in it, which the plain form cannot carry.
 */
export function vscodeAuthority(location: RemoteLocation): string {
  if (location.kind === "wsl") return `wsl+${location.distro}`;
  const parsed = parseSshDestination(location.destination);
  if ("error" in parsed) throw new Error(parsed.error);
  const { user, host, port } = parsed.destination;
  const userPart = user ? `${user}@` : "";
  if (!port && !host.includes(":") && !/[@\\]/u.test(user ?? "")) return `ssh-remote+${userPart}${host}`;
  return `ssh-remote+${hex(JSON.stringify({ hostName: `${userPart}${host}${port ? ` -p ${port}` : ""}` }))}`;
}

/** A remote path as a URI path: `/home/me/a b` → `/home/me/a%20b`; `C:\p` → `/C%3A/p`. */
export function remoteUriPath(path: string, platform: RemotePlatform = "posix"): string {
  const posix = remotePosixPath(path, platform);
  return posix.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** What a VS Code-family CLI takes after `--remote`: `/C:/Users/me` for a Windows machine's `C:\Users\me`. */
export function remotePosixPath(path: string, platform: RemotePlatform = "posix"): string {
  if (platform !== "win32") return path;
  const slashed = path.replace(/\\/gu, "/");
  return /^[A-Za-z]:/u.test(slashed) ? `/${slashed}` : slashed;
}

/** `ssh://user@[::1]:2222` for Zed: a user with `@` is percent-encoded, which Zed decodes. */
function zedAuthority(destination: string): string {
  const parsed = parseSshDestination(destination);
  if ("error" in parsed) throw new Error(parsed.error);
  const { user, host, port } = parsed.destination;
  return `${user ? `${encodeURIComponent(user)}@` : ""}${host.includes(":") ? `[${host}]` : host}${port ? `:${port}` : ""}`;
}

export interface RemoteOpen {
  location: RemoteLocation;
  /** The project's folder on its machine. */
  root: string;
  /** A file inside it, opened in the project's window. */
  file?: string;
  position?: EditorPosition;
  platform?: RemotePlatform;
}

const positioned = (path: string, position?: EditorPosition) => {
  const line = position?.line && position.line > 0 ? position.line : undefined;
  const column = line && position?.column && position.column > 0 ? position.column : undefined;
  return line ? `${path}:${line}${column ? `:${column}` : ""}` : path;
};

/**
 * The command that opens a remote project in one editor of this device. A
 * VS Code-family launcher gets the folder and the file in one window, at a
 * line with `--goto`; a macOS bundle without its launcher is handed the
 * editor's URL. Zed takes no line in an `ssh://` path, so it opens the file.
 */
export function remoteEditorCommand(editor: InstalledEditor, request: RemoteOpen): { command: string; args: string[] } {
  const reason = remoteEditorUnsupported(editor, request.location);
  if (reason) throw new Error(reason);
  const family = REMOTE_EDITORS[editor.id]!;
  const { launch } = editor;
  const platform = request.platform ?? "posix";
  if (family.family === "zed") {
    const authority = zedAuthority((request.location as { destination: string }).destination);
    const paths = [request.root, ...(request.file ? [request.file] : [])].map((path) => remoteUriPath(path, platform));
    if (launch.kind === "app") return { command: "open", args: [`zed://ssh/${authority}${paths.at(-1)}`] };
    return { command: (launch as { command: string }).command, args: paths.map((path) => `ssh://${authority}${path}`) };
  }
  const authority = vscodeAuthority(request.location);
  if (launch.kind === "app") {
    const target = request.file ?? request.root;
    return { command: "open", args: [`${family.scheme}://vscode-remote/${authority}${positioned(remoteUriPath(target, platform), request.file ? request.position : undefined)}`] };
  }
  if (launch.kind !== "command") throw new Error(`${editor.name} cannot open a folder on another machine.`);
  const root = remotePosixPath(request.root, platform);
  const file = request.file ? remotePosixPath(request.file, platform) : undefined;
  const at = file ? positioned(file, request.position) : undefined;
  return {
    command: launch.command,
    args: [...launch.baseArgs, "--remote", authority, ...(at && at !== file ? ["--goto", root, at] : [root, ...(file ? [file] : [])])],
  };
}

const WSL_DISTRO = /^[A-Za-z0-9][\w.-]{0,99}$/u;

/** A location from the wire: an invalid destination is refused before any editor starts. */
export function decodeRemoteLocation(value: unknown): RemoteLocation {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (item.kind === "wsl" && typeof item.distro === "string" && WSL_DISTRO.test(item.distro)) return { kind: "wsl", distro: item.distro };
  if (item.kind === "ssh" && typeof item.destination === "string") {
    const parsed = parseSshDestination(item.destination);
    if ("error" in parsed) throw new Error(parsed.error);
    return { kind: "ssh", destination: formatSshDestination(parsed.destination) };
  }
  throw new Error("Name where the project is: an SSH destination or a WSL distribution.");
}

const hasControlCharacter = (value: string) => [...value].some((character) => character.charCodeAt(0) < 0x20);

/**
 * Whether `path` is `root` or lies below it, both absolute on the machine's
 * own system; no `..` step, no control character. Read without touching a
 * disk, since the paths may be another machine's.
 */
export function remotePathInside(root: string, path: string, platform: RemotePlatform = "posix"): boolean {
  if (hasControlCharacter(root) || hasControlCharacter(path)) return false;
  const absolute = platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/u : /^\//u;
  if (!absolute.test(root) || !absolute.test(path)) return false;
  const split = (value: string) => value.split(platform === "win32" ? /[\\/]+/u : /\/+/u).filter(Boolean);
  const rootParts = split(root);
  const parts = split(path);
  if (parts.some((part) => part === "." || part === "..")) return false;
  const same = (a: string, b: string) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return parts.length >= rootParts.length && rootParts.every((part, index) => same(part, parts[index]!));
}
