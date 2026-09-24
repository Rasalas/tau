import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Provenance the main process can actually distinguish for a host command.
 * Desktop extensions share one renderer, so their names never appear here.
 */
export type HostInvocationPrincipal =
  | {
    readonly kind: "workbench-client";
    /** The socket connection it came on, when it came on one. */
    readonly connection?: string;
    /** Set when the hello carried a paired client's token rather than the host token. */
    readonly pairedClient?: string;
  }
  | { readonly kind: "host-core" }
  | { readonly kind: "host-extension"; readonly contextId: string };

/** The authenticated renderer/socket client. It is one workbench principal. */
export const WORKBENCH_CLIENT_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "workbench-client" });

/** Existing host-owned calls, including Pi's internal counterpart calls. */
export const HOST_CORE_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "host-core" });

/**
 * Whether a caller may manage who reaches the host: a connection with the
 * host token, the in-process window, or the host itself. A paired client may
 * use the host but not hand out or take away access.
 */
export function isHostOwner(principal: HostInvocationPrincipal): boolean {
  return principal.kind === "host-core" || (principal.kind === "workbench-client" && principal.pairedClient === undefined);
}

/** The connection whose request is running; `active` ends with the request, not with its async leftovers. */
const callerScope = new AsyncLocalStorage<{ readonly connection: string; active: boolean }>();

/**
 * Runs `run` on behalf of a socket client, so a call into a window made on the
 * way reaches that client's own window first (ADR 0023). Other principals keep
 * the caller of the request they run inside.
 */
export async function runAsCaller<T>(principal: HostInvocationPrincipal, run: () => Promise<T>): Promise<T> {
  const connection = principal.kind === "workbench-client" ? principal.connection : undefined;
  if (!connection) return run();
  const scope = { connection, active: true };
  try {
    return await callerScope.run(scope, run);
  } finally {
    scope.active = false;
  }
}

/** The socket connection whose request is running right now, if any. */
export function currentCaller(): string | undefined {
  const scope = callerScope.getStore();
  return scope?.active ? scope.connection : undefined;
}
