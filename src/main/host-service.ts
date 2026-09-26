import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { UiHostDisplay, UiHostService, UiHostServiceProblem } from "../shared/connections.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import { processAlive, readHostDescriptor } from "./host-process-supervisor.js";
import { DISPLAY_WINDOW_IDLE_MS } from "./display-window.js";
import {
  FIRST_DISPLAY_NUMBER,
  defaultUserData,
  displayEnvironment,
  displayServiceNames,
  hostServiceNames,
  renderWindowUnit,
  renderXauthority,
  renderXvfbUnit,
  windowEnvironment,
  windowProgram,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsLauncher,
  renderWindowsTask,
  serviceEnvironment,
  servicePath,
  utf16WithBom,
  type HostDisplaySpec,
  type HostServiceManagerKind,
  type HostServiceNames,
  type HostServiceSpec,
} from "./host-service-units.js";

/** One command a service manager runs; an optional one may fail without failing the whole. */
export interface ServiceStep {
  command: string;
  args: string[];
  optional?: boolean;
}

export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the service manager's commands; tests and dev instances replace it. */
export interface ServiceCommandRunner {
  run(step: ServiceStep): Promise<ServiceCommandResult>;
  /**
   * Runs the steps in a process of its own, a second after this one answered:
   * for a host that restarts or removes its own service and is stopped by it.
   */
  detach(steps: readonly ServiceStep[]): void;
}

export interface HostServiceOptions {
  /** The binary the service runs: Electron as Node, or node for a hand-started host. */
  execPath: string;
  /** `dist-electron/main/headless.js`, the real file rather than the archive's copy. */
  entry: string;
  userData: string;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  /** `DOMAIN\user`, the principal of a Windows task. */
  windowsUser?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
  /** Stops a host a Windows task started: ending the task leaves the host it started running. */
  retireHost?: () => Promise<void>;
  /** Where Xvfb is; searched on the unit's PATH when absent. */
  locateXvfb?: () => string | undefined;
  /** Whether display `:N` is in use on this machine; its X lock and socket when absent. */
  displayTaken?: (number: number) => boolean;
}

/** `--display` on a machine that cannot have one. */
const DISPLAY_UNSUPPORTED: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS has no invisible display: there is no Xvfb, and virtual displays need private API. The preview runs hidden in a Tau window you open instead.",
  win32: "Windows has no invisible display Tau can start a window on. The preview runs hidden in a Tau window you open instead.",
};
const NO_XVFB = "Xvfb is not installed. Install it (Debian and Ubuntu: sudo apt install xvfb), then run tau service install --display again.";
/** Past this, something else owns every display number Tau would try. */
const LAST_DISPLAY_NUMBER = FIRST_DISPLAY_NUMBER + 100;

interface ServiceFile {
  path: string;
  content: string | Buffer;
}

/** A service manager as data: its files and the commands of each step. */
interface Backend {
  kind: HostServiceManagerKind;
  label: string;
  unitPath: string;
  files(spec: HostServiceSpec, display?: HostDisplaySpec): ServiceFile[];
  /** After the files are written; the last step starts the host. */
  activate: ServiceStep[];
  /** Starts an installed service that is not running; a no-op for one that is. */
  start: ServiceStep[];
  restart: ServiceStep[];
  /** Before the files are removed. */
  deactivate: ServiceStep[];
  /** After they are removed; for a host removing its own service these stop it. */
  finalize: ServiceStep[];
}

export class HostServiceError extends Error {
  readonly code = HOST_ERROR.failed;
}

/** Shell quoting for the detached script; the steps never contain a newline. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The machine's service manager. `TAU_SERVICE_CONTROL` names a script that
 * stands in for it (`scripts/fake-service-manager.mjs`): a dev instance and the
 * smoke test run every command through that, never the real one.
 */
export function serviceCommandRunner(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): ServiceCommandRunner {
  const control = env.TAU_SERVICE_CONTROL?.trim();
  const argv = (step: ServiceStep) => (control ? [execPath, control, step.command, ...step.args] : [step.command, ...step.args]);
  const childEnv: NodeJS.ProcessEnv = control ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
  return {
    run: (step) => new Promise((resolve) => {
      const [command, ...args] = argv(step);
      execFile(command!, args, { env: childEnv, timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === 127 ? error.message : "") });
      });
    }),
    detach: (steps) => {
      if (platform === "win32") {
        const quote = (value: string) => `"${value}"`;
        const line = ["ping -n 2 127.0.0.1 >nul", ...steps.map((step) => argv(step).map(quote).join(" "))].join(" & ");
        spawn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { env: childEnv, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
        return;
      }
      const script = ["sleep 1", ...steps.map((step) => argv(step).map(shellQuote).join(" "))].join("; ");
      spawn("/bin/sh", ["-c", script], { env: childEnv, detached: true, stdio: "ignore" }).unref();
    },
  };
}

