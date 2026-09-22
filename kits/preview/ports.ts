import { sep } from "node:path";
import type { PreviewServer } from "./protocol.js";

/** A TCP socket some process listens on. `pid` and `command` are absent where the tool cannot say. */
export interface ListeningSocket {
  pid?: number;
  command?: string;
  host: string;
  port: number;
}

/** Ports dev servers default to; a listener on one is worth a probe even outside the workspace. */
export const COMMON_DEV_PORTS: ReadonlySet<number> = new Set([
  3000, 3001, 3333, 4000, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

/** Programs that serve pages for a living. */
const DEV_COMMANDS = /^(node|nodejs|bun|deno|python\d?(\.\d+)?|ruby|php|java|go|dotnet|uvicorn|gunicorn|hugo|jekyll|caddy|vite|esbuild|http-server|next-server)$/iu;

const LOOPBACK_OR_ANY = new Set(["*", "0.0.0.0", "127.0.0.1", "::", "::1", "localhost", "[::]", "[::1]"]);

/** `*:8000`, `127.0.0.1:3000`, `[::1]:5173`, and netstat's `127.0.0.1.8000` / `*.8000`. */
export function splitAddress(address: string): { host: string; port: number } | undefined {
  const match = /^(.*)[:.](\d{1,5})$/u.exec(address.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = match[1]!.replace(/^\[(.*)\]$/u, "$1").replace(/%.*$/u, "") || "*";
  return { host, port };
}

/** `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`: one `p`, `c` pair per process, then an `n` per socket. */
export function parseLsofListeners(output: string): ListeningSocket[] {
  const sockets = new Map<string, ListeningSocket>();
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      command = undefined;
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      const address = splitAddress(value.replace(/->.*$/u, ""));
      if (!address) continue;
      const key = `${pid ?? "?"}:${address.port}`;
      if (!sockets.has(key)) sockets.set(key, { ...(pid ? { pid } : {}), ...(command ? { command } : {}), ...address });
    }
  }
  return [...sockets.values()];
}

/** `lsof -a -d cwd -p <pids> -F pn`: each process's working directory. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || undefined;
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/**
 * `netstat -an` on macOS and Linux, `netstat -ano -p TCP` on Windows. Only
 * listening TCP rows count; Windows adds the PID as the last column.
 */
export function parseNetstatListeners(output: string): ListeningSocket[] {
  const sockets = new Map<string, ListeningSocket>();
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    const proto = columns[0]?.toLowerCase() ?? "";
    if (!proto.startsWith("tcp") || !/^LISTEN(ING)?$/iu.test(columns.find((column) => /^LISTEN/iu.test(column)) ?? "")) continue;
    // Windows: Proto Local Foreign State PID. Unix: Proto Recv-Q Send-Q Local Foreign State.
    const windows = /^\d+$/u.test(columns.at(-1) ?? "") && /^LISTENING$/iu.test(columns.at(-2) ?? "");
    const local = windows ? columns[1] : columns[3];
    const address = local ? splitAddress(local) : undefined;
    if (!address) continue;
    const pid = windows ? Number(columns.at(-1)) || undefined : undefined;
    const key = `${pid ?? "?"}:${address.port}`;
    if (!sockets.has(key)) sockets.set(key, { ...(pid ? { pid } : {}), ...address });
  }
  return [...sockets.values()];
}

function inside(path: string | undefined, root: string): boolean {
  if (!path || !root) return false;
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(base);
}

/**
 * The listeners worth a probe: reachable on this machine, not Tau itself, and
 * either started inside the workspace, on a dev server's usual port, or by a
 * program that serves pages. One per port.
 */
