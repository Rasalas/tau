import { execFile } from "node:child_process";
import { readFile, readdir, statfs } from "node:fs/promises";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import type { UiRuntimeBackend, UiRuntimeCatalog } from "../shared/contracts.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { SIGN_IN_COMMANDS, type SignInReport } from "../shared/sign-in.js";
import type { HostMethodContext } from "./host-jobs.js";
import {
  gitHasMergeTree,
  parseGitVersion,
  type HostDisplayKind,
  type HostReadiness,
  type HostResources,
  type RuntimeReadiness,
} from "../shared/host-resources.js";

/** The part of `node:os` a reading needs; tests hand in their own. */
export interface ResourceOs {
  platform(): NodeJS.Platform;
  cpus(): ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  totalmem(): number;
  freemem(): number;
}

export interface HostResourceSamplerOptions {
  os?: ResourceOs;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** What the platform reports better than `os.freemem()`; undefined keeps that. */
  availableMemory?(platform: NodeJS.Platform): Promise<number | undefined>;
  battery?(platform: NodeJS.Platform): Promise<boolean | undefined>;
  /** How long a fresh CPU reading watches the counters. */
  windowMs?: number;
  /** A reading at most this old is the start of the next one, which then answers at once. */
  baselineMaxAgeMs?: number;
}

/**
 * A test host that plays a smaller machine: `TAU_TEST_CPU_COUNT` keeps only
 * that many of the CPUs `os.cpus()` lists. Undefined without the variable.
 */
export function testResourceOs(env: NodeJS.ProcessEnv = process.env, os: ResourceOs = nodeOs): ResourceOs | undefined {
  const count = Number(env.TAU_TEST_CPU_COUNT);
  if (!Number.isInteger(count) || count < 1) return undefined;
  return { platform: () => os.platform(), cpus: () => os.cpus().slice(0, count), totalmem: () => os.totalmem(), freemem: () => os.freemem() };
}

/** The ticket's 5 s: long enough that one busy burst does not decide. */
const WINDOW_MS = 5_000;
const BASELINE_MAX_AGE_MS = 30_000;

interface CpuTimes { idle: number; total: number; count: number }
interface Reading { times: CpuTimes; at: number; result: HostResources }

function cpuTimes(os: ResourceOs): CpuTimes {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, count: cpus.length };
}

