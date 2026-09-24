import { spawn, type ChildProcess } from "node:child_process";

export interface KeepAwakeLogger {
  info(label: string, detail?: unknown): void;
  warn(label: string, detail?: unknown): void;
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** The host's pid: the helper ends with it, even when nobody got to stop it. */
  pid?: number;
  /** The setting, read whenever the first turn starts or the config changes. */
  enabled(): Promise<boolean>;
  spawn?: (command: string, args: string[]) => ChildProcess;
  logger?: KeepAwakeLogger;
}

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED, written out: a hex literal is an Int32 in older PowerShell. */
const SYSTEM_REQUIRED = 2147483649;

/**
 * The process that holds the machine awake, one per platform. Each gives up
 * the hold when it exits and exits when the host does.
 */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): { command: string; args: string[] } | undefined {
  if (platform === "darwin") return { command: "caffeinate", args: ["-i", "-s", "-w", String(pid)] };
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: ["--what=idle:sleep", "--who=Tau", "--why=Turns are running", "--mode=block", "/bin/sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 10; done`],
    };
  }
  if (platform === "win32") {
    const script = [
      `$power = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);' -Name Power -Namespace Tau -PassThru`,
      `[void]$power::SetThreadExecutionState([uint32]${SYSTEM_REQUIRED})`,
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 10 }`,
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
  }
  return undefined;
}

/**
 * Keeps the machine from sleeping while any thread runs a turn, when the user
 * turned that on: a sleeping machine is out of reach for a phone and stops the
 * turn it was running. Follows the host's `agent-status` events.
 */
export class KeepAwake {
  private readonly running = new Set<string>();
  private helper: ChildProcess | undefined;
  /** The helper would not start or run here; tried again once the config changes. */
  private unavailable = false;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: KeepAwakeOptions) {}

  /** Whether the machine is being held awake now. */
  get active(): boolean {
    return this.helper !== undefined;
  }

  observe(event: { type: string; sessionId?: string | undefined; running?: boolean }): void {
    if (event.type === "config-changed") {
      this.unavailable = false;
      void this.update();
      return;
    }
    if (event.type !== "agent-status" || !event.sessionId) return;
    const before = this.running.size;
    if (event.running) this.running.add(event.sessionId);
    else this.running.delete(event.sessionId);
    if ((before === 0) !== (this.running.size === 0)) void this.update();
  }

  /** Starts or stops the helper to match the turns and the setting; calls run one after another. */
  update(): Promise<void> {
    this.queue = this.queue.then(() => this.apply(), () => this.apply());
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private async apply(): Promise<void> {
    const wanted = !this.disposed && !this.unavailable && this.running.size > 0 && await this.options.enabled().catch(() => false);
    if (wanted && !this.helper) this.start();
    else if (!wanted && this.helper) this.stop();
  }

  private start(): void {
    const platform = this.options.platform ?? process.platform;
    const command = keepAwakeCommand(platform, this.options.pid ?? process.pid);
    if (!command) {
      this.unavailable = true;
      return;
    }
    const child = (this.options.spawn ?? defaultSpawn)(command.command, command.args);
    this.helper = child;
    this.options.logger?.info("keep-awake.started", { command: command.command, turns: this.running.size });
    const lost = (detail: unknown) => {
      if (this.helper !== child) return;
      this.helper = undefined;
      this.unavailable = true;
      this.options.logger?.warn("keep-awake.unavailable", detail);
    };
    child.once("error", (error) => lost(error.message));
    child.once("exit", (code, signal) => lost({ command: command.command, code, signal }));
  }

  private stop(): void {
    const child = this.helper;
    if (!child) return;
    this.helper = undefined;
    child.kill();
    this.options.logger?.info("keep-awake.stopped");
  }
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: "ignore", windowsHide: true });
}
