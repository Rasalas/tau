import { execFile } from "node:child_process";
import type { ThreadBackendKind, UiRuntimeTool, UiRuntimeToolLogEntry, UiRuntimeToolsState } from "../shared/contracts.js";
import { compareVersions } from "../shared/runtime-version.js";
import { cliCommandText, type CliCommand, type RuntimeToolMaintenance } from "./cli-install.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";
import { commandInvocation } from "./platform-process.js";

const FILE_VERSION = 1;
const LOG_LIMIT = 40;
const OUTPUT_LIMIT = 4_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const START_DELAY_MS = 90_000;
const ASK_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeToolRun {
  exitCode: number;
  output: string;
}

export interface RuntimeToolUpdatesOptions {
  backends(): Iterable<HostRuntimeBackendProvider>;
  /** Kinds with a turn running now. */
  busy(): ReadonlySet<ThreadBackendKind>;
  /** Asks a kind's version and catalog again after its program changed. */
  recheck(kind: ThreadBackendKind): Promise<void>;
  /** What clients hear of the backends changed (`RuntimeToolVersion.updates`). */
  changed(): void;
  /** The Refresh button: every runtime's version and catalog asked again. */
  refresh?(): Promise<void>;
  /** Whether `start` checks on a schedule; a test host only answers clients. */
  automatic?: boolean;
  /** Settings and log; memory only without one. */
  file?: string;
  env?: NodeJS.ProcessEnv;
  safeMode?: boolean;
  log(label: string, detail?: string): void;
  run?(command: CliCommand, env: NodeJS.ProcessEnv): Promise<RuntimeToolRun>;
  now?(): number;
  checkEveryMs?: number;
  startDelayMs?: number;
}

/** One program on disk and the runtimes that drive it. */
interface Tool {
  key: string;
  kinds: ThreadBackendKind[];
  label: string;
  maintenance: RuntimeToolMaintenance;
}

type Job = { key: string; action: "update" | "switch" };

interface Saved {
  automatic?: boolean;
  log: UiRuntimeToolLogEntry[];
}

function decodeSaved(value: unknown): Saved | undefined {
  const item = value as { automatic?: unknown; log?: unknown } | undefined;
  if (!item || typeof item !== "object") return undefined;
  const log = Array.isArray(item.log) ? item.log.filter((entry): entry is UiRuntimeToolLogEntry => {
    const candidate = entry as Partial<UiRuntimeToolLogEntry> | undefined;
    return typeof candidate?.at === "number" && typeof candidate.label === "string" && typeof candidate.outcome === "string";
  }) : [];
  return { ...(typeof item.automatic === "boolean" ? { automatic: item.automatic } : {}), log: log.slice(0, LOG_LIMIT) };
}

const tail = (text: string) => text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text;

/** Runs a command without a shell; a failure to start is exit code -1 with the reason as output. */
export function runToolCommand(command: CliCommand, env: NodeJS.ProcessEnv, timeoutMs = RUN_TIMEOUT_MS): Promise<RuntimeToolRun> {
  const invocation = commandInvocation(command.executable, command.args, { env });
  return new Promise((resolve) => {
    execFile(invocation.command, invocation.args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }, (error, stdout, stderr) => {
      const output = tail(`${String(stdout)}${String(stderr)}`.trim());
      if (!error) return resolve({ exitCode: 0, output });
      const code = (error as { code?: unknown }).code;
      resolve({ exitCode: typeof code === "number" ? code : -1, output: output || error.message });
    });
  });
}

/**
 * Keeps the agent CLIs current on this machine (K124). Each runtime backend
 * says through `maintenance` how its program is installed and what updates it;
 * with "Keep agent tools up to date" on, this runs that command when a newer
 * release is out and no turn of a runtime that drives the program runs, then
 * has the host ask the version and the catalog again. It also moves a
 * Homebrew install to npm when the user asks, never on its own. Every command
 * is an argument list a kit built from package names it declared.
 */
export class RuntimeToolUpdates {
  private saved: Saved = { log: [] };
  private loaded?: Promise<void>;
  private tools = new Map<string, Tool>();
  private readonly queue: Job[] = [];
  private active?: Job;
  private readonly waiting = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private writing: Promise<void> = Promise.resolve();
  private collecting?: Promise<void>;

