import { HOST_COMMANDS } from "../shared/host-command-contract.js";
import type { HostCommandAudit } from "../shared/host-command-definition.js";
import { methodAccess } from "../shared/host-method-access.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { isHostOwner, type AuditedCall, type HostInvocationPrincipal } from "./host-invocation.js";

export { HOST_METHOD_ACCESS, MACHINE_REQUEST_METHODS, isMachineRequestMethod, methodAccess, type MethodAccess } from "../shared/host-method-access.js";

export function readOnlyRefusal(action: string): Error {
  return Object.assign(new Error(`This device is paired Read only, so it may not ${action}.`), { code: HOST_ERROR.forbidden });
}

/** The refusal of an `owner` method or kit command to anyone but the host token on this machine. */
export function ownerRefusal(): Error {
  return Object.assign(new Error("Only a connection with the access key, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
}

/**
 * How a change reads in Settings → Connections, for every method that is not
 * `read` (a test holds it complete). `thread` is the index of the param that
 * names the thread; `automatic` marks a call a client makes on its own as part
 * of something else, so it never replaces the device's last change; `quiet`
 * leaves an allowed call out of the log (a refused one is still recorded).
 */
export const HOST_METHOD_AUDIT: Readonly<Record<string, HostCommandAudit | undefined>> = Object.fromEntries(
  Object.entries(HOST_COMMANDS).flatMap(([name, declaration]) => declaration.audit ? [[name, declaration.audit]] : []),
);

/** The audit record of a core method call: its label and the thread its params name. */
export function auditedMethodCall(method: string, params: readonly unknown[] = []): AuditedCall {
  const entry = HOST_METHOD_AUDIT[method];
  if (!entry) return { action: method };
  const threadId = entry.thread === undefined ? undefined : params[entry.thread];
  return {
    action: method,
    label: entry.label,
    ...(typeof threadId === "string" && threadId ? { threadId } : {}),
    ...(entry.automatic ? { automatic: true } : {}),
  };
}

/**
 * Lets a call through or refuses it, before its handler runs. A Read-only
 * device may call only `read` methods, no paired device an `owner` one; every
 * change a paired device makes, or is refused, is recorded. Kit commands are checked by the registry, which
 * knows each command's declaration.
 */
export function authorizeMethod(principal: HostInvocationPrincipal, method: string, params: readonly unknown[] = []): void {
  const access = methodAccess(method);
  if (principal.kind !== "workbench-client" || access === "read") return;
  if (access === "owner") {
    if (isHostOwner(principal)) return;
    principal.audit?.(auditedMethodCall(method), false);
    throw ownerRefusal();
  }
  if (principal.readOnly) {
    principal.audit?.(auditedMethodCall(method, params), false);
    throw readOnlyRefusal(`call ${method}`);
  }
  if (HOST_METHOD_AUDIT[method]?.quiet) return;
  principal.audit?.(auditedMethodCall(method, params), true);
}
