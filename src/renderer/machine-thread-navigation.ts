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
