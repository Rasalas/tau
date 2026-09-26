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

/** Whether this kernel refuses Chromium's user-namespace sandbox to an unprivileged process. */
function userNamespacesRestricted(read: SandboxProbes["read"]): boolean {
  return read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1"
    || read("/proc/sys/kernel/unprivileged_userns_clone") === "0"
    || read("/proc/sys/user/max_user_namespaces") === "0";
}

/**
 * Without user namespaces Electron needs `chrome-sandbox` as root with the
 * setuid bit, and aborts at start otherwise. Unpacking an update resets it.
 */
export function chromeSandboxProblem(execPath: string, probe: SandboxProbes = probes): UiHostServiceProblem | undefined {
  const helper = join(dirname(execPath), "chrome-sandbox");
  const stat = probe.stat(helper);
  if (!stat || (stat.uid === 0 && (stat.mode & 0o4000) !== 0)) return undefined;
  if (!userNamespacesRestricted(probe.read)) return undefined;
  const quoted = `'${helper.replaceAll("'", "'\\''")}'`;
  return {
    code: "chrome-sandbox",
    message: `The window on the invisible display cannot start: ${helper} has to belong to root with the setuid bit on this machine. Updating Tau replaces the file, so this comes back after each update.`,
    command: `sudo chown root:root ${quoted} && sudo chmod 4755 ${quoted}`,
  };
}
