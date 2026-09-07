import type { HostSnapshot, ThreadBackendKind } from "../shared/contracts";

/**
 * The backend a new thread is created on: the client's choice when the host
 * offers it, else nothing, which leaves the host's default in charge.
 */
export function chosenNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined): ThreadBackendKind | undefined {
  if (!preference) return undefined;
  return snapshot?.runtimeBackends?.some((backend) => backend.kind === preference) ? preference : undefined;
}

/** What the workbench shows as the runtime of the next new thread. */
export function effectiveNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined): ThreadBackendKind {
  return chosenNewThreadRuntime(preference, snapshot) ?? snapshot?.defaultBackendKind ?? "pi";
}
