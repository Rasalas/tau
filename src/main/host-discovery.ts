import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { UiNetworkAnnouncement } from "../shared/connections.js";
import { discoveredHosts, isServiceType, type DiscoveredHost, type ResolvedService } from "../shared/discovery.js";
import type { HostLogger } from "./host-log.js";
import { findExecutable } from "./shell-environment.js";
import { WINDOWS_ANNOUNCE_SCRIPT, WINDOWS_BROWSE_SCRIPT, windowsScriptArguments } from "./host-discovery-windows.js";

/**
 * Bonjour/mDNS through the system's own responder: `dns-sd` on macOS, Avahi's
 * `avahi-publish`/`avahi-browse` on Linux, the DNS-SD API of `dnsapi.dll`
 * through PowerShell on Windows. Nothing here opens a multicast socket itself.
 */

/** What one host announces while Local network is on. */
export interface ServiceAnnouncement {
  type: string;
  name: string;
  port: number;
  txt: Record<string, string>;
}

/** The slice of a child process discovery uses; tests hand in fakes. */
export interface DiscoveryProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type DiscoverySpawn = (command: string, args: readonly string[]) => DiscoveryProcess;

export interface DiscoveryEnvironment {
  platform?: NodeJS.Platform;
  spawn?: DiscoverySpawn;
  /** Finds a system tool; `findExecutable` on PATH by default. */
  find?: (name: string) => string | undefined;
}

