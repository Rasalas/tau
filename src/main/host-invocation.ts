import { AsyncLocalStorage } from "node:async_hooks";

/** A call a paired device made, as its audit records it; never the input. */
export interface AuditedCall {
  /** The method, or `<extension>/<command>`. */
  readonly action: string;
  /** How it reads for a person: "sent a prompt". */
  readonly label?: string;
  /** The thread it acted on, when the call names one. */
  readonly threadId?: string;
  /** Sent by the client on its own after something the user did (a title after a prompt): logged, never the last change. */
  readonly automatic?: boolean;
}

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
    /** The device is paired Read only: every call that changes something is refused (ADR 0024). Set per request. */
    readonly readOnly?: true;
    /** Records a change the device made, or was refused; the transport sets it for paired clients. */
    readonly audit?: (call: AuditedCall, allowed: boolean) => void;
    /** The socket came from this machine through the loopback listener. */
    readonly local?: true;
  }
  | { readonly kind: "host-core" }
  | { readonly kind: "host-extension"; readonly contextId: string };

/** The authenticated renderer/socket client. It is one workbench principal. */
export const WORKBENCH_CLIENT_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "workbench-client" });

/** Existing host-owned calls, including Pi's internal counterpart calls. */
export const HOST_CORE_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "host-core" });

/**
 * Whether a caller may manage who reaches the host: the host itself, the
 * in-process window, or a socket connection with the host token from this
 * machine through the loopback listener. The host token over a LAN or proxy
 * listener uses the host but manages nothing (ADR 0024); neither does a
 * paired device.
 */
export function isHostOwner(principal: HostInvocationPrincipal): boolean {
  if (principal.kind === "host-core") return true;
  if (principal.kind !== "workbench-client" || principal.pairedClient !== undefined) return false;
  return principal.connection === undefined || principal.local === true;
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