/**
 * Tau's host as a system service: a LaunchAgent on macOS, a systemd user unit
 * on Linux, a Task Scheduler task on Windows. One per userData. The service
 * runs the same entry a window starts, with the same userData, so a window
 * adopts it through `host.json` like any host that is already running.
 */
export class HostServiceManager {
  readonly platform: NodeJS.Platform;
  readonly names: HostServiceNames;
  readonly logPath: string;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: ServiceCommandRunner;
  private readonly backend: Backend | undefined;
  /** Why this machine cannot run the service; undefined when it can. */
  readonly unsupported: string | undefined;

  constructor(private readonly options: HostServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? serviceCommandRunner(this.env, undefined, this.platform);
    // Files are this machine's, so its own path rules: a platform injected for a test is not.
    this.logPath = join(options.userData, "logs", "host-service.log");
    this.names = hostServiceNames(options.userData, defaultUserData(this.platform, this.home, this.env));
    this.unsupported = this.unsupportedReason();
    this.backend = this.unsupported ? undefined : this.createBackend();
  }

  get kind(): HostServiceManagerKind | undefined {
    return this.backend?.kind;
  }

  /** What the unit says; the same for the window, the host and the command line of one install. */
  spec(display?: Pick<HostDisplaySpec, "number" | "authPath">): HostServiceSpec {
    const kind = this.backend?.kind ?? "launchd";
    const env = serviceEnvironment({ userData: this.options.userData, manager: kind, env: this.env, path: servicePath(this.platform, this.options.execPath) });
    return {
      program: [this.options.execPath, this.options.entry],
      env: display ? { ...env, ...displayEnvironment(display) } : env,
      workingDirectory: this.home,
      logPath: this.logPath,
    };
  }

  /** Why this machine cannot keep an invisible display; undefined when it can. */
  get displayUnsupported(): string | undefined {
    if (this.unsupported) return this.unsupported;
    return this.backend?.kind === "systemd" ? undefined : DISPLAY_UNSUPPORTED[this.platform] ?? `Tau knows no invisible display on ${this.platform}.`;
  }

  /** The display units and files of this userData; the host unit's own names decide theirs. */
  private get displayPaths() {
    const directory = dirname(this.backend?.unitPath ?? "");
    const { xvfbUnit, windowUnit } = displayServiceNames(this.names.unit);
    return {
      xvfbUnit,
      windowUnit,
      xvfbUnitPath: join(directory, xvfbUnit),
      windowUnitPath: join(directory, windowUnit),
      authPath: join(this.options.userData, "display", "Xauthority"),
      xvfbLog: join(this.options.userData, "logs", "display-xvfb.log"),
      windowLog: join(this.options.userData, "logs", "display-window.log"),
    };
  }