export function candidateServers(
  sockets: readonly ListeningSocket[],
  options: { cwds?: ReadonlyMap<number, string>; workspaceRoot: string; ownPids: ReadonlySet<number> },
): PreviewServer[] {
  const byPort = new Map<number, PreviewServer>();
  for (const socket of sockets) {
    if (!LOOPBACK_OR_ANY.has(socket.host)) continue;
    if (socket.pid !== undefined && options.ownPids.has(socket.pid)) continue;
    const cwd = socket.pid !== undefined ? options.cwds?.get(socket.pid) : undefined;
    const inWorkspace = inside(cwd, options.workspaceRoot);
    const devLike = COMMON_DEV_PORTS.has(socket.port) || (socket.command !== undefined && DEV_COMMANDS.test(socket.command));
    if (!inWorkspace && !devLike) continue;
    const host = socket.host === "::1" ? "[::1]" : "localhost";
    const server: PreviewServer = {
      url: `http://${host}:${socket.port}/`,
      port: socket.port,
      ...(socket.pid !== undefined ? { pid: socket.pid } : {}),
      ...(socket.command ? { command: socket.command } : {}),
      inWorkspace,
      html: false,
    };
    const known = byPort.get(socket.port);
    if (!known || (inWorkspace && !known.inWorkspace)) byPort.set(socket.port, server);
  }
  return [...byPort.values()];
}

/** Workspace servers first, then pages over anything else, then by port. */
export function rankServers(servers: readonly PreviewServer[]): PreviewServer[] {
  return [...servers].sort((left, right) =>
    Number(right.inWorkspace) - Number(left.inWorkspace)
    || Number(right.html) - Number(left.html)
    || left.port - right.port);
}

export type ProbeResult = "html" | "http" | "none";

/** Whether an HTTP server answers there, and whether with a page. A redirect counts as a page. */
export async function probeHttp(url: string, timeoutMs = 800): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    void response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) return "html";
    const type = response.headers.get("content-type") ?? "";
    return response.status < 500 && /html/iu.test(type) ? "html" : "http";
  } catch {
    return "none";
  }
}

export interface PortScanOptions {
  workspaceRoot: string;
  platform: NodeJS.Platform;
  ownPids: ReadonlySet<number>;
  findCommand(name: string): string | undefined;
  /** Runs a read-only command and answers its stdout; a failure answers "". */
  run(command: string, args: readonly string[]): Promise<string>;
  probe(url: string): Promise<ProbeResult>;
}

/** Listening sockets from `lsof`, else `netstat`. */
async function listeners(options: PortScanOptions): Promise<{ sockets: ListeningSocket[]; lsof?: string }> {
  const lsof = options.platform === "win32" ? undefined : options.findCommand("lsof");
  if (lsof) {
    const sockets = parseLsofListeners(await options.run(lsof, ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]));
    if (sockets.length > 0) return { sockets, lsof };
  }
  const netstat = options.findCommand("netstat");
  if (!netstat) return { sockets: [] };
  const args = options.platform === "win32" ? ["-ano", "-p", "TCP"] : ["-an"];
  return { sockets: parseNetstatListeners(await options.run(netstat, args)) };
}

/** Local dev servers, ranked for the address bar. Never throws: no tool, no suggestions. */
export async function scanPorts(options: PortScanOptions): Promise<PreviewServer[]> {
  const { sockets, lsof } = await listeners(options);
  const pids = [...new Set(sockets.flatMap((socket) => socket.pid !== undefined && !options.ownPids.has(socket.pid) ? [socket.pid] : []))];
  const cwds = lsof && pids.length > 0
    ? parseLsofCwds(await options.run(lsof, ["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"]))
    : undefined;
  const candidates = candidateServers(sockets, { cwds, workspaceRoot: options.workspaceRoot, ownPids: options.ownPids });
  const probed = await Promise.all(candidates.map(async (server) => ({ server, answer: await options.probe(server.url) })));
  const servers = probed.flatMap(({ server, answer }) => {
    if (answer === "html") return [{ ...server, html: true }];
    // A workspace server that answers with something else is still the user's own.
    return answer === "http" && server.inWorkspace ? [server] : [];
  });
  return rankServers(servers);
}
