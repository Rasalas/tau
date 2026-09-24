import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiHostService } from "../shared/connections.js";
import { HostServiceManager } from "./host-service.js";
import { defaultUserData } from "./host-service-units.js";

/**
 * `tau service install|status|uninstall|restart`. `bin/tau.mjs` runs this
 * with the app's own binary as Node, so the unit names exactly the binary and
 * the host entry a window of this app starts.
 */

export const SERVICE_ACTIONS = ["install", "status", "uninstall", "restart"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export interface ServiceCliIo {
  out(line: string): void;
  manager: Pick<HostServiceManager, "status" | "install" | "uninstall" | "restart">;
}

const MANAGER_NAMES: Record<string, string> = { launchd: "launchd", systemd: "systemd", "task-scheduler": "Task Scheduler" };

export function describeService(status: UiHostService): string[] {
  if (!status.supported) return [`Tau's host cannot run as a service here: ${status.reason ?? "no service manager."}`];
  const lines = [
    `Tau host service (${MANAGER_NAMES[status.manager ?? ""] ?? status.manager}, ${status.label})`,
    `  installed: ${status.installed ? (status.stale ? "yes, but for another copy or other settings of Tau (run tau service install)" : "yes") : "no"}`,
    `  running:   ${status.running ? `yes${status.version ? `, Tau ${status.version}` : ""}` : "no"}`,
    ...(status.unitPath ? [`  unit:      ${status.unitPath}`] : []),
    `  log:       ${status.logPath}`,
  ];
  for (const problem of status.problems) {
    lines.push(`  ! ${problem.message}`);
    if (problem.command) lines.push(`    ${problem.command}`);
  }
  return lines;
}

export async function runServiceCommand(action: string | undefined, io: ServiceCliIo): Promise<number> {
  if (!action || !(SERVICE_ACTIONS as readonly string[]).includes(action)) {
    io.out(`Usage: tau service <${SERVICE_ACTIONS.join("|")}>`);
    return action ? 1 : 0;
  }
  const { manager } = io;
  if (action === "install") {
    await manager.install();
    io.out("Installed. The service starts Tau's host now and at every login; a running Tau window moves over to it.");
  } else if (action === "uninstall") {
    io.out(await manager.uninstall() ? "Uninstalled. The next Tau window starts a host of its own." : "No service was installed.");
    return 0;
  } else if (action === "restart") {
    await manager.restart();
    io.out("Restarted.");
  }
  for (const line of describeService(await manager.status())) io.out(line);
  return 0;
}

function invokedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const userData = process.env.TAU_USER_DATA || defaultUserData(process.platform, homedir(), process.env);
  const manager = new HostServiceManager({
    execPath: process.execPath,
    entry: join(dirname(fileURLToPath(import.meta.url)), "headless.js"),
    userData,
  });
  runServiceCommand(process.argv[2], { out: (line) => process.stdout.write(`${line}\n`), manager }).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`tau service: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