  /** The display the installed units name: its number and Xvfb, read back from the Xvfb unit. */
  async installedDisplay(): Promise<{ number: number; xvfb: string } | undefined> {
    if (this.displayUnsupported) return undefined;
    const unit = await readFile(this.displayPaths.xvfbUnitPath, "utf8").catch(() => undefined);
    const match = unit && /^ExecStart="((?:\\.|[^"\\])*)" ":(\d+)"/mu.exec(unit);
    return match ? { number: Number(match[2]), xvfb: match[1]!.replace(/\\(["\\])/gu, "$1").replaceAll("%%", "%").replaceAll("$$", "$") } : undefined;
  }

  private displaySpec(number: number, xvfb: string): HostDisplaySpec {
    const paths = this.displayPaths;
    const display = { number, authPath: paths.authPath };
    const program = windowProgram(this.options.execPath, this.options.entry);
    return {
      ...display,
      xvfb,
      xvfbUnit: paths.xvfbUnit,
      windowUnit: paths.windowUnit,
      window: { program, env: windowEnvironment(this.spec().env, display), workingDirectory: this.home, logPath: paths.windowLog },
    };
  }

  private locateXvfb(): string | undefined {
    if (this.options.locateXvfb) return this.options.locateXvfb();
    for (const directory of servicePath(this.platform, this.options.execPath).split(":")) {
      const candidate = join(directory, "Xvfb");
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return undefined;
  }

  private freeDisplayNumber(): number {
    const listening = abstractX11Displays(procNetUnix());
    const taken = this.options.displayTaken
      ?? ((number: number) => listening.has(number) || existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`));
    for (let number = FIRST_DISPLAY_NUMBER; number <= LAST_DISPLAY_NUMBER; number++) if (!taken(number)) return number;
    throw new HostServiceError(`Every display from :${FIRST_DISPLAY_NUMBER} to :${LAST_DISPLAY_NUMBER} is in use.`);
  }

  /** Kept across installs, so a running Xvfb and the windows on it keep matching. */
  private async writeCookie(display: HostDisplaySpec): Promise<void> {
    await mkdir(dirname(display.authPath), { recursive: true, mode: 0o700 });
    if (existsSync(display.authPath)) return;
    await writeFile(display.authPath, renderXauthority(display.number, randomBytes(16)), { mode: 0o600 });
  }

  private async removeDisplayFiles(): Promise<void> {
    const paths = this.displayPaths;
    for (const path of [paths.xvfbUnitPath, paths.windowUnitPath]) await rm(path, { force: true });
    await rm(dirname(paths.authPath), { recursive: true, force: true });
  }

  /** Starts the window on the display; the host asks when a call needs a window half. */
  async startWindow(): Promise<void> {
    await this.runner.run({ command: "systemctl", args: ["--user", "start", this.displayPaths.windowUnit] }).then((result) => {
      if (result.code !== 0) throw new HostServiceError(`The window on the invisible display did not start: ${(result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.code}`}.`);
    });
  }

  async stopWindow(): Promise<void> {
    await this.runner.run({ command: "systemctl", args: ["--user", "stop", this.displayPaths.windowUnit] });
  }

  private async active(unit: string): Promise<boolean> {
    return (await this.runner.run({ command: "systemctl", args: ["--user", "is-active", unit] })).code === 0;
  }

  private async displayStatus(installed: { number: number } | undefined): Promise<UiHostDisplay> {
    const idleMinutes = DISPLAY_WINDOW_IDLE_MS / 60_000;
    const reason = this.displayUnsupported;
    if (reason) return { supported: false, reason, installed: false, xvfbRunning: false, windowRunning: false, idleMinutes };
    if (!installed) return { supported: true, installed: false, xvfbRunning: false, windowRunning: false, idleMinutes };
    const paths = this.displayPaths;
    const [xvfbRunning, windowRunning] = await Promise.all([this.active(paths.xvfbUnit), this.active(paths.windowUnit)]);
    return { supported: true, installed: true, display: `:${installed.number}`, xvfbRunning, windowRunning, idleMinutes };
  }

  /** Whether a unit for this userData is on disk. */
  async installed(): Promise<boolean> {
    if (!this.backend) return false;
    return readFile(this.backend.unitPath).then(() => true, () => false);
  }

  /** `self`: the pid of the host asking, so the answer can say whether it is the service. */
  async status(self?: { pid: number }): Promise<UiHostService> {
    const backend = this.backend;
    if (!backend) return { supported: false, reason: this.unsupported, installed: false, running: false, serving: false, stale: false, logPath: this.logPath, problems: [] };
    const installedDisplay = await this.installedDisplay();
    const xvfb = installedDisplay && (this.locateXvfb() ?? installedDisplay.xvfb);
    const display = installedDisplay && xvfb ? this.displaySpec(installedDisplay.number, xvfb) : undefined;
    const expected = backend.files(this.spec(display), display);
    const present = await Promise.all(expected.map((file) => readFile(file.path).catch(() => undefined)));
    const installed = present[0] !== undefined;
    const stale = installed && expected.some((file, index) => !present[index]?.equals(Buffer.from(file.content)));
    const descriptor = await readHostDescriptor(this.options.userData);
    const running = descriptor?.service === backend.kind && processAlive(descriptor.pid);
    return {
      supported: true,
      manager: backend.kind,
      label: backend.label,
      installed,
      running,
      serving: running && descriptor?.pid === self?.pid,
      stale,
      ...(running && descriptor?.version ? { version: descriptor.version } : {}),
      unitPath: backend.unitPath,
      logPath: this.logPath,
      problems: installed ? [...await this.problems(backend), ...(installedDisplay && !this.locateXvfb() ? [{ code: "xvfb-missing", message: NO_XVFB }] : [])] : [],
      display: await this.displayStatus(installed ? installedDisplay : undefined),
    };
  }

  /**
   * Writes the unit and starts the service. A host started by it takes over
   * from the one running now (`headless.ts`). `detached` for the service host
   * itself, which the restart stops before it could finish the steps.
   * `display` adds or removes the invisible display; left out, an install
   * keeps whatever is there.
   */
  async install(options: { detached?: boolean; display?: boolean } = {}): Promise<void> {
    const backend = this.require();
    const current = await this.installedDisplay();
    const wanted = options.display ?? current !== undefined;
    if (wanted && this.displayUnsupported) throw new HostServiceError(this.displayUnsupported);
    let display: HostDisplaySpec | undefined;
    if (wanted) {
      const xvfb = this.locateXvfb();
      if (!xvfb) throw new HostServiceError(NO_XVFB);
      display = this.displaySpec(current?.number ?? this.freeDisplayNumber(), xvfb);
    }
    if (backend.kind === "systemd") await this.prepareSystemd();
    await mkdir(dirname(this.logPath), { recursive: true, mode: 0o700 });
    const paths = this.displayPaths;
    // The window starts again on demand, on whatever the units say now.
    if (current) await this.steps([{ ...systemctlUser("stop", paths.windowUnit), optional: true }]);
    if (current && !display) {
      await this.steps([{ ...systemctlUser("stop", paths.xvfbUnit), optional: true }]);
      await this.removeDisplayFiles();
    }
    if (display) await this.writeCookie(display);
    for (const file of backend.files(this.spec(display), display)) await writeAtomically(file);
    const activate = display ? [...backend.activate.slice(0, -1), systemctlUser("restart", paths.xvfbUnit), ...backend.activate.slice(-1)] : backend.activate;
    await this.steps(activate, options.detached);
  }

  /** Stops the service and removes it from login. False when there was none. */
  async uninstall(options: { detached?: boolean } = {}): Promise<boolean> {
    const backend = this.require();
    if (!await this.installed()) return false;
    await this.steps(backend.deactivate);
    if (await this.installedDisplay()) {
      const paths = this.displayPaths;
      await this.steps([{ ...systemctlUser("stop", paths.windowUnit), optional: true }, { ...systemctlUser("stop", paths.xvfbUnit), optional: true }]);
      await this.removeDisplayFiles();
    }
    for (const file of backend.files(this.spec())) await rm(file.path, { force: true });
    await this.steps(backend.finalize, options.detached);
    if (backend.kind === "task-scheduler") await this.options.retireHost?.();
    return true;
  }

  /** Starts an installed service that is not running. */
  async start(): Promise<void> {
    await this.steps(this.require().start);
  }

  /** Stops and starts the host the service runs, on whatever the unit names now. */
  async restart(): Promise<void> {
    await this.steps(this.require().restart);
  }

  private require(): Backend {
    if (!this.backend) throw new HostServiceError(this.unsupported ?? "This machine has no service manager Tau knows.");
    return this.backend;
  }

  private async steps(steps: readonly ServiceStep[], detached = false): Promise<void> {
    if (detached) {
      this.runner.detach(steps);
      return;
    }
    for (const step of steps) {
      const result = await this.runner.run(step);
      if (result.code !== 0 && !step.optional) {
        const detail = (result.stderr || result.stdout).trim().split("\n")[0];
        throw new HostServiceError(`\`${[step.command, ...step.args].join(" ")}\` failed (exit ${result.code})${detail ? `: ${detail}` : ""}.`);
      }
    }
  }

  private unsupportedReason(): string | undefined {
    const { execPath } = this.options;
    if (this.platform === "darwin") {
      if ((this.options.uid ?? currentUid()) === undefined) return "No user id to run a LaunchAgent for.";
      // Gatekeeper runs a quarantined download from a random folder that is gone after a restart.
      if (execPath.includes("/AppTranslocation/")) return "macOS runs this copy of Tau from a temporary folder. Move Tau to Applications, open it from there, then install the service.";
      return undefined;
    }
    if (this.platform === "linux") {
      if (this.env.APPIMAGE || execPath.startsWith("/tmp/.mount_")) return "An AppImage is mounted at a new path on every start, so a service cannot point at it. Install Tau from a package to run it as a service.";
      return undefined;
    }
    if (this.platform === "win32") return undefined;
    return `Tau knows no service manager on ${this.platform}.`;
  }

  private createBackend(): Backend {
    const { label, unit, task } = this.names;
    const override = this.env.TAU_SERVICE_UNIT_DIR?.trim();
    if (this.platform === "darwin") {
      const uid = this.options.uid ?? currentUid()!;
      const unitPath = join(override || join(this.home, "Library", "LaunchAgents"), `${label}.plist`);
      const domain = `gui/${uid}`;
      const target = `${domain}/${label}`;
      // `--wait`: a bootstrap while the old job drains fails with EIO.
      const bootout: ServiceStep = { command: "launchctl", args: ["bootout", "--wait", target], optional: true };
      return {
        kind: "launchd",
        label,
        unitPath,
        files: (spec) => [{ path: unitPath, content: renderLaunchAgent(label, spec) }],
        // Loading a RunAtLoad job starts it; a persisted `disable` would refuse the load.
        activate: [bootout, { command: "launchctl", args: ["enable", target], optional: true }, { command: "launchctl", args: ["bootstrap", domain, unitPath] }],
        // A job that is loaded refuses the bootstrap and is started by the kickstart.
        start: [{ command: "launchctl", args: ["bootstrap", domain, unitPath], optional: true }, { command: "launchctl", args: ["kickstart", target] }],
        restart: [{ command: "launchctl", args: ["kickstart", "-k", target] }],
        deactivate: [],
        finalize: [bootout],
      };
    }
    if (this.platform === "linux") {
      const unitPath = join(override || join(this.env.XDG_CONFIG_HOME || join(this.home, ".config"), "systemd", "user"), unit);
      const systemctl = systemctlUser;
      const directory = dirname(unitPath);
      return {
        kind: "systemd",
        label: unit,
        unitPath,
        files: (spec, display) => [
          { path: unitPath, content: renderSystemdUnit(spec, display) },
          ...(display ? [
            { path: join(directory, display.xvfbUnit), content: renderXvfbUnit(display, this.displayPaths.xvfbLog) },
            { path: join(directory, display.windowUnit), content: renderWindowUnit(display, unit) },
          ] : []),
        ],
        activate: [systemctl("daemon-reload"), systemctl("enable", unit), systemctl("restart", unit)],
        start: [systemctl("start", unit)],
        restart: [systemctl("restart", unit)],
        deactivate: [{ ...systemctl("disable", unit), optional: true }],
        // Reload before the stop: a host removing its own unit does not outlive the stop.
        finalize: [{ ...systemctl("daemon-reload"), optional: true }, { ...systemctl("stop", unit), optional: true }],
      };
    }
    const directory = override || join(this.options.userData, "service");
    const base = task.replaceAll(" ", "-").toLowerCase();
    const unitPath = join(directory, `${base}.xml`);
    const launcherPath = join(directory, `${base}.vbs`);
    const user = this.options.windowsUser ?? windowsUser(this.env);
    const end: ServiceStep = { command: "schtasks", args: ["/End", "/TN", task], optional: true };
    const run: ServiceStep = { command: "schtasks", args: ["/Run", "/TN", task] };
    return {
      kind: "task-scheduler",
      label: task,
      unitPath,
      files: (spec) => [
        { path: unitPath, content: utf16WithBom(renderWindowsTask({ user, launcherPath })) },
        { path: launcherPath, content: renderWindowsLauncher(spec) },
      ],
      // Ending the task ends its script, not the host; the new host takes over from the old.
      activate: [{ command: "schtasks", args: ["/Create", "/TN", task, "/XML", unitPath, "/F"] }, end, run],
      start: [run],
      restart: [end, run],
      deactivate: [end, { command: "schtasks", args: ["/Delete", "/TN", task, "/F"] }],
      finalize: [],
    };
  }

  /** Lingering keeps a user's services running after logout and starts them at boot. */
  private async prepareSystemd(): Promise<void> {
    const manager = await this.runner.run({ command: "systemctl", args: ["--user", "show-environment"] });
    if (manager.code !== 0) throw new HostServiceError(PROBLEM_TEXT["user-manager-unavailable"].message);
    if (await this.linger() === "no") {
      await this.runner.run({ command: "loginctl", args: ["enable-linger", "--no-ask-password", ...this.uidArgs()] });
    }
  }

  private uidArgs(): string[] {
    const uid = this.options.uid ?? currentUid();
    return uid === undefined ? [] : [String(uid)];
  }

  private async linger(): Promise<string> {
    const result = await this.runner.run({ command: "loginctl", args: ["show-user", ...this.uidArgs(), "--property=Linger", "--value"] });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private async problems(backend: Backend): Promise<UiHostServiceProblem[]> {
    const problems: UiHostServiceProblem[] = [];
    const add = (code: keyof typeof PROBLEM_TEXT) => problems.push({ code, ...PROBLEM_TEXT[code] });
    if (backend.kind === "launchd") {
      const loaded = await this.runner.run({ command: "launchctl", args: ["print", `gui/${this.options.uid ?? currentUid()}/${backend.label}`] });
      if (loaded.code !== 0) add("not-loaded");
    } else if (backend.kind === "systemd") {
      const manager = await this.runner.run({ command: "systemctl", args: ["--user", "show-environment"] });
      if (manager.code !== 0) {
        add("user-manager-unavailable");
        return problems;
      }
      const enabled = await this.runner.run({ command: "systemctl", args: ["--user", "is-enabled", backend.label] });
      if (enabled.stdout.trim() !== "enabled") add("service-disabled");
      if (await this.linger() === "no") add("linger-disabled");
    } else {
      const registered = await this.runner.run({ command: "schtasks", args: ["/Query", "/TN", backend.label] });
      if (registered.code !== 0) add("not-registered");
    }
    return problems;
  }
}

const PROBLEM_TEXT = {
  "not-loaded": { message: "launchd has not loaded the service, so it does not start at login. Install it again, or log out and back in." },
  "user-manager-unavailable": {
    message: "The systemd user manager does not answer. Tau runs its service as your user, not as root; check that your session has one.",
    command: "systemctl --user status",
  },
  "service-disabled": { message: "The service does not start at login. Install it again to enable it." },
  "linger-disabled": {
    message: "Lingering is off: the service stops when you log out and does not start at boot. An administrator can turn it on.",
    command: "sudo loginctl enable-linger \"$(id -un)\"",
  },
  "not-registered": { message: "Task Scheduler has no task for the service. Install it again." },
} satisfies Record<string, { message: string; command?: string }>;

function systemctlUser(...args: string[]): ServiceStep {
  return { command: "systemctl", args: ["--user", ...args] };
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function windowsUser(env: NodeJS.ProcessEnv): string {
  const name = env.USERNAME || userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

/** A unit half written is worse than none: the manager would load it. */
async function writeAtomically(file: ServiceFile): Promise<void> {
  await mkdir(dirname(file.path), { recursive: true });
  const temporary = join(dirname(file.path), `.${Date.now()}-${process.pid}.tmp`);
  await writeFile(temporary, file.content, { mode: 0o644 });
  await rename(temporary, file.path);
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/**
 * Settings → Connections asks the host about the service of its own machine.
 * Any client may read the status; installing and removing it are the owner's
 * (`host-method-access.ts`). The service host installing or removing itself
 * answers first; the steps that stop it run detached.
 */
export function createHostServiceMethods(manager: () => HostServiceManager | undefined, self: { pid: number } = { pid: process.pid }): Record<string, Method> {
  const available = (): HostServiceManager => {
    const service = manager();
    if (!service) throw Object.assign(new Error("This host cannot run as a service."), { code: HOST_ERROR.unsupported });
    return service;
  };
  const owned = (run: (service: HostServiceManager, params: readonly unknown[]) => Promise<unknown>): Method => async (params, context) => {
    if (!isHostOwner(context.principal)) {
      throw Object.assign(new Error("Only a connection with the host token, on this machine, manages the host's service."), { code: HOST_ERROR.forbidden });
    }
    return run(available(), params);
  };
  return {
    "service-status": async () => available().status(self),
    // `[{ display: boolean }]` adds or removes the invisible display; without it an install keeps it.
    "service-install": owned(async (service, params) => {
      const option = params[0] as { display?: unknown } | undefined;
      const display = typeof option?.display === "boolean" ? option.display : undefined;
      const serving = (await service.status(self)).serving;
      await service.install({ detached: serving, ...(display === undefined ? {} : { display }) });
      return service.status(self);
    }),
    "service-uninstall": owned(async (service) => {
      const serving = (await service.status(self)).serving;
      await service.uninstall({ detached: serving });
      return service.status(self);
    }),
  };
}

/**
 * Displays with an abstract X socket. A container that shares the network
 * namespace has its own `/tmp` but the same abstract sockets, so the files alone miss them.
 */
export function abstractX11Displays(socketTable: string): Set<number> {
  return new Set([...socketTable.matchAll(/ @\/tmp\/\.X11-unix\/X(\d+)$/gmu)].map((match) => Number(match[1])));
}

function procNetUnix(): string {
  try {
    return readFileSync("/proc/net/unix", "utf8");
  } catch {
    return "";
  }
}