const defaultSpawn: DiscoverySpawn = (command, args) =>
  spawnProcess(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/**
 * Runs the tool in "$@" until its stdin closes, then ends it. The host closes
 * stdin to stop, and a host that dies closes it too, so an announcement never
 * outlives the host that made it.
 */
export const LIFETIME_SCRIPT = [
  "exec 3<&0",
  "\"$@\" </dev/null &",
  "child=$!",
  "( cat <&3 >/dev/null; kill \"$child\" 2>/dev/null ) >/dev/null 2>&1 &",
  "wait \"$child\"",
].join("\n");

interface Invocation {
  command: string;
  args: string[];
}

type Unavailable = { unavailable: string };

function wrapped(tool: string, args: string[]): Invocation {
  return { command: "/bin/sh", args: ["-c", LIFETIME_SCRIPT, "tau-discovery", tool, ...args] };
}

function txtArguments(txt: Record<string, string>): string[] {
  return Object.entries(txt).map(([key, value]) => `${key}=${value}`);
}

function environment(options: DiscoveryEnvironment): Required<DiscoveryEnvironment> {
  return {
    platform: options.platform ?? process.platform,
    spawn: options.spawn ?? defaultSpawn,
    find: options.find ?? ((name) => findExecutable(name, process.env, { platform: options.platform ?? process.platform })),
  };
}

const AVAHI_MISSING = "Avahi is not installed: install avahi-utils (avahi-tools on Fedora) and run avahi-daemon.";

/** How this platform announces `service` and how it tells it is up; the name is the one the network settled on. */
export function announceInvocation(service: ServiceAnnouncement, options: DiscoveryEnvironment = {}): (Invocation & { ready(line: string): string | undefined }) | Unavailable {
  const { platform, find } = environment(options);
  if (platform === "darwin") {
    const dnsSd = find("dns-sd");
    if (!dnsSd) return { unavailable: "dns-sd is missing on this Mac." };
    const suffix = `.${service.type}.local.: Name now registered and active`;
    return {
      ...wrapped(dnsSd, ["-R", service.name, service.type, "local.", String(service.port), ...txtArguments(service.txt)]),
      ready: (line) => {
        const at = line.indexOf("Got a reply for service ");
        return at >= 0 && line.endsWith(suffix) ? line.slice(at + "Got a reply for service ".length, -suffix.length) : undefined;
      },
    };
  }
  if (platform === "linux") {
    const publish = find("avahi-publish");
    if (!publish) return { unavailable: AVAHI_MISSING };
    return {
      ...wrapped(publish, ["-s", service.name, service.type, String(service.port), ...txtArguments(service.txt)]),
      ready: (line) => /Established under name '(.*)'/u.exec(line)?.[1],
    };
  }
  if (platform === "win32") {
    const powershell = find("powershell.exe") ?? find("powershell");
    if (!powershell) return { unavailable: "Windows PowerShell is missing, and Tau announces itself through it." };
    const request = { instance: `${service.name}.${service.type}.local`, host: `${windowsHostName()}.local`, port: service.port, keys: Object.keys(service.txt), values: Object.values(service.txt) };
    return {
      command: powershell,
      args: windowsScriptArguments(WINDOWS_ANNOUNCE_SCRIPT, request),
      ready: (line) => {
        const event = parseJsonLine(line) as { event?: string; name?: string } | undefined;
        return event?.event === "announced" ? stripServiceSuffix(event.name ?? service.name, service.type) : undefined;
      },
    };
  }
  return { unavailable: `Bonjour is not supported on ${platform}.` };
}

function windowsHostName(): string {
  return (process.env.COMPUTERNAME || hostname()).split(".")[0] ?? "tau";
}

/** How this platform lists `type` for a while; `stops` when the tool ends by itself. */
export function browseInvocation(type: string, timeoutMs: number, options: DiscoveryEnvironment = {}): (Invocation & { parse(output: string): ResolvedService[]; stops: boolean }) | Unavailable {
  const { platform, find } = environment(options);
  if (platform === "darwin") {
    const dnsSd = find("dns-sd");
    if (!dnsSd) return { unavailable: "dns-sd is missing on this Mac." };
    // -Z browses and resolves at once, and prints SRV and TXT as zone-file lines.
    return { ...wrapped(dnsSd, ["-Z", type, "local."]), parse: (output) => parseDnsSdZone(output, type), stops: false };
  }
  if (platform === "linux") {
    const browse = find("avahi-browse");
    if (!browse) return { unavailable: AVAHI_MISSING };
    return { ...wrapped(browse, ["--parsable", "--resolve", "--terminate", "--no-db-lookup", type]), parse: parseAvahiBrowse, stops: true };
  }
  if (platform === "win32") {
    const powershell = find("powershell.exe") ?? find("powershell");
    if (!powershell) return { unavailable: "Windows PowerShell is missing, and Tau looks for machines through it." };
    return {
      command: powershell,
      args: windowsScriptArguments(WINDOWS_BROWSE_SCRIPT, { query: `${type}.local`, milliseconds: timeoutMs }),
      parse: (output) => parseWindowsBrowse(output, type),
      stops: true,
    };
  }
  return { unavailable: `Bonjour is not supported on ${platform}.` };
}

/** `\DDD` (decimal) and `\X` as DNS presentation format and Avahi write them. */
export function unescapeDnsText(text: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\" && /^\d{3}$/u.test(text.slice(i + 1, i + 4))) {
      bytes.push(Number(text.slice(i + 1, i + 4)) & 0xff);
      i += 3;
    } else if (char === "\\" && i + 1 < text.length) {
      bytes.push(...encoder.encode(text[i + 1]!));
      i += 1;
    } else {
      bytes.push(...encoder.encode(char));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function txtEntries(strings: readonly string[]): Record<string, string> {
  const txt: Record<string, string> = {};
  for (const entry of strings) {
    const equals = entry.indexOf("=");
    const key = (equals >= 0 ? entry.slice(0, equals) : entry).toLowerCase();
    // The first of a repeated key counts (RFC 6763 §6.4).
    if (key && !(key in txt)) txt[key] = equals >= 0 ? entry.slice(equals + 1) : "";
  }
  return txt;
}

/** `"a=1" "b=2"` into its strings, escapes resolved. */
function quotedStrings(text: string): string[] {
  const strings: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/gu;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) strings.push(unescapeDnsText(match[1]!));
  return strings;
}

function stripServiceSuffix(name: string, type: string): string {
  const withoutDot = name.replace(/\.$/u, "");
  for (const suffix of [`.${type}.local`, `.${type}`]) {
    if (withoutDot.toLowerCase().endsWith(suffix.toLowerCase())) return withoutDot.slice(0, -suffix.length);
  }
  return withoutDot;
}

/** `dns-sd -Z` output: SRV and TXT lines per instance, repeated once per interface. */
export function parseDnsSdZone(output: string, type: string): ResolvedService[] {
  const found = new Map<string, { hostName?: string; port?: number; txt?: Record<string, string> }>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(SRV|TXT)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const [, owner, record, rest] = match;
    if (!owner!.toLowerCase().endsWith(`.${type}`.toLowerCase())) continue;
    const entry = found.get(owner!) ?? {};
    if (record === "SRV") {
      const srv = /^\d+\s+\d+\s+(\d+)\s+(\S+)/u.exec(rest!);
      if (srv) { entry.port = Number(srv[1]); entry.hostName = unescapeDnsText(srv[2]!).replace(/\.$/u, ""); }
    } else {
      entry.txt = txtEntries(quotedStrings(rest!));
    }
    found.set(owner!, entry);
  }
  return [...found].flatMap(([owner, entry]) => entry.port === undefined ? [] : [{
    name: unescapeDnsText(stripServiceSuffix(owner, type)),
    ...(entry.hostName ? { hostName: entry.hostName } : {}),
    port: entry.port,
    txt: entry.txt ?? {},
    addresses: [],
  }]);
}

