import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UiHostServiceProblem } from "../shared/connections.js";

export interface SandboxProbes {
  stat(path: string): { uid: number; mode: number } | undefined;
  read(path: string): string | undefined;
}

const probes: SandboxProbes = {
  stat: (path) => {
    try {
      return statSync(path);
    } catch {
      return undefined;
    }
  },
  read: (path) => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return undefined;
    }
  },
};

export const SANDBOX_PROBLEM = "chrome-sandbox";
const APPARMOR_DIRECTORY = "/etc/apparmor.d";
/** Where the .deb installs Tau; its own profile (electron-builder's template) has this name. */
const PACKAGE_EXECUTABLE = "/opt/Tau/tau";

/** Whether this kernel refuses Chromium's user-namespace sandbox to an unprivileged process. */
function userNamespacesRestricted(read: SandboxProbes["read"]): boolean {
  return read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1"
    || read("/proc/sys/kernel/unprivileged_userns_clone") === "0"
    || read("/proc/sys/user/max_user_namespaces") === "0";
}

/** One profile per path, so a .deb and an unpacked copy never replace each other's. */
export function sandboxProfileName(execPath: string): string {
  return execPath === PACKAGE_EXECUTABLE ? "tau" : `tau-${createHash("sha256").update(execPath).digest("hex").slice(0, 12)}`;
}

export function sandboxProfilePath(execPath: string): string {
  return `${APPARMOR_DIRECTORY}/${sandboxProfileName(execPath)}`;
}

/** Quotes, backslashes and glob characters would change what the attachment matches. */
const PLAIN_PATH = /^\/[\p{L}\p{N}_./+@,:~ -]+$/u;

/**
 * electron-builder's `apparmor-profile.tpl` for this path: the binary may
 * create user namespaces and is otherwise unconfined. Undefined for a path a
 * profile cannot name as it is.
 */
export function renderSandboxProfile(execPath: string): string | undefined {
  if (!PLAIN_PATH.test(execPath)) return undefined;
  const name = sandboxProfileName(execPath);
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile "${name}" "${execPath}" flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${name}>`,
    "}",
    "",
  ].join("\n");
}

/**
 * The AppArmor profile this process runs under, from `attr/apparmor/current`
 * (Linux 5.8+) or `attr/current`; undefined when it is unconfined.
 */
export function apparmorProfile(read: SandboxProbes["read"], pid: number | "self" = "self"): string | undefined {
  const label = read(`/proc/${pid}/attr/apparmor/current`) ?? read(`/proc/${pid}/attr/current`);
  const match = label ? /^(.+?) \([\w-]+\)$/u.exec(label.replace(/\0/gu, "").trim()) : undefined;
  return match?.[1];
}

/** A profile file that attaches to exactly this path and allows user namespaces. */
function profileAllows(text: string | undefined, execPath: string): boolean {
  return !!text && text.includes(`"${execPath}"`) && /^\s*userns,/mu.test(text);
}

/**
 * Where the kernel restricts user namespaces (Ubuntu 24.04+), Chromium needs
 * an AppArmor profile that allows them for Tau's binary, or `chrome-sandbox`
 * as root with the setuid bit; it aborts at start otherwise. The profile is
 * either the one this process runs under or one on disk for new processes.
 */
export function chromeSandboxProblem(execPath: string, probe: SandboxProbes = probes): UiHostServiceProblem | undefined {
  const helper = join(dirname(execPath), "chrome-sandbox");
  const stat = probe.stat(helper);
  if (!stat || (stat.uid === 0 && (stat.mode & 0o4000) !== 0)) return undefined;
  if (!userNamespacesRestricted(probe.read)) return undefined;
  const name = sandboxProfileName(execPath);
  if (apparmorProfile(probe.read) === name) return undefined;
  if (profileAllows(probe.read(`${APPARMOR_DIRECTORY}/${name}`), execPath)) return undefined;
  if (!renderSandboxProfile(execPath)) {
    return {
      code: SANDBOX_PROBLEM,
      message: `The window on the invisible display cannot start: this machine restricts user namespaces, and an AppArmor profile cannot name ${execPath} (quotes, backslashes or wildcards in the path). Move Tau to a plain path, or install the .deb.`,
    };
  }
  return {
    code: SANDBOX_PROBLEM,
    message: `The window on the invisible display cannot start: this machine restricts user namespaces, and no AppArmor profile allows them for ${execPath}. Tau can add one; it asks for your password once and stays valid across updates.`,
    command: "tau service install",
  };
}

/** Runs as root: checks the profile, installs it and loads it; a profile that did not load is removed again. */
const INSTALL_PROFILE = [
  "set -e",
  "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
  "tmp=$(mktemp)",
  "trap 'rm -f \"$tmp\"' EXIT",
  "printf '%s' \"$2\" > \"$tmp\"",
  "apparmor_parser --skip-kernel-load --debug \"$tmp\" > /dev/null",
  "install -m 0644 \"$tmp\" \"$1\"",
  "apparmor_parser --replace --write-cache --skip-read-cache \"$1\" || { rm -f \"$1\"; exit 1; }",
].join("\n");

export type ElevationTool = "pkexec" | "sudo";

/** The one privileged call that writes and loads the profile for this path. */
export function sandboxProfileCommand(execPath: string, tool: ElevationTool): { command: string; args: string[] } | undefined {
  const profile = renderSandboxProfile(execPath);
  if (!profile) return undefined;
  // pkexec's own text agent would ask on a terminal the host does not have.
  const prefix = tool === "pkexec" ? ["--disable-internal-agent"] : [];
  return { command: tool, args: [...prefix, "/bin/sh", "-c", INSTALL_PROFILE, "sh", sandboxProfilePath(execPath), profile] };
}

/** What failed, in words: a dismissed dialog, no way to ask, or AppArmor's own refusal. */
export function elevationFailure(tool: ElevationTool, result: { code: number; stderr: string }): string {
  const detail = (result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "").replace(/\.$/u, "");
  const inTerminal = "In a terminal on this machine, run tau service install; it asks for your password with sudo.";
  if (/ENOENT/u.test(result.stderr)) return tool === "pkexec" ? `pkexec is not installed, so no password dialog can open. ${inTerminal}` : "sudo is not installed.";
  if (tool === "pkexec" && result.code === 126) return "The password dialog was closed; nothing changed.";
  if (tool === "pkexec" && /authentication agent|authority/iu.test(result.stderr)) {
    return `No password dialog could open on this machine (${detail}): pkexec needs a polkit agent, which a desktop session has and an SSH login does not. ${inTerminal}`;
  }
  if (tool === "sudo" && /terminal is required|no tty present|askpass/iu.test(result.stderr)) {
    return "sudo could not ask for your password: this is not a terminal. Run tau service install in a terminal on this machine.";
  }
  return `Adding the AppArmor profile failed (exit ${result.code})${detail ? `: ${detail}` : ""}.`;
}