function utilization(before: CpuTimes, after: CpuTimes): number | undefined {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (before.count !== after.count || total <= 0 || idle < 0) return undefined;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

/**
 * The machine's load, read only when someone asks (plan H: no polling). CPU
 * use needs two readings: the previous answer is the first one when it is
 * recent enough, otherwise the host watches for `windowMs`. Answers within
 * `windowMs` of each other are the same answer.
 */
export class HostResourceSampler {
  private readonly os: ResourceOs;
  private readonly running = new Set<string>();
  private last: Reading | undefined;
  private pending: Promise<HostResources> | undefined;

  constructor(private readonly options: HostResourceSamplerOptions = {}) {
    this.os = options.os ?? nodeOs;
  }

  /** Follows `agent-status`, which every runtime's threads send. */
  observe(event: { type: string; sessionId?: string; running?: boolean }): void {
    if (event.type !== "agent-status" || !event.sessionId) return;
    if (event.running) this.running.add(event.sessionId);
    else this.running.delete(event.sessionId);
  }

  sample(): Promise<HostResources> {
    const now = this.now();
    const windowMs = this.options.windowMs ?? WINDOW_MS;
    if (this.last && now - this.last.at < windowMs) return Promise.resolve(this.last.result);
    this.pending ??= this.read(now, windowMs).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async read(now: number, windowMs: number): Promise<HostResources> {
    const recent = this.last && now - this.last.at <= (this.options.baselineMaxAgeMs ?? BASELINE_MAX_AGE_MS) ? this.last.times : undefined;
    let before = recent;
    if (!before) {
      before = cpuTimes(this.os);
      await (this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(windowMs);
    }
    const after = cpuTimes(this.os);
    const totalMemory = this.os.totalmem();
    const [available, battery] = await Promise.all([
      (this.options.availableMemory ?? platformAvailableMemory)(this.os.platform()).catch(() => undefined),
      (this.options.battery ?? platformBattery)(this.os.platform()).catch(() => undefined),
    ]);
    const cpu = utilization(before, after);
    const result: HostResources = {
      sampledAt: this.now(),
      cpuCount: after.count,
      ...(cpu !== undefined ? { cpuUtilization: cpu } : {}),
      totalMemory,
      availableMemory: Math.min(totalMemory, Math.max(0, available ?? this.os.freemem())),
      runningTurns: this.running.size,
      ...(battery !== undefined ? { onBattery: battery } : {}),
    };
    this.last = { times: after, at: result.sampledAt, result };
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function run(command: string, args: readonly string[], timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** `vm_stat`: free + inactive + speculative pages, which macOS hands out without swapping. */
export function parseVmStat(output: string): number | undefined {
  const page = Number(/page size of (\d+) bytes/u.exec(output)?.[1]);
  const pages = ["free", "inactive", "speculative"].map((name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "mu").exec(output)?.[1]));
  if (!page || pages.some((count) => !Number.isFinite(count))) return undefined;
  return pages.reduce((sum, count) => sum + count, 0) * page;
}

export function parseMemAvailable(meminfo: string): number | undefined {
  const kb = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo)?.[1];
  return kb ? Number(kb) * 1024 : undefined;
}

async function platformAvailableMemory(platform: NodeJS.Platform): Promise<number | undefined> {
  if (platform === "linux") return parseMemAvailable(await readFile("/proc/meminfo", "utf8"));
  if (platform === "darwin") return parseVmStat(await run("/usr/bin/vm_stat", [], 1_000));
  // Windows: libuv already answers the available physical memory.
  return undefined;
}

/** `pmset -g batt`: a Mac without a battery lists none and draws from AC. */
export function parsePmset(output: string): boolean | undefined {
  if (!/InternalBattery/u.test(output)) return undefined;
  return output.includes("'Battery Power'");
}

/** `/sys/class/power_supply`: on battery when there is one and no mains supply is online. */
export async function linuxOnBattery(root = "/sys/class/power_supply"): Promise<boolean | undefined> {
  const supplies = await readdir(root).catch(() => [] as string[]);
  let battery = false;
  for (const supply of supplies) {
    const type = (await readFile(join(root, supply, "type"), "utf8").catch(() => "")).trim();
    if (type === "Battery") battery = true;
    else if (type === "Mains" && (await readFile(join(root, supply, "online"), "utf8").catch(() => "")).trim() === "1") return false;
  }
  return battery ? true : undefined;
}

async function platformBattery(platform: NodeJS.Platform): Promise<boolean | undefined> {
  if (platform === "darwin") return parsePmset(await run("/usr/bin/pmset", ["-g", "batt"], 1_000));
  if (platform === "linux") return linuxOnBattery();
  return undefined;
}

/** The host's runtimes as it lists them for a new thread, with what each said last. */
export interface ReadinessRuntimes {
  runtimeBackends(): UiRuntimeBackend[];
  /** Every catalog on hand; `revalidate` asks the stale ones again behind the answer. */
  runtimeCatalogs(revalidate?: boolean): Promise<UiRuntimeCatalog[]>;
  /** One catalog, asked and awaited when none is on hand. */
  runtimeCatalog(kind: string): Promise<UiRuntimeCatalog | undefined>;
  /** The extension that registered a backend; its `sign-in-state` says whether the program is signed in. */
  runtimeBackendOwner?(kind: string): string | undefined;
  invokeHostExtension?(extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

export interface ReadinessOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?(): number;
  /** `git --version`'s output; rejects when there is no git. */
  gitVersion?(): Promise<string>;
  statfs?(path: string): Promise<{ bavail: number; bsize: number; blocks: number }>;
  /** The name of the process serving an X display (`Xvfb`, `Xorg`), when this machine can tell. */
  xServer?(display: string): Promise<string | undefined>;
  /** How long a runtime that has never answered, or its kit's `sign-in-state`, is waited for. */
  catalogWaitMs?: number;
}

const CATALOG_WAIT_MS = 5_000;

/**
 * One runtime's readiness from its catalog and its kit's sign-in report. Pi
 * with no model has no provider signed in; a kit that says its program is
 * signed out overrules a catalog that could not tell (one that names its
 * models only once a thread runs).
 */
export function runtimeReadiness(backend: UiRuntimeBackend, catalog: UiRuntimeCatalog | undefined, signIn?: SignInReport): RuntimeReadiness {
  const account = signIn?.account;
  const label = account?.signedIn ? [account.label, account.detail].filter(Boolean).join(" · ") : "";
  const base = { kind: backend.kind, label: backend.label, ...(backend.version?.installed ? { version: backend.version.installed } : {}), ...(label ? { account: label } : {}) };
  const signedOut = account?.signedIn === false ? { state: "sign-in-required" as const, note: account.detail ?? `${backend.label} is not signed in.` } : undefined;
  if (!catalog) return { ...base, ...(signedOut ?? { state: "checking" }) };
  const note = catalog.note ? { note: catalog.note } : {};
  if (catalog.status) return { ...base, state: catalog.status, ...note };
  if (backend.kind === "pi" && catalog.models.length === 0) return { ...base, state: "sign-in-required", note: "No model provider is signed in or has a key." };
  if (signedOut) return { ...base, ...signedOut };
  return { ...base, state: "ready", ...(catalog.models.length > 0 ? { models: catalog.models.length } : {}), ...note };
}

/** `promise`'s value, or undefined once `ms` passed or it failed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, ms, undefined); });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

async function signInReport(source: ReadinessRuntimes, kind: string, waitMs: number): Promise<SignInReport | undefined> {
  const owner = kind === "pi" ? undefined : source.runtimeBackendOwner?.(kind);
  if (!owner || !source.invokeHostExtension) return undefined;
  const at = kind.indexOf("@");
  // A kit without sign-in refuses the command; its catalog alone then speaks.
  return within(source.invokeHostExtension(owner, SIGN_IN_COMMANDS.state, at < 0 ? undefined : { target: kind.slice(at + 1) }) as Promise<SignInReport>, waitMs);
}

async function runtimesReadiness(source: ReadinessRuntimes, waitMs: number): Promise<RuntimeReadiness[]> {
  const held = new Map((await source.runtimeCatalogs(true)).map((catalog) => [catalog.kind, catalog]));
  return Promise.all(source.runtimeBackends().map(async (backend) => {
    const [catalog, signIn] = await Promise.all([
      held.get(backend.kind) ?? within(source.runtimeCatalog(backend.kind), waitMs),
      signInReport(source, backend.kind, waitMs),
    ]);
    return runtimeReadiness(backend, catalog, signIn);
  }));
}

/** Where new worktrees go on this machine: the configured folder, else Tau's own under the home folder. */
export function worktreesFolder(env: NodeJS.ProcessEnv, home: string): string {
  return env.TAU_WORKTREES_DIR?.trim() || join(home, ".tau");
}

async function diskReadiness(path: string, stat: NonNullable<ReadinessOptions["statfs"]>): Promise<HostReadiness["disk"]> {
  // A folder not made yet sits on its nearest existing parent's disk.
  for (let at = path; ; at = dirname(at)) {
    try {
      const found = await stat(at);
      return { path, free: found.bavail * found.bsize, total: found.blocks * found.bsize };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) {
        return { path, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
}

/** The X server's pid from its lock file, and that process's name. */
async function linuxXServer(display: string): Promise<string | undefined> {
  const number = /^[^:]*:(\d+)/u.exec(display)?.[1];
  if (!number) return undefined;
  const pid = (await readFile(`/tmp/.X${number}-lock`, "utf8")).trim();
  if (!/^\d+$/u.test(pid)) return undefined;
  return (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
}

/** What a GUI program the agents start would draw on (plan H §6, H11's invisible display). */
export async function displayReadiness(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  xServer: (display: string) => Promise<string | undefined> = linuxXServer,
): Promise<HostReadiness["display"]> {
  if (platform === "darwin" || platform === "win32") return { kind: "screen" };
  const wayland = env.WAYLAND_DISPLAY?.trim();
  const x11 = env.DISPLAY?.trim();
  if (x11) {
    const server = await xServer(x11).catch(() => undefined);
    const kind: HostDisplayKind = server && /^xvfb$/iu.test(server) ? "invisible" : wayland ? "wayland" : "x11";
    return { kind, name: kind === "wayland" ? wayland! : x11 };
  }
  return wayland ? { kind: "wayland", name: wayland } : { kind: "none" };
}

/** Whether this machine could take on a thread: runtimes, git, disk and display (plan H §4). */
export async function checkReadiness(runtimes: ReadinessRuntimes, options: ReadinessOptions = {}): Promise<HostReadiness> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const [list, gitOutput, disk, display] = await Promise.all([
    runtimesReadiness(runtimes, options.catalogWaitMs ?? CATALOG_WAIT_MS),
    (options.gitVersion ?? (() => run("git", ["--version"], 5_000)))().catch(() => ""),
    diskReadiness(worktreesFolder(env, nodeOs.homedir()), options.statfs ?? ((path) => statfs(path))),
    displayReadiness(platform, env, options.xServer),
  ]);
  const version = parseGitVersion(gitOutput);
  return {
    checkedAt: options.now?.() ?? Date.now(),
    runtimes: list,
    git: { ...(version ? { version } : {}), mergeTree: gitHasMergeTree(version) },
    disk,
    display,
  };
}

type Method = (params: readonly unknown[], context?: HostMethodContext) => Promise<unknown>;

/**
 * `host-resources` and `readiness`. Both only read, and another machine's host
 * may ask them (`MACHINE_REQUEST_METHODS`). A host without a sampler (the one in
 * the window's process) answers `unsupported` for the first.
 */
export function createResourceMethods(deps: {
  resources?(): HostResourceSampler | undefined;
  runtimes(): Promise<ReadinessRuntimes>;
  readiness?: ReadinessOptions;
}): Record<string, Method> {
  return {
    "host-resources": async () => {
      const sampler = deps.resources?.();
      if (!sampler) throw Object.assign(new Error("This host does not report its machine's load; a host in the window's process does not."), { code: HOST_ERROR.unsupported });
      return sampler.sample();
    },
    "readiness": async (_params, context) => {
      const readiness = await checkReadiness(await deps.runtimes(), deps.readiness);
      const principal = context?.principal;
      // A Read-only device may not call `sign-in-state`, so it does not learn the accounts here either.
      if (principal?.kind !== "workbench-client" || !principal.readOnly) return readiness;
      return { ...readiness, runtimes: readiness.runtimes.map(({ account: _account, ...runtime }) => runtime) };
    },
  };
}