/** `avahi-browse -prt`: `=;iface;proto;name;type;domain;host;address;port;"txt"…`, one line per interface and family. */
export function parseAvahiBrowse(output: string): ResolvedService[] {
  const services: ResolvedService[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith("=;")) continue;
    const fields = line.split(";");
    if (fields.length < 10) continue;
    const [, , , name, , , host, address, port] = fields;
    const txt = fields.slice(9).join(";");
    services.push({
      name: unescapeDnsText(name!),
      ...(host ? { hostName: unescapeDnsText(host).replace(/\.$/u, "") } : {}),
      port: Number(port),
      txt: txtEntries(quotedStrings(txt)),
      addresses: address ? [address] : [],
    });
  }
  return services;
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/** The Windows script's JSON lines: one resolved instance each. */
export function parseWindowsBrowse(output: string, type: string): ResolvedService[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const entry = parseJsonLine(line) as { name?: unknown; hostName?: unknown; port?: unknown; txt?: unknown; addresses?: unknown } | undefined;
    if (!entry || typeof entry.name !== "string" || typeof entry.port !== "number") return [];
    const txt = entry.txt && typeof entry.txt === "object" ? Object.fromEntries(Object.entries(entry.txt).filter((pair): pair is [string, string] => typeof pair[1] === "string").map(([key, value]) => [key.toLowerCase(), value])) : {};
    return [{
      name: stripServiceSuffix(entry.name, type),
      ...(typeof entry.hostName === "string" && entry.hostName ? { hostName: entry.hostName.replace(/\.$/u, "") } : {}),
      port: entry.port,
      txt,
      addresses: Array.isArray(entry.addresses) ? entry.addresses.filter((address): address is string => typeof address === "string") : [],
    }];
  });
}

/** Splits a stream into lines for `onLine`, keeping the last few for an error message. */
function readLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      onLine(buffer.slice(0, newline).replace(/\r$/u, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    // A tool that never ends a line cannot grow the buffer without bound.
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-1024);
  });
  stream.on("end", () => { if (buffer) onLine(buffer); buffer = ""; });
}

/** Stops a discovery process: stdin first (the wrapper ends the tool), then signals. */
function stopProcess(child: DiscoveryProcess, exited: Promise<void>, graceMs: number): Promise<void> {
  try { child.stdin?.end(); } catch { /* already closed */ }
  const term = setTimeout(() => { child.kill("SIGTERM"); }, graceMs);
  const kill = setTimeout(() => { child.kill("SIGKILL"); }, graceMs * 2);
  term.unref?.();
  kill.unref?.();
  return exited.finally(() => { clearTimeout(term); clearTimeout(kill); });
}

