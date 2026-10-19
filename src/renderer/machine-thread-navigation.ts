import type { HostClient } from "../workbench/host-client";
import type { ThreadStore } from "../workbench/thread-store";

/** Machines Kit's agents command, named here without importing the kit. */
const MACHINES_KIT = "tau.environments";

export async function machineThreadPath(machine: string, sessionId: string, client: HostClient | undefined, threads?: Pick<ThreadStore, "getThread">): Promise<string | undefined> {
  const id = `${machine}~${sessionId}`;
  const thread = threads?.getThread(id);
  if (thread) return thread.backendKind === "machine" && thread.machine?.id === machine ? thread.path : undefined;
  if (!client?.invokeHostExtension) return undefined;
  const agents = await client.invokeHostExtension(MACHINES_KIT, "agents").catch(() => undefined) as { machines?: Array<{ id: string; status: string }> } | undefined;
  if (!agents?.machines?.some((entry) => entry.id === machine && entry.status === "connected")) return undefined;
  // Core's externalThreadPath in src/main/pi-host-support.ts defines this virtual path.
  return `tau-thread:machine:${id}`;
}

/**
 * Opens a thread of another machine: on screen when this host can run it, else
 * as a look into it beside the thread it was asked from. Asked from a thread
 * the user has left by the time the machine answers, it does neither.
 */
export async function openMachineThread(machine: string, sessionId: string, ports: {
  client: HostClient | undefined;
  threads?: Pick<ThreadStore, "getThread">;
  /** The thread or draft on screen, read now. */
  scope(): string | undefined;
  switchSession(path: string): Promise<unknown>;
  lookIn(): void;
}): Promise<void> {
  const from = ports.scope();
  const path = await machineThreadPath(machine, sessionId, ports.client, ports.threads);
  if (ports.scope() !== from) return;
  if (path) await ports.switchSession(path);
  else ports.lookIn();
}
