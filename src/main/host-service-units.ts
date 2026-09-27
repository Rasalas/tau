import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { APP_ID } from "./single-instance.js";

/**
 * What a service manager needs to run Tau's host: the files it reads and the
 * names it knows the service by. Pure, so each platform's output is tested
 * without a service manager; `host-service.ts` writes and loads them.
 */

export type HostServiceManagerKind = "launchd" | "systemd" | "task-scheduler";

/** Set in a unit's environment: the host runs as that service and owns `host.json` itself. */
export const HOST_SERVICE_ENV = "TAU_HOST_SERVICE";

/** `configureAppIdentity` and `bin/tau.mjs` name the default userData folder the same way. */
export const USER_DATA_FOLDER = "tau-pi-desktop-prototype";

/**
 * Distinct from the app's bundle id, so launchd and privacy records never mix the two up.
 * Named after the bundle id before de.tbuck.tau; a new label would leave an installed agent running beside it.
 */
const LAUNCHD_LABEL = "dev.tbuck.tau.host";
const SYSTEMD_UNIT = "tau-host";
const TASK_NAME = "Tau Host";

/**
 * What a service host keeps from the environment it was installed from: where
 * an instance keeps its files, and the page origins its socket accepts.
 * Network access needs nothing here: the host reads `<userData>/network.json`.
 * Everything else a unit sets itself, and PATH comes from the login shell.
 */
export const FORWARDED_SERVICE_ENV = [
  "TAU_HOST_ALLOWED_ORIGINS", "TAU_DEV_SERVER_URL",
  "TAU_CONFIG_FILE", "TAU_WORKTREES_DIR", "TAU_THEMES_DIR", "TAU_EXTENSION_GRANTS_FILE", "TAU_HOST_TOKEN_FILE", "TAU_WEB_CLIENT",
  "TAU_OPENCODE_HOME", "TAU_CURSOR_HOME", "TAU_GROK_HOME", "TAU_IMPORT_ROOTS", "TAU_NO_EXTENSIONS",
  "TAU_RUNTIME_UPDATE_COMMAND", "TAU_NO_RUNTIME_UPDATES", "TAU_CURSOR_COMMAND", "TAU_GROK_COMMAND", "TAU_TAILSCALE_COMMAND",
  "TAU_SERVICE_UNIT_DIR", "TAU_SERVICE_CONTROL",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CODEX_HOME",
] as const;

/** Electron's `appData` joined with Tau's folder, the userData a Tau without `TAU_USER_DATA` uses. */
export function defaultUserData(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", USER_DATA_FOLDER);
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), USER_DATA_FOLDER);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), USER_DATA_FOLDER);
}

export interface HostServiceNames {
  /** launchd's label. */
  label: string;
  /** systemd's unit file name. */
  unit: string;
  /** Task Scheduler's task name. */
  task: string;
}

/**
 * One service per userData: the default instance gets the plain names, any
 * other (a dev instance, a second profile) a suffix from its path, so two
 * never replace each other's unit.
 */
export function hostServiceNames(userData: string, defaultPath: string): HostServiceNames {
  if (userData === defaultPath) return { label: LAUNCHD_LABEL, unit: `${SYSTEMD_UNIT}.service`, task: TASK_NAME };
  const suffix = createHash("sha256").update(userData).digest("hex").slice(0, 8);
  return { label: `${LAUNCHD_LABEL}.${suffix}`, unit: `${SYSTEMD_UNIT}-${suffix}.service`, task: `${TASK_NAME} ${suffix}` };
}

/** Everything a unit says, whichever manager reads it. */
export interface HostServiceSpec {
  /** The Electron binary (or node) and the host entry. */
  program: string[];
  env: Record<string, string>;
  workingDirectory: string;
  logPath: string;
}

/**
 * The environment of a service host: the one a window gives the host it
 * starts (`host-process-supervisor.ts`), without a version (the host reads
 * its own from the app it runs from) or a workspace.
 */
