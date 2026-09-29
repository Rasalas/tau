import type { UpdateChannel } from "./app-version.js";
import { compareVersions } from "./runtime-version.js";

/**
 * A machine's own Tau updates (K103): what the host process reports about
 * the version it runs and the newest release on its channel. One shape for
 * the window, the phone and `tau machines update`.
 */
export type HostUpdatePhase =
  /** This copy cannot update itself; `reason` says why. */
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  /** Downloaded and verified; installs at the next quiet moment or on request. */
  | "ready"
  /** Asked to install; waits for the running turns to end. */
  | "waiting"
  | "installing"
  /** Installed; the host restarts into it, or the next start runs it. */
  | "installed"
  | "failed";

/** How this machine installs: its host process, a Tau window on it, or not at all. */
export type HostUpdateInstaller = "host" | "window" | "none";

export type HostUpdateMethod = "deb" | "appimage" | "mac" | "windows";

export interface HostUpdateStatus {
  /** The version the host runs. */
  version: string;
  phase: HostUpdatePhase;
  /** The newest release the last check saw on the channel. */
  latest?: string;
  channel: UpdateChannel;
  /** Checks, downloads and installs on its own at a quiet moment. */
  automatic: boolean;
  installer: HostUpdateInstaller;
  method?: HostUpdateMethod;
  /** Why it cannot update, what failed, or what it waits for. */
  reason?: string;
  /** 0–100 while downloading. */
  progress?: number;
  /** Turns running while it waits to install. */
  runningTurns?: number;
  /** When the last check finished (epoch ms). */
  checkedAt?: number;
  /** Paired devices with Full access may start an install; the owner can turn that off. */
  devicesMayInstall: boolean;
}

/** What `update-settings` changes; `devicesMayInstall` only with the host token. */
export interface HostUpdateSettings {
  automatic?: boolean;
  devicesMayInstall?: boolean;
}

/** What a window asks of another machine's Tau (`environments-update`): a look, a check, an install, or turning automatic updates on or off. */
export type HostUpdateAction = "status" | "check" | "install" | { automatic: boolean };

/** The protocol's method names; `update-status` is also the push event's type. */
export const HOST_UPDATE_METHODS = {
  status: "update-status",
  check: "update-check",
  install: "update-install",
  settings: "update-settings",
} as const;

const PHASES = new Set<HostUpdatePhase>(["unsupported", "idle", "checking", "current", "available", "downloading", "ready", "waiting", "installing", "installed", "failed"]);

/** A status from another machine's host, or undefined when it is not one. */
export function decodeHostUpdateStatus(value: unknown): HostUpdateStatus | undefined {
  const item = value as Partial<HostUpdateStatus> | undefined;
  if (!item || typeof item !== "object" || typeof item.version !== "string" || !PHASES.has(item.phase as HostUpdatePhase)) return undefined;
  const text = (key: keyof HostUpdateStatus) => typeof item[key] === "string" ? { [key]: (item[key] as string).slice(0, 500) } : {};
  const number = (key: keyof HostUpdateStatus) => typeof item[key] === "number" && Number.isFinite(item[key]) ? { [key]: item[key] } : {};
  return {
    version: item.version.slice(0, 80),
    phase: item.phase as HostUpdatePhase,
    channel: item.channel === "nightly" ? "nightly" : "stable",
    automatic: item.automatic === true,
    installer: item.installer === "host" || item.installer === "window" ? item.installer : "none",
    devicesMayInstall: item.devicesMayInstall === true,
    ...(item.method === "deb" || item.method === "appimage" || item.method === "mac" || item.method === "windows" ? { method: item.method } : {}),
    ...text("latest"),
    ...text("reason"),
    ...number("progress"),
    ...number("runningTurns"),
    ...number("checkedAt"),
  } as HostUpdateStatus;
}

/** A newer release is known and not installed yet. */
export function hostUpdatePending(status: HostUpdateStatus | undefined): boolean {
  if (!status) return false;
  if (status.phase === "installed" || status.phase === "unsupported") return false;
  return Boolean(status.latest && compareVersions(status.version, status.latest) < 0);
}

/**
 * A machine is behind when its host says so, or when it runs an older Tau
 * than `reference` (the window's own). A host too old to report a status is
 * judged by its version alone.
 */
export function machineBehind(machine: { hostVersion?: string; update?: HostUpdateStatus }, reference?: string): boolean {
  if (hostUpdatePending(machine.update)) return true;
  const version = machine.update?.version ?? machine.hostVersion;
  return Boolean(version && reference && compareVersions(version, reference) < 0);
}

/** One line for a status, as Settings and the command line say it. */
export function describeHostUpdate(status: HostUpdateStatus): string {
  switch (status.phase) {
    case "unsupported": return status.reason ?? "This copy of Tau cannot update itself.";
    case "idle": return status.automatic ? "Checks for updates on its own." : "Automatic updates are off.";
    case "checking": return "Checking for updates…";
    case "current": return "Up to date.";
    case "available": return `Tau ${status.latest} is available.`;
    case "downloading": return `Downloading Tau ${status.latest}${status.progress !== undefined ? ` (${status.progress}%)` : ""}…`;
    case "ready": return `Tau ${status.latest} is downloaded and installs when no turn runs.`;
    case "waiting": return `Tau ${status.latest} installs when ${status.runningTurns === 1 ? "the running turn ends" : `${status.runningTurns ?? "the"} running turns end`}.`;
    case "installing": return `Installing Tau ${status.latest}…`;
    case "installed": return status.reason ?? `Tau ${status.latest} is installed.`;
    case "failed": return `The update failed: ${status.reason ?? "unknown error"}`;
  }
}
