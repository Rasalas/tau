import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import { findExecutable } from "./shell-environment.js";

/**
 * Agents and terminals on Linux. Each long-lived agent CLI, each terminal and
 * each Pi bash call starts inside its own systemd scope in one slice, so an
 * out-of-memory kill (the kernel's, or systemd-oomd's, which kills whole leaf
 * cgroups) takes that agent and not the host with every other thread. Without
 * a user manager the command still gets a high `oom_score_adj`. Elsewhere
 * nothing changes. Pure builders first, then the launcher with its probes
 * injected, then the process-wide instance the kits use.
 */

/** Agents and terminals share this slice, next to the host's own unit in `app.slice`. */
export const AGENT_SLICE = "app-tau-agents.slice";
/** An unprivileged process may raise its own score, never lower it. */
export const AGENT_OOM_SCORE_ADJ = 800;
/** What a failed turn says when its newest scope recorded `Result=oom-kill`. */
export const AGENT_OOM_MESSAGE = "Killed: out of memory.";

const GiB = 1024 ** 3;

/**
 * Memory limits of the agents slice: agents together leave about 6 GB free
 * before they are throttled and 4 GB before one is killed, so the host, sshd
 * and the network keep working. Small machines give agents at least half of
 * the RAM before throttling and three quarters before a kill.
 */
export function agentSliceMemoryLimits(totalBytes: number): { high: number; max: number } {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

/** Scopes accept `OOMPolicy` from systemd 253; older user managers get plain scopes. */
const OOM_POLICY_OPTION = "--property=OOMPolicy=stop";

const RAISE_OOM_SCORE = `{ echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`;
const SCORE_ONLY_SCRIPT = [RAISE_OOM_SCORE, 'exec "$@"'].join("\n");
// `systemd-run --user` finds the user manager through XDG_RUNTIME_DIR; fill it in when the agent's environment lacks it.
const SCOPED_SCRIPT = [RAISE_OOM_SCORE, ': "${XDG_RUNTIME_DIR:=$1}"', "export XDG_RUNTIME_DIR", "shift", 'exec "$@"'].join("\n");

/** What a launch needs from a probed user manager. */
export interface AgentScopeSetup {
  readonly systemdRun: string;
  readonly systemctl: string;
  readonly runtimeDir: string;
  /** Extra `systemd-run` options; empty on a systemd without scope `OOMPolicy`. */
  readonly options: readonly string[];
}

export interface AgentCommand {
  command: string;
  args: string[];
}

/**
 * The Linux launch of `command`. Every step `exec`s, so the spawned PID,
 * stdio and signals belong to the agent itself; `systemd-run --scope`
 * registers its own PID as the scope and then runs the command.
 */
export function agentScopeCommand(input: { command: string; args: readonly string[]; scope?: { setup: AgentScopeSetup; unit?: string; collect?: boolean } }): AgentCommand {
  const { command, args, scope } = input;
  if (!scope) return { command: "/bin/sh", args: ["-c", SCORE_ONLY_SCRIPT, "tau-agent", command, ...args] };
  const { setup } = scope;
  return {
    command: "/bin/sh",
    args: [
      "-c", SCOPED_SCRIPT, "tau-agent",
      setup.runtimeDir, setup.systemdRun,
      "--user", "--scope", "--quiet", `--slice=${AGENT_SLICE}`,
      ...(scope.unit ? [`--unit=${scope.unit}`] : []),
      ...setup.options,
      // A failed scope stays loaded so its result can be read; one nobody reads is unloaded at once.
      ...(scope.collect ? ["--collect"] : []),
      "--", command, ...args,
    ],
  };
}

export interface ScopeState {
  loadState: string;
  activeState: string;
  result: string;
  /** `oom_kill` from the scope's `memory.events`, while its cgroup exists. */
  oomKills: number;
  /** `populated` from the scope's `cgroup.events`, while its cgroup exists. */
  populated: boolean | undefined;
}

/**
 * A scope as read right after its agent exited. The pipe can close before
 * systemd handles the kill, so a scope that is still stopping, is empty or
 * already counted a kill is "stopping": `Result=oom-kill` follows in a moment.
 */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (state.loadState !== "loaded" || state.activeState === "inactive" || state.activeState === "failed") return "gone";
  if (state.activeState === "deactivating" || state.oomKills > 0 || state.populated === false) return "stopping";
  return "running";
}

export function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

export function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "mu").exec(text);
  return match === null ? undefined : Number(match[1]);
}