/**
 * What the machine is called to people: the Mac's Computer Name ("Mac mini
 * von Alex"), elsewhere the host name without a DHCP domain ("studio").
 */
export function machineDisplayName(platform: NodeJS.Platform = process.platform, run: (command: string, args: string[]) => string = runQuietly, host: string = hostname()): string {
  const computerName = platform === "darwin" ? run("scutil", ["--get", "ComputerName"]).trim() : "";
  return computerName || host.split(".")[0] || host;
}

function runQuietly(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** A Bonjour instance name: printable, at most 63 bytes (RFC 6763 §4.1.1). */
export function instanceName(name: string): string {
  let clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\.local\.?$/iu, "").trim() || "Tau";
  while (new TextEncoder().encode(clean).length > 63) clean = [...clean].slice(0, -1).join("");
  return clean;
}

interface Running {
  key: string;
  service: ServiceAnnouncement;
  child?: DiscoveryProcess;
  exited: Promise<void>;
  stopping: boolean;
  state: UiNetworkAnnouncement;
}

export interface ServiceAnnouncerOptions extends DiscoveryEnvironment {
  logger?: HostLogger;
  /** Its state changed: up, renamed, failed, withdrawn. */
  onChange?(): void;
  /** How long a tool may take to end after its stdin closes before it is signalled. */
  stopGraceMs?: number;
}

/**
 * Keeps at most one announcement up. `set` with the same service leaves a
 * running one alone and restarts a failed one, so a periodic `set` retries.
 */
export class ServiceAnnouncer {
  private current: Running | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ServiceAnnouncerOptions = {}) {}

  /** Resolves once the change is under way: the old announcement withdrawn, the new one started. */
  set(service: ServiceAnnouncement | undefined): Promise<void> {
    const next = this.queue.then(() => this.apply(service));
    this.queue = next.catch(() => undefined);
    return next;
  }

  state(): UiNetworkAnnouncement | undefined {
    return this.current?.state;
  }

  close(): Promise<void> {
    return this.set(undefined);
  }

  private async apply(service: ServiceAnnouncement | undefined): Promise<void> {
    const key = service ? JSON.stringify(service) : undefined;
    const current = this.current;
    if (current && current.key === key && (current.state.state === "starting" || current.state.state === "announced")) return;
    if (current) {
      current.stopping = true;
      if (current.child) await stopProcess(current.child, current.exited, this.options.stopGraceMs ?? 2_000);
      this.current = undefined;
      if (current.state.state === "announced" || current.state.state === "starting") {
        this.options.logger?.info("host-discovery.withdrawn", { type: current.service.type, name: current.state.name });
      }
      if (!service) this.options.onChange?.();
    }
    if (!service || !key) return;
    if (!isServiceType(service.type)) throw new Error(`Not a service type: ${service.type}`);
    const invocation = announceInvocation(service, this.options);
    if ("unavailable" in invocation) {
      this.current = { key, service, exited: Promise.resolve(), stopping: false, state: { state: "unavailable", name: service.name, serviceType: service.type, detail: invocation.unavailable } };
      this.options.onChange?.();
      return;
    }
    const running: Running = { key, service, exited: Promise.resolve(), stopping: false, state: { state: "starting", name: service.name, serviceType: service.type } };
    this.current = running;
    const lastLines: string[] = [];
    const onLine = (line: string): void => {
      if (line.trim()) lastLines.push(line.trim());
      if (lastLines.length > 5) lastLines.shift();
      const name = invocation.ready(line);
      if (name === undefined || running.stopping) return;
      running.state = { state: "announced", name, serviceType: service.type };
      this.options.logger?.info("host-discovery.announced", { type: service.type, name, port: service.port });
      this.options.onChange?.();
    };
    const fail = (detail: string): void => {
      if (running.stopping || this.current !== running) return;
      running.state = { state: "failed", name: running.state.name, serviceType: service.type, detail };
      this.options.logger?.warn("host-discovery.failed", { type: service.type, detail });
      this.options.onChange?.();
    };
    let child: DiscoveryProcess;
    try {
      child = (this.options.spawn ?? defaultSpawn)(invocation.command, invocation.args);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    running.child = child;
    running.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        const said = [...lastLines].reverse().find((line) => !/^\d{1,2}:\d{2}:\d{2}\.\d+\s+\.\.\.STARTING\.\.\.$/u.test(line));
        fail(said ? `The announcement stopped: ${said}` : `The announcement stopped (${signal ?? `exit code ${code}`}).`);
        resolve();
      });
      child.once("error", (error) => { fail(error.message); resolve(); });
    });
    readLines(child.stdout, onLine);
    readLines(child.stderr, onLine);
    this.options.onChange?.();
  }
}