  constructor(private readonly options: RuntimeToolUpdatesOptions) {}

  /** Why nothing runs here, or undefined. */
  blocked(): string | undefined {
    const env = this.options.env ?? process.env;
    if (this.options.safeMode) return "Safe mode runs no updates.";
    if (env.TAU_NO_RUNTIME_UPDATES === "1") return "Updates are off in this Tau (TAU_NO_RUNTIME_UPDATES).";
    if (env.TAU_RUNTIME_UPDATE_COMMAND?.trim()) return "This Tau runs no updates (TAU_RUNTIME_UPDATE_COMMAND is set).";
    return undefined;
  }

  /** Reads the settings and checks now and then, the first time once start-up is over. */
  start(): void {
    void this.load();
    if (this.timer || this.disposed || this.options.automatic === false) return;
    this.schedule(this.options.startDelayMs ?? START_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** What a backend's version says to clients: whether Tau keeps its program current. */
  updatesFor(kind: ThreadBackendKind): "automatic" | "ask" | undefined {
    if (this.blocked()) return undefined;
    const tool = [...this.tools.values()].find((entry) => entry.kinds.includes(kind));
    if (!tool?.maintenance.update) return undefined;
    if (this.saved.automatic === true) return "automatic";
    return this.saved.automatic === undefined ? "ask" : undefined;
  }

  /**
   * A client's call: `state` and `refresh` read, `automatic` (`{ on }`),
   * `update` and `switch` (`{ kind }`) change; the host method gates each kind.
   */
  async act(action: string, input: { on?: unknown; kind?: unknown } = {}): Promise<UiRuntimeToolsState> {
    const kind = typeof input.kind === "string" && input.kind ? input.kind : undefined;
    switch (action) {
      case "state": return this.state();
      case "refresh":
        await this.options.refresh?.();
        return this.state();
      case "automatic":
        if (typeof input.on !== "boolean") throw new Error("runtime-tools automatic: on must be true or false.");
        return this.setAutomatic(input.on);
      case "update":
      case "switch":
        if (!kind) throw new Error(`runtime-tools ${action}: name the runtime.`);
        return action === "update" ? this.update(kind) : this.switchSource(kind);
      default:
        throw new Error(`runtime-tools: unknown action ${action}.`);
    }
  }

  async state(): Promise<UiRuntimeToolsState> {
    await this.load();
    await this.collect();
    return this.view();
  }

  async setAutomatic(automatic: boolean): Promise<UiRuntimeToolsState> {
    await this.load();
    this.saved.automatic = automatic;
    this.persist();
    this.options.changed();
    if (automatic) void this.check().catch(() => undefined);
    return this.state();
  }

  /** The Update button: now, or once the runtime's turns are over. */
  async update(kind: ThreadBackendKind): Promise<UiRuntimeToolsState> {
    return this.request(kind, "update");
  }

  /** The switch the user asked for, from a lagging source to the one ahead. */
  async switchSource(kind: ThreadBackendKind): Promise<UiRuntimeToolsState> {
    return this.request(kind, "switch");
  }

  /** A turn ended; an update that waited for it may run now. */
  turnEnded(): void {
    if (this.waiting.size === 0) return;
    const jobs = [...this.waiting.values()];
    this.waiting.clear();
    for (const job of jobs) this.enqueue(job);
  }

  /** Every backend's program now, grouped by the file it runs. */
  private async collect(): Promise<void> {
    const found = new Map<string, Tool>();
    for (const provider of this.options.backends()) {
      if (!provider.maintenance) continue;
      const maintenance = await bounded(provider.maintenance(), ASK_TIMEOUT_MS).catch((error: unknown) => {
        this.options.log("runtime-tools.maintenance.failed", `${provider.kind}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (!maintenance) continue;
      const key = maintenance.install.realPath || maintenance.install.path;
      const held = found.get(key);
      if (held) held.kinds.push(provider.kind);
      else found.set(key, { key, kinds: [provider.kind], label: provider.label ?? provider.kind, maintenance });
    }
    const before = JSON.stringify([...this.tools.values()].map((tool) => [tool.kinds, Boolean(tool.maintenance.update)]));
    this.tools = found;
    if (before !== JSON.stringify([...found.values()].map((tool) => [tool.kinds, Boolean(tool.maintenance.update)]))) this.options.changed();
  }

  /**
   * Knows `kind`'s program before its version reaches clients, so the first
   * version they hear already says whether Tau updates it (`updatesFor`).
   */
  async ensure(kind: ThreadBackendKind): Promise<void> {
    await this.load();
    if ([...this.tools.values()].some((tool) => tool.kinds.includes(kind))) return;
    await (this.collecting ??= this.collect().finally(() => { this.collecting = undefined; }));
  }

  private async check(): Promise<void> {
    await this.load();
    if (this.blocked() || this.disposed) return;
    await this.collect();
    if (this.saved.automatic !== true) return;
    for (const tool of this.tools.values()) {
      const { installed, latest, update } = tool.maintenance;
      if (update && installed && latest && compareVersions(installed, latest) < 0) this.enqueue({ key: tool.key, action: "update" });
    }
  }

  private async request(kind: ThreadBackendKind, action: Job["action"]): Promise<UiRuntimeToolsState> {
    await this.load();
    const reason = this.blocked();
    if (reason) throw new Error(reason);
    await this.collect();
    const tool = [...this.tools.values()].find((entry) => entry.kinds.includes(kind));
    if (!tool) throw new Error(`Tau does not know how ${kind}'s program is installed.`);
    if (action === "update" && !tool.maintenance.update) throw new Error(tool.maintenance.install.note ?? `Tau cannot update ${tool.label} itself.`);
    if (action === "switch" && !tool.maintenance.switch) throw new Error(`${tool.label} has no newer source to switch to.`);
    this.enqueue({ key: tool.key, action });
    return this.view();
  }

  private enqueue(job: Job): void {
    if (this.active?.key === job.key || this.queue.some((queued) => queued.key === job.key && queued.action === job.action)) return;
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    while (!this.disposed) {
      const job = this.queue.shift();
      if (!job) return;
      const tool = this.tools.get(job.key);
      if (!tool) continue;
      if (this.busy(tool)) {
        if (!this.waiting.has(job.key)) this.record({ label: tool.label, action: job.action, outcome: "waiting", message: "Waits until no turn of it runs." });
        this.waiting.set(job.key, job);
        continue;
      }
      this.active = job;
      try {
        if (job.action === "switch") await this.switchTool(tool);
        else await this.updateTool(tool);
      } catch (error) {
        this.record({ label: tool.label, action: job.action, outcome: "failed", message: error instanceof Error ? error.message : String(error) });
      } finally {
        this.active = undefined;
      }
    }
  }

  private busy(tool: Tool): boolean {
    const running = this.options.busy();
    return tool.kinds.some((kind) => running.has(kind));
  }

  private async updateTool(tool: Tool): Promise<void> {
    const { update, installed, latest } = tool.maintenance;
    if (!update) return;
    const command = cliCommandText(update);
    this.options.log("runtime-tools.update", `${tool.label}: ${command}`);
    const ran = await this.execute(update, tool);
    if (ran.exitCode !== 0) {
      this.record({ label: tool.label, action: "update", command, ...(installed ? { from: installed } : {}), outcome: "failed", message: `Exited with ${ran.exitCode}; ${installed ?? "the installed version"} stays.`, output: ran.output });
      return;
    }
    const now = await this.settle(tool);
    const changed = now?.installed && installed && compareVersions(now.installed, installed) > 0;
    this.record({
      label: tool.label,
      action: "update",
      command,
      ...(installed ? { from: installed } : {}),
      ...(now?.installed ? { to: now.installed } : {}),
      outcome: changed || !installed ? "ok" : "unchanged",
      ...(!changed && installed ? { message: `${tool.label} still reports ${now?.installed ?? installed}${latest ? `; ${latest} is out` : ""}.` } : {}),
      ...(ran.output ? { output: ran.output } : {}),
    });
  }

  private async switchTool(tool: Tool): Promise<void> {
    const plan = tool.maintenance.switch;
    if (!plan) return;
    const from = tool.maintenance.installed;
    for (const [index, step] of plan.steps.entries()) {
      const command = cliCommandText(step);
      this.options.log("runtime-tools.switch", `${tool.label}: ${command}`);
      const ran = await this.execute(step, tool);
      if (ran.exitCode === 0) {
        this.record({ label: tool.label, action: "switch", command, outcome: "ok", ...(ran.output ? { output: ran.output } : {}) });
        continue;
      }
      this.record({ label: tool.label, action: "switch", command, outcome: "failed", message: `Exited with ${ran.exitCode}.`, output: ran.output });
      // Nothing changed before the first step; after it, the old install comes back.
      if (index > 0) for (const restore of plan.restore) {
        const back = await this.execute(restore, tool);
        this.record({ label: tool.label, action: "restore", command: cliCommandText(restore), outcome: back.exitCode === 0 ? "ok" : "failed", ...(back.exitCode === 0 ? {} : { message: `Exited with ${back.exitCode}; run it yourself to get ${tool.label} back.` }), ...(back.output ? { output: back.output } : {}) });
      }
      await this.settle(tool);
      return;
    }
    const now = await this.settle(tool);
    this.record({ label: tool.label, action: "switch", outcome: "ok", ...(from ? { from } : {}), ...(now?.installed ? { to: now.installed } : {}), message: `${tool.label} now comes from ${now?.install.label ?? "npm"}.` });
  }

  private execute(command: CliCommand, tool: Tool): Promise<RuntimeToolRun> {
    const env = {
      ...(this.options.env ?? process.env),
      ...tool.maintenance.env,
      NONINTERACTIVE: "1",
      npm_config_yes: "true",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    };
    return (this.options.run ?? runToolCommand)(command, env);
  }

  /** The host asks the program's runtimes again; answers what it reports now. */
  private async settle(tool: Tool): Promise<RuntimeToolMaintenance | undefined> {
    await Promise.all(tool.kinds.map((kind) => this.options.recheck(kind).catch(() => undefined)));
    await this.collect();
    return [...this.tools.values()].find((entry) => entry.kinds.some((kind) => tool.kinds.includes(kind)))?.maintenance;
  }

  private view(): UiRuntimeToolsState {
    const blocked = this.blocked();
    const tools = [...this.tools.values()].map((tool): UiRuntimeTool => {
      const { maintenance } = tool;
      const state = this.active?.key === tool.key
        ? this.active.action === "switch" ? "switching" : "updating"
        : this.waiting.has(tool.key) || this.queue.some((job) => job.key === tool.key) ? "waiting" : undefined;
      return {
        kinds: [...tool.kinds],
        label: tool.label,
        tool: maintenance.tool,
        ...(maintenance.installed ? { installed: maintenance.installed } : {}),
        ...(maintenance.latest ? { latest: maintenance.latest } : {}),
        source: maintenance.install.label,
        ...(maintenance.update ? { update: cliCommandText(maintenance.update) } : {}),
        ...(maintenance.install.note ? { note: maintenance.install.note } : {}),
        ...(maintenance.behind ? { behind: maintenance.behind } : {}),
        ...(maintenance.switch ? { switchSteps: maintenance.switch.steps.map((step) => cliCommandText(step)) } : {}),
        ...(state ? { state } : {}),
      };
    });
    return {
      ...(this.saved.automatic !== undefined ? { automatic: this.saved.automatic } : {}),
      ...(blocked ? { blocked } : {}),
      tools,
      log: [...this.saved.log],
    };
  }

  private record(entry: Omit<UiRuntimeToolLogEntry, "at">): void {
    this.saved.log = [{ at: this.now(), ...entry }, ...this.saved.log].slice(0, LOG_LIMIT);
    this.options.log(`runtime-tools.${entry.action}.${entry.outcome}`, `${entry.label}${entry.command ? `: ${entry.command}` : ""}${entry.message ? ` (${entry.message})` : ""}`);
    this.persist();
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch(() => undefined).finally(() => this.schedule(this.options.checkEveryMs ?? CHECK_EVERY_MS));
    }, delayMs);
    this.timer.unref?.();
  }

  private load(): Promise<void> {
    const file = this.options.file;
    return this.loaded ??= !file ? Promise.resolve() : readPersistedJson(file, { expectedVersion: FILE_VERSION, decode: decodeSaved, logger: { warn: () => undefined } })
      .then((read) => { if (read?.data) this.saved = read.data; }, () => undefined);
  }

  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    const saved = { ...this.saved };
    this.writing = this.writing
      .then(() => writePersistedJson(file, FILE_VERSION, saved, { logger: { warn: () => undefined } }))
      .catch(() => undefined);
  }

  /** Resolves once the settings and log are on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