export interface ScopeRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the launcher reads from the machine, so tests supply a fake `systemd-run` and `systemctl`. */
export interface AgentScopeSystem {
  platform: NodeJS.Platform;
  /** `TAU_AGENT_SCOPES=0`: every command stays as it is, whatever the platform. */
  disabled?: boolean;
  /** The host's own environment: `XDG_RUNTIME_DIR` and the PATH `systemd-run` is found on. */
  env: NodeJS.ProcessEnv;
  totalMemory(): number;
  resolve(command: string, env: NodeJS.ProcessEnv): string | undefined;
  /** Blocking, for the one-time probe and the launch; undefined when the program could not start. */
  run(command: string, args: readonly string[]): ScopeRun | undefined;
  runAsync(command: string, args: readonly string[]): Promise<ScopeRun | undefined>;
  readFile(path: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  newId(): string;
  warn?(message: string, detail?: unknown): void;
}

/** One agent's scope: ask it whether the agent died of memory once the process has exited. */
export interface AgentScopeHandle {
  readonly unit: string;
  /** Whether the scope recorded `Result=oom-kill`; the failed unit is reset afterwards. */
  oomKilled(): Promise<boolean>;
}

export interface AgentLaunch extends AgentCommand {
  scope?: AgentScopeHandle;
}

export interface AgentWrapInput {
  command: string;
  args: readonly string[];
  /** Names the scope unit: `tau-<name>-<id>.scope`. */
  name: string;
  /** The environment the command runs with; it resolves the command on PATH. */
  env?: NodeJS.ProcessEnv;
  /** Nobody will ask about the result, so systemd may unload the unit even when it fails. */
  collect?: boolean;
}

const PROBE_TIMEOUT_MS = 5_000;
const STOPPING_POLL_MS = 100;
const STOPPING_POLL_ATTEMPTS = 20;

export class AgentScopes {
  private probed = false;
  private setup: AgentScopeSetup | undefined;

  constructor(private readonly system: AgentScopeSystem) {}

  /** The Linux user manager the first call found, or undefined: macOS, Windows, a container, a login without one. */
  scopeSetup(): AgentScopeSetup | undefined {
    if (!this.probed) {
      this.probed = true;
      this.setup = this.isolates() ? this.probe() : undefined;
    }
    return this.setup;
  }

  private isolates(): boolean {
    return this.system.platform === "linux" && !this.system.disabled;
  }

