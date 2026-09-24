import { spawn } from "node:child_process";
import type { ServeOther, TailscaleState } from "./protocol.js";

/** What a run of the CLI answered. Output is kept for parsing only; it is never logged. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** The program did not start at all. */
  failedToStart?: boolean;
}

export type RunCli = (command: string, args: readonly string[], timeoutMs: number) => Promise<CliResult>;

const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Runs the CLI without a shell and without stdin: a question it would ask
 * (`serve` offering to turn HTTPS on) reads end-of-file instead of waiting.
 */
export const runCli: RunCli = (command, args, timeoutMs) => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    resolve({ code: null, stdout: "", stderr: "", failedToStart: true });
    return;
  }
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += String(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += String(chunk); });
  child.once("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr, failedToStart: true }); });
  child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) }); });
});

/** The facts `tailscale status --json` gives that Tau uses; everything else, the peers above all, is dropped. */
export interface TailscaleStatus {
  state: Exclude<TailscaleState, "no-host-network" | "not-installed">;
  backendState: string;
  dnsName?: string;
  magicDns: boolean;
  https: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseStatus(json: string): TailscaleStatus | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const status = record(parsed);
  const backendState = typeof status.BackendState === "string" ? status.BackendState : "";
  if (!backendState) return undefined;
  const self = record(status.Self);
  const rawName = typeof self.DNSName === "string" ? self.DNSName.trim().replace(/\.$/u, "").toLowerCase() : "";
  const dnsName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(rawName) ? rawName : undefined;
  const tailnet = record(status.CurrentTailnet);
  const certDomains = Array.isArray(status.CertDomains) ? status.CertDomains.filter((entry): entry is string => typeof entry === "string") : [];
  const state = backendState === "Running" ? "running"
    : backendState === "NeedsLogin" || backendState === "NeedsMachineAuth" ? "needs-login"
      : "not-running";
  return {
    state,
    backendState,
    ...(dnsName ? { dnsName } : {}),
    // Older clients have no CurrentTailnet; a MagicDNS name is the sign then.
    magicDns: typeof tailnet.MagicDNSEnabled === "boolean" ? tailnet.MagicDNSEnabled : dnsName !== undefined,
    https: dnsName !== undefined && certDomains.some((domain) => domain.toLowerCase().replace(/\.$/u, "") === dnsName),
  };
}

/** One HTTPS port of `tailscale serve status --json`, as far as Tau reads it. */
export interface ServePort {
  httpsPort: number;
  /** Mount point → where it forwards (`Proxy`), or what it answers with instead. */
  handlers: Record<string, string>;
  /** A plain TCP forward on the port rather than a web server. */
  tcpForward?: string;
}

/** Serve's config (`ipn.ServeConfig`): TCP ports, and web handlers under `<name>:<port>`. */
export function parseServeConfig(json: string, dnsName: string): ServePort[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(json.trim() || "{}"); } catch { return undefined; }
  const config = record(parsed);
  const tcp = record(config.TCP);
  const web = record(config.Web);
  const ports = new Map<number, ServePort>();
  const port = (httpsPort: number): ServePort => {
    const existing = ports.get(httpsPort) ?? { httpsPort, handlers: {} };
    ports.set(httpsPort, existing);
    return existing;
  };
  for (const [key, value] of Object.entries(tcp)) {
    const number = Number(key);
    if (!Number.isInteger(number)) continue;
    const handler = record(value);
    if (typeof handler.TCPForward === "string" && handler.TCPForward) port(number).tcpForward = handler.TCPForward;
    else if (handler.HTTPS === true || handler.HTTP === true) port(number);
  }
  for (const [hostPort, value] of Object.entries(web)) {
    const separator = hostPort.lastIndexOf(":");
    if (separator < 0 || hostPort.slice(0, separator).toLowerCase().replace(/\.$/u, "") !== dnsName) continue;
    const number = Number(hostPort.slice(separator + 1));
    if (!Number.isInteger(number)) continue;
    for (const [path, handler] of Object.entries(record(record(value).Handlers))) {
      const { Proxy: proxy, Path: files, Text: text, Redirect: redirect } = record(handler);
      const target = typeof proxy === "string" ? proxy
        : typeof files === "string" ? `files at ${files}`
          : typeof redirect === "string" ? `a redirect to ${redirect}`
            : typeof text === "string" ? "a fixed text" : "something";
      port(number).handlers[path] = target;
    }
  }
  return [...ports.values()].sort((a, b) => a.httpsPort - b.httpsPort);
}

/** Whether Serve's target is Tau's proxy listener: `http://127.0.0.1:<port>`, however the CLI wrote it down. */
export function isTauProxy(target: string | undefined, proxyPort: number): boolean {
  if (!target) return false;
  if (/^\d+$/u.test(target)) return Number(target) === proxyPort;
  try {
    const url = new URL(target.includes("://") ? target : `http://${target}`);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port || 80) === proxyPort;
  } catch {
    return false;
  }
}

/** The port Serve forwards `/` to Tau on, preferring `preferred`. */
export function tauServePort(ports: readonly ServePort[], proxyPort: number, preferred?: number): number | undefined {
  const ours = ports.filter((entry) => isTauProxy(entry.handlers["/"], proxyPort)).map((entry) => entry.httpsPort);
  return preferred !== undefined && ours.includes(preferred) ? preferred : ours[0];
}

/** Everything Serve forwards that is not Tau's own `/`. */
export function otherServes(ports: readonly ServePort[], proxyPort: number): ServeOther[] {
  return ports.flatMap((entry) => [
    ...(entry.tcpForward ? [{ httpsPort: entry.httpsPort, path: "", target: `TCP to ${entry.tcpForward}` }] : []),
    ...Object.entries(entry.handlers)
      .filter(([path, target]) => !(path === "/" && isTauProxy(target, proxyPort)))
      .map(([path, target]) => ({ httpsPort: entry.httpsPort, path, target })),
  ]);
}

/**
 * Why a `serve` run failed, in words for the user. The CLI's own output can
 * carry keys and node names, so it is matched, never passed on.
 */
export function describeFailure(result: CliResult, platform: string): string {
  if (result.failedToStart) return "The Tailscale command did not start.";
  if (result.timedOut) return "Tailscale did not answer in time. If it asked to turn on HTTPS, do that in the admin console first.";
  const text = `${result.stderr}\n${result.stdout}`;
  if (/access denied|permission denied|must be root|operation not permitted|operator/iu.test(text)) {
    return platform === "linux"
      ? "Tailscale refused: this user may not change Serve. Run `sudo tailscale set --operator=$USER` once in a terminal, then try again."
      : "Tailscale refused: this user may not change Serve.";
  }
  if (/not logged in|logged out|needs? login/iu.test(text)) return "Tailscale is signed out. Sign in, then try again.";
  if (/https|certificate|cert/iu.test(text) && /not enabled|disabled|enable/iu.test(text)) {
    return "HTTPS certificates are off in your tailnet. Turn them on in the admin console’s DNS page, then try again.";
  }
  if (/handler does not exist/iu.test(text)) return "Serve had nothing on that port to remove.";
  return `Tailscale did not do it (exit code ${result.code ?? "none"}).`;
}
