/**
 * Provenance the main process can actually distinguish for a host command.
 * Desktop extensions share one renderer, so their names never appear here.
 */
export type HostInvocationPrincipal =
  | { readonly kind: "workbench-client" }
  | { readonly kind: "host-core" }
  | { readonly kind: "host-extension"; readonly contextId: string };

/** The authenticated renderer/socket client. It is one workbench principal. */
export const WORKBENCH_CLIENT_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "workbench-client" });

/** Existing host-owned calls, including Pi's internal counterpart calls. */
export const HOST_CORE_PRINCIPAL: HostInvocationPrincipal = Object.freeze({ kind: "host-core" });