  private probe(): AgentScopeSetup | undefined {
    const { system } = this;
    try {
      const runtimeDir = system.env.XDG_RUNTIME_DIR;
      if (!runtimeDir) return undefined;
      const systemdRun = system.resolve("systemd-run", system.env);
      const systemctl = system.resolve("systemctl", system.env);
      if (!systemdRun || !systemctl) return undefined;
      const works = (options: readonly string[]) => system.run(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--slice=${AGENT_SLICE}`, ...options, "--", "true"])?.code === 0;
      const options = works([OOM_POLICY_OPTION]) ? [OOM_POLICY_OPTION] : works([]) ? [] : undefined;
      if (!options) return undefined;
      const limits = agentSliceMemoryLimits(system.totalMemory());
      const limited = system.run(systemctl, ["--user", "set-property", "--runtime", AGENT_SLICE, `MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`]);
      if (limited?.code !== 0) system.warn?.("Could not set memory limits on the agents slice", limited?.stderr.trim());
      return { systemdRun, systemctl, runtimeDir, options };
    } catch {
      return undefined;
    }
  }

  /** The command to spawn instead of `input`: unchanged where agents are not isolated or `command` does not resolve. */
  wrap(input: AgentWrapInput): AgentLaunch {
    const plain = { command: input.command, args: [...input.args] };
    const { system } = this;
    if (!this.isolates()) return plain;
    // An unresolved command stays as it is, so a missing binary still fails at spawn with its own error.
    const command = system.resolve(input.command, input.env ?? system.env);
    if (!command) return plain;
    const setup = this.scopeSetup();
    if (!setup) return agentScopeCommand({ command, args: input.args });
    const unit = `tau-${input.name.replace(/[^A-Za-z0-9]/gu, "")}-${system.newId()}.scope`;
    const launch = agentScopeCommand({ command, args: input.args, scope: { setup, unit, collect: input.collect === true } });
    return input.collect ? launch : { ...launch, scope: this.handle(setup, unit) };
  }

  private handle(setup: AgentScopeSetup, unit: string): AgentScopeHandle {
    let answer: Promise<boolean> | undefined;
    return { unit, oomKilled: () => (answer ??= this.readOutcome(setup, unit)) };
  }

  private async readState(setup: AgentScopeSetup, unit: string): Promise<ScopeState | undefined> {
    const shown = await this.system.runAsync(setup.systemctl, ["--user", "show", unit, "--property=LoadState,ActiveState,Result,ControlGroup"]);
    // A failed query says nothing about the scope.
    if (!shown || shown.code !== 0) return undefined;
    const values = parseKeyValues(shown.stdout);
    const group = values.get("ControlGroup") ?? "";
    const read = (file: string) => (group ? this.system.readFile(join("/sys/fs/cgroup", group, file)).catch(() => "") : Promise.resolve(""));
    const [memoryEvents, cgroupEvents] = await Promise.all([read("memory.events"), read("cgroup.events")]);
    const populated = parseCgroupCounter(cgroupEvents, "populated");
    return {
      loadState: values.get("LoadState") ?? "",
      activeState: values.get("ActiveState") ?? "",
      result: values.get("Result") ?? "",
      oomKills: parseCgroupCounter(memoryEvents, "oom_kill") ?? 0,
      populated: populated === undefined ? undefined : populated === 1,
    };
  }

  private async readOutcome(setup: AgentScopeSetup, unit: string): Promise<boolean> {
    try {
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt += 1) {
        const state = await this.readState(setup, unit);
        if (!state) return false;
        const status = classifyScope(state);
        if (status === "running") return false;
        if (status === "stopping") { await this.system.sleep(STOPPING_POLL_MS); continue; }
        // A failed unit stays loaded until it is reset.
        if (state.activeState === "failed") await this.system.runAsync(setup.systemctl, ["--user", "reset-failed", unit]);
        return status === "oom-killed";
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * A shell for Pi's bash tool: a script that raises the score and starts the
   * real shell in its own scope, one per call. Written under the user manager's
   * private runtime directory; undefined where there is none.
   */
  agentShell(shell: string, directory?: string): string | undefined {
    const setup = this.scopeSetup();
    if (!this.isolates() || !setup) return undefined;
    const dir = directory ?? join(setup.runtimeDir, "tau-agents");
    const script = agentShellScript(shell, setup);
    const path = join(dir, `shell-${createHash("sha256").update(script).digest("hex").slice(0, 12)}`);
    try {
      if (!existsSync(path) || readFileSync(path, "utf8") !== script) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path, script, { mode: 0o700 });
        chmodSync(path, 0o700);
      }
      return path;
    } catch {
      return undefined;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The body of the shell that Pi's bash tool starts with `-c <command>`. */
export function agentShellScript(shell: string, setup: AgentScopeSetup): string {
  return [
    "#!/bin/sh",
    RAISE_OOM_SCORE,
    `: "\${XDG_RUNTIME_DIR:=${setup.runtimeDir.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}}"`,
    "export XDG_RUNTIME_DIR",
    // Anything the call leaves running joins the scope and stays in the agents slice.
    `exec ${[shellQuote(setup.systemdRun), "--user", "--scope", "--quiet", "--collect", `--slice=${AGENT_SLICE}`, ...setup.options, "'--description=Tau agent shell'", "--", shellQuote(shell)].join(" ")} "$@"`,
    "",
  ].join("\n");
}

function runBlocking(command: string, args: readonly string[]): ScopeRun | undefined {
  try {
    const stdout = execFileSync(command, [...args], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string; code?: string };
    return typeof failure.status === "number" ? { code: failure.status, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") } : undefined;
  }
}

function runAsynchronously(command: string, args: readonly string[]): Promise<ScopeRun | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = (error as { code?: unknown }).code;
      resolve(typeof code === "number" ? { code, stdout, stderr } : undefined);
    });
  });
}

export function hostAgentScopeSystem(): AgentScopeSystem {
  return {
    platform: process.platform,
    disabled: process.env.TAU_AGENT_SCOPES === "0",
    env: process.env,
    totalMemory: totalmem,
    resolve: (command, env) => findExecutable(command, env),
    run: runBlocking,
    runAsync: runAsynchronously,
    readFile: (path) => readFile(path, "utf8"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => randomUUID().slice(0, 8),
    warn: (message, detail) => console.warn(message, detail ?? ""),
  };
}

let shared: AgentScopes | undefined;

/** The launcher of this process; it probes the machine on its first Linux launch. */
export function agentScopes(): AgentScopes {
  return shared ??= new AgentScopes(hostAgentScopeSystem());
}

/**
 * Wraps the command that starts an agent CLI, a terminal shell or another
 * long-lived process of a thread. Spawn the result; keep `scope` to learn
 * after an unexpected exit whether memory ended it (`AGENT_OOM_MESSAGE`).
 * `agentScopeCommand`'s exec chain keeps the PID, stdio and signals.
 */
export function wrapAgentCommand(input: AgentWrapInput): AgentLaunch {
  return agentScopes().wrap(input);
}

/** The shell Pi's bash tool should start instead of `shell`, or undefined when scopes are off. */
export function agentShellFor(shell: string | undefined): string | undefined {
  const scopes = agentScopes();
  if (process.platform !== "linux" || process.env.TAU_AGENT_SCOPES === "0") return undefined;
  const real = shell ?? (existsSync("/bin/bash") ? "/bin/bash" : findExecutable("bash"));
  return real ? scopes.agentShell(real) : undefined;
}