export interface BrowseOptions extends DiscoveryEnvironment {
  /** How long to listen for answers; a responder answers within a second. */
  timeoutMs?: number;
  /** Addresses for a `.local` name where the tool reports only the name. */
  lookup?: (hostName: string) => Promise<string[]>;
  logger?: HostLogger;
}

const DEFAULT_BROWSE_MS = 3_000;
const LOOKUP_MS = 1_500;
const MAX_OUTPUT = 1024 * 1024;

async function lookupAddresses(hostName: string): Promise<string[]> {
  const answers = await dnsLookup(hostName, { all: true });
  return answers.map((answer) => answer.address);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, onFailure: (reason: unknown) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => { onFailure(new Error(`no answer within ${ms} ms`)); resolve(fallback); }, ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); onFailure(error); resolve(fallback); });
  });
}

/** Listens for `type` for a while and answers what resolved; `problem` when the system could not look. */
export async function browseServices(type: string, options: BrowseOptions = {}): Promise<{ services: ResolvedService[]; problem?: string }> {
  if (!isServiceType(type)) throw new Error(`Not a service type: ${type}`);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_BROWSE_MS, 500), 10_000);
  const invocation = browseInvocation(type, timeoutMs, options);
  if ("unavailable" in invocation) return { services: [], problem: invocation.unavailable };
  const child = (options.spawn ?? defaultSpawn)(invocation.command, invocation.args);
  let output = "";
  const errors: string[] = [];
  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on("data", (chunk: string) => { if (output.length < MAX_OUTPUT) output += chunk; });
  readLines(child.stderr, (line) => { if (line.trim()) errors.push(line.trim()); });
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => { exitCode = code; resolve(); });
    child.once("error", (error) => { errors.push(error.message); resolve(); });
  });
  // A tool that ends by itself gets extra time (Windows compiles its helper first); one that does not is stopped.
  const limit = invocation.stops ? timeoutMs + ((options.platform ?? process.platform) === "win32" ? 15_000 : 5_000) : timeoutMs;
  let timedOut = false;
  await Promise.race([exited, new Promise<void>((resolve) => { const timer = setTimeout(() => { timedOut = true; resolve(); }, limit); timer.unref?.(); })]);
  if (timedOut) await stopProcess(child, exited, 1_000);
  const parsed = invocation.parse(output);
  const lookup = options.lookup ?? lookupAddresses;
  const services = await Promise.all(parsed.map(async (service) => service.addresses.length || !service.hostName
    ? service
    : { ...service, addresses: await withTimeout(lookup(service.hostName), LOOKUP_MS, [], (error) => options.logger?.warn("host-discovery.lookup-failed", { hostName: service.hostName, error: error instanceof Error ? `${(error as { code?: string }).code ?? ""} ${error.message}`.trim() : String(error) })) }));
  const failed = !timedOut && exitCode !== 0 && services.length === 0;
  return { services, ...(failed ? { problem: errors.at(-1) ?? `Looking for machines failed (exit code ${exitCode}).` } : {}) };
}

/** Tau hosts on this network, this machine's own marked. */
export async function discoverHosts(type: string, options: BrowseOptions & { ownHostId?: string } = {}): Promise<{ hosts: DiscoveredHost[]; problem?: string }> {
  const { services, problem } = await browseServices(type, options);
  return { hosts: discoveredHosts(services, options.ownHostId), ...(problem ? { problem } : {}) };
}