export function serviceEnvironment(input: { userData: string; manager: HostServiceManagerKind; env: NodeJS.ProcessEnv; path: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.path,
    ELECTRON_RUN_AS_NODE: "1",
    TAU_USER_DATA: input.userData,
    TAU_HOST_LISTEN: "127.0.0.1:0",
    TAU_HOST_LOCAL_FILES: "1",
    [HOST_SERVICE_ENV]: input.manager,
  };
  for (const key of FORWARDED_SERVICE_ENV) {
    const value = input.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

/** A fixed PATH, so the unit reads the same whoever installs it; the host adds the login shell's. */
export function servicePath(platform: NodeJS.Platform, execPath: string): string {
  if (platform === "win32") return "";
  const directories = [posix.dirname(execPath), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  if (platform === "darwin") directories.splice(1, 0, "/opt/homebrew/bin");
  return [...new Set(directories)].join(":");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

/**
 * A LaunchAgent. `KeepAlive.SuccessfulExit = false` restarts a host that
 * crashed, never one that was asked to stop: a window of another version
 * stopping it must not start a loop of the two replacing each other.
 */
export function renderLaunchAgent(label: string, spec: HostServiceSpec): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(label)}</string>`,
    // Login Items names the app this belongs to (macOS 13+).
    `  <key>AssociatedBundleIdentifiers</key>`,
    `  <string>${APP_ID}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...spec.program.map((argument) => `    <string>${xml(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(spec.env).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(spec.workingDirectory)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    // Above the host's own shutdown, which freezes turns in flight before it exits.
    `  <key>ExitTimeOut</key>`,
    `  <integer>20</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(spec.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ];
  return lines.join("\n");
}

/** systemd expands `%` specifiers everywhere and `$` in command lines. */
function systemdEscape(value: string, command: boolean): string {
  const escaped = value.replaceAll("%", "%%");
  return command ? escaped.replaceAll("$", "$$$$") : escaped;
}

function systemdQuote(value: string, command = false): string {
  return `"${systemdEscape(value, command).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/**
 * A systemd user unit. `Restart=on-failure` for the same reason as the
 * LaunchAgent's `SuccessfulExit`; the start limit ends a crash loop.
 * `display`: the host keeps an invisible display and starts it with itself.
 */
export function renderSystemdUnit(spec: HostServiceSpec, display?: { xvfbUnit: string }): string {
  return [
    "[Unit]",
    "Description=Tau host",
    ...(display ? [`Wants=${display.xvfbUnit}`, `After=${display.xvfbUnit}`] : []),
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    ...Object.entries(spec.env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    ...(display ? [UNSET_DESKTOP_SESSION] : []),
    `ExecStart=${spec.program.map((argument) => systemdQuote(argument, true)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    // SIGTERM to the host alone, which stops its runtimes; the rest of the group only if that hangs.
    "KillMode=mixed",
    "TimeoutStopSec=20",
    // One tool call the kernel kills must not take the host and every thread with it.
    "OOMPolicy=continue",
    `StandardOutput=append:${systemdEscape(spec.logPath, false)}`,
    `StandardError=append:${systemdEscape(spec.logPath, false)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * An invisible display beside a Linux service host (`tau service install
 * --display`): Xvfb, started with the host, and a Tau window on it that the
 * host starts when a call needs a window half and stops when idle
 * (`display-window.ts`). Agents' shells get its `DISPLAY` from the host.
 */
export interface HostDisplaySpec {
  /** N of `:N`. */
  number: number;
  xvfb: string;
  /** The cookie Xvfb admits; without one any local user could read the screen. */
  authPath: string;
  xvfbUnit: string;
  windowUnit: string;
  /** The window process: the app itself, not the host entry. */
  window: HostServiceSpec;
}

export const DISPLAY_SCREEN = "1920x1080x24";
/** Xvfb's own default and `xvfb-run`'s; taken numbers are skipped at install. */
export const FIRST_DISPLAY_NUMBER = 99;

/** The display units that go with a host unit: `tau-host-1a2b.service` → `tau-xvfb-1a2b.service`. */
export function displayServiceNames(hostUnit: string): { xvfbUnit: string; windowUnit: string } {
  const suffix = hostUnit.slice(SYSTEMD_UNIT.length, -".service".length);
  return { xvfbUnit: `tau-xvfb${suffix}.service`, windowUnit: `tau-window${suffix}.service` };
}

/**
 * A desktop session's hand-off to Wayland, which a systemd user manager passes
 * to every unit. Left in, Electron and agents' browsers pick Wayland and show
 * up on the real screen instead of on Xvfb. Unset rather than
 * `XDG_SESSION_TYPE=x11`: a service runs in no login session at all.
 */
export const DESKTOP_SESSION_ENV = ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE"] as const;

/** systemd applies it last, over the manager's own environment as well as the unit's. */
const UNSET_DESKTOP_SESSION = `UnsetEnvironment=${DESKTOP_SESSION_ENV.join(" ")}`;

/** Drops the desktop session's Wayland hand-off from `env`, in place; the names it removed. */
export function leaveDesktopSession(env: NodeJS.ProcessEnv): string[] {
  const removed = DESKTOP_SESSION_ENV.filter((name) => env[name] !== undefined);
  for (const name of removed) delete env[name];
  return removed;
}

/** Chromium's pick without a flag follows `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY`; the window must stay on Xvfb. */
export const WINDOW_X11_FLAG = "--ozone-platform=x11";

/** What a host unit adds for its display: agents' shells and the window inherit both. */
export function displayEnvironment(display: Pick<HostDisplaySpec, "number" | "authPath">): Record<string, string> {
  return { DISPLAY: `:${display.number}`, XAUTHORITY: display.authPath };
}

/** The window's environment: the host's instance settings, the display, and no focus or native dialogs. */
export function windowEnvironment(hostEnv: Record<string, string>, display: Pick<HostDisplaySpec, "number" | "authPath">): Record<string, string> {
  const hostOnly = new Set(["ELECTRON_RUN_AS_NODE", HOST_SERVICE_ENV, "TAU_HOST_LISTEN", "TAU_HOST_LOCAL_FILES"]);
  const env = Object.fromEntries(Object.entries(hostEnv).filter(([key]) => !hostOnly.has(key)));
  return { ...env, ...displayEnvironment(display), TAU_NO_FOCUS: "1", TAU_NO_NATIVE_DIALOGS: "1" };
}

/**
 * What starts the app on the display beside a host entry: a packaged app's
 * binary alone, or Electron with the checkout (`dist-electron/main/headless.js`
 * three levels down), on X11 either way.
 */
export function windowProgram(execPath: string, entry: string): string[] {
  const root = posix.dirname(posix.dirname(posix.dirname(entry)));
  return [...(posix.basename(root) === "app.asar.unpacked" ? [execPath] : [execPath, root]), WINDOW_X11_FLAG];
}

/** One `MIT-MAGIC-COOKIE-1` for display N, any address (FamilyWild), in Xauthority's binary format. */
export function renderXauthority(number: number, cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(number))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(cookie)]);
}

const X11_SOCKET_DIRECTORY_COMMAND = ["/bin/mkdir", "-p", "-m", "1777", "/tmp/.X11-unix"];

/** Xvfb on `:N`, no TCP, with a cookie. The host unit wants it, so it has no `[Install]`. */
export function renderXvfbUnit(display: HostDisplaySpec, logPath: string): string {
  const command = [display.xvfb, `:${display.number}`, "-nolisten", "tcp", "-screen", "0", DISPLAY_SCREEN, "-auth", display.authPath];
  return [
    "[Unit]",
    `Description=Tau invisible display :${display.number}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    // systemd-tmpfiles makes it at boot; a container has none, and Xvfb cannot make it without root.
    `ExecStartPre=-${X11_SOCKET_DIRECTORY_COMMAND.join(" ")}`,
    `ExecStart=${command.map((argument) => systemdQuote(argument, true)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=2",
    `StandardOutput=append:${systemdEscape(logPath, false)}`,
    `StandardError=append:${systemdEscape(logPath, false)}`,
    "",
  ].join("\n");
}

/**
 * The Tau window on the display. Bound to Xvfb and to the host: when either
 * stops the window stops too, so it never outlives the host and starts one of
 * its own. No `[Install]`: only the host starts it, on demand.
 */
export function renderWindowUnit(display: HostDisplaySpec, hostUnit: string): string {
  const { window } = display;
  return [
    "[Unit]",
    "Description=Tau window on the invisible display",
    `BindsTo=${display.xvfbUnit} ${hostUnit}`,
    `After=${display.xvfbUnit} ${hostUnit}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    ...Object.entries(window.env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    UNSET_DESKTOP_SESSION,
    `ExecStart=${window.program.map((argument) => systemdQuote(argument, true)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=mixed",
    "TimeoutStopSec=20",
    `StandardOutput=append:${systemdEscape(window.logPath, false)}`,
    `StandardError=append:${systemdEscape(window.logPath, false)}`,
    "",
  ].join("\n");
}

/** A string literal in VBScript: quotes doubled. */
function vbs(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

/**
 * Task Scheduler cannot set an environment or hide a console, so the task
 * runs this script: it sets the environment, starts the host without a
 * window, waits, and passes the exit code on for `RestartOnFailure`.
 */
export function renderWindowsLauncher(spec: HostServiceSpec): string {
  const quoted = (value: string) => `"${value}"`;
  // cmd /s strips exactly the outer quotes; the redirect needs cmd at all.
  const commandLine = `cmd.exe /d /s /c "${[...spec.program.map(quoted), ">>", quoted(spec.logPath), "2>&1"].join(" ")}"`;
  return [
    "' Written by Tau for its host service; replaced on every install.",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "Set env = shell.Environment(\"PROCESS\")",
    ...Object.entries(spec.env).filter(([key]) => key !== "PATH").map(([key, value]) => `env(${vbs(key)}) = ${vbs(value)}`),
    `shell.CurrentDirectory = ${vbs(spec.workingDirectory)}`,
    `WScript.Quit shell.Run(${vbs(commandLine)}, 0, True)`,
    "",
  ].join("\r\n");
}

/** The task: at logon of this user, one instance, no time limit, restarted after a failure. */
export function renderWindowsTask(input: { user: string; launcherPath: string }): string {
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo><Description>Tau host</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(input.user)}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${xml(input.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //NoLogo ${xml(`"${input.launcherPath}"`)}</Arguments></Exec></Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

/** `schtasks /XML` reads UTF-16 with a byte-order mark. */
export function utf16WithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}
