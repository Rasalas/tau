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
