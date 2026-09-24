import { methodAccess } from "../shared/host-method-access.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { isHostOwner, type HostInvocationPrincipal } from "./host-invocation.js";

export { HOST_METHOD_ACCESS, methodAccess, type MethodAccess } from "../shared/host-method-access.js";

export function readOnlyRefusal(action: string): Error {
  return Object.assign(new Error(`This device is paired Read only, so it may not ${action}.`), { code: HOST_ERROR.forbidden });
}

/** The refusal of an `owner` method or kit command to anyone but the host token on this machine. */
export function ownerRefusal(): Error {
  return Object.assign(new Error("Only a connection with the host token, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
}

/**
 * Lets a call through or refuses it, before its handler runs. A Read-only
 * device may call only `read` methods, no paired device an `owner` one; every
 * change a paired device makes, or is refused, is recorded. Kit commands are checked by the registry, which
 * knows each command's declaration.
 */
export function authorizeMethod(principal: HostInvocationPrincipal, method: string): void {
  const access = methodAccess(method);
  if (principal.kind !== "workbench-client" || access === "read") return;
  if (access === "owner") {
    if (isHostOwner(principal)) return;
    principal.audit?.(method, false);
    throw ownerRefusal();
  }
  if (principal.readOnly) {
    principal.audit?.(method, false);
    throw readOnlyRefusal(`call ${method}`);
  }
  principal.audit?.(method, true);
}
