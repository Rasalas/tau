import { HOST_ERROR } from "../shared/host-transport.js";
import { isHostOwner, type HostInvocationPrincipal } from "./host-invocation.js";

/**
 * What each host method does, for a device paired Read only (ADR 0024).
 * `read` only looks; `write` changes something on the host, runs something,
 * or reaches the host machine's own screen or clipboard; `owner` manages
 * access and is refused to every paired device and to the host token over a
 * LAN or proxy listener. A method missing here counts
 * as `write`, and a test fails until it is classified.
 */
export type MethodAccess = "read" | "write" | "owner";

export const HOST_METHOD_ACCESS = {
  "bootstrap": "read",
  "transcript-page": "read",
  "prepare-prompt": "write",
  "prompt": "write",
  "run-shell-action": "write",
  "steer": "write",
  "follow-up": "write",
  "queue-message": "write",
  "take-queued": "write",
  "move-queued": "write",
  "resume-limited": "write",
  "abort": "write",
  "new-session": "write",
  "prepared-thread-capability": "read",
  "fork-thread": "write",
  "thread-tree": "read",
  "navigate-thread-tree": "write",
  "duplicate-thread": "write",
  // Looking at another thread makes it the active one; it starts no turn and changes no thread.
  "switch-session": "read",
  "set-model": "write",
  "set-thinking": "write",
  "set-mode": "write",
  "compact-context": "write",
  "reload-runtime": "write",
  "reload-extensions": "write",
  "answer-extension-ui": "write",
  "sync-extension-ui": "read",
  "recover-thread": "write",
  "rename-thread": "write",
  // The clipboard, notifications, badge, menus and window of the host's machine, not the device's.
  "copy-text": "write",
  "copy-image": "write",
  "notify": "write",
  "set-badge": "write",
  "context-menu": "write",
  "window-action": "write",
  "read-tool-output": "read",
  "tool-output": "read",
  "copy-thread-markdown": "read",
  "read-image-preview": "read",
  "share-file": "read",
  // The extension registry decides per command (`registerCommand(…, { access: "read" })`).
  "host-extension": "read",
  "host-extensions": "read",
  "inspect-extensions": "read",
  "host-extension-active": "write",
  "extension-grant": "write",
  "prepare-workbench-reload": "write",
  "release-workbench-reload": "write",
  "desktop-extensions": "read",
  "rebuild-workbench": "write",
  "workbench-source": "read",
  "relaunch-workbench": "write",
  "install-update": "write",
  // Adds the folder to the host's projects and runs the kits' workspace hooks.
  "open-project": "write",
  "remove-project": "write",
  "get-config": "read",
  "update-config": "write",
  "get-config-layers": "read",
  "clear-config": "write",
  // Names and whether a key is set, never the key.
  "get-models-config": "read",
  "runtime-catalog": "read",
  "runtime-catalogs": "read",
  "add-model-provider": "write",
  "inspect-system-prompt": "read",
  "list-user-themes": "read",
  "open-external-editor": "write",
  // Each checks its caller besides.
  "connections-list": "owner",
  "connections-create-link": "owner",
  "connections-revoke-link": "owner",
  "connections-revoke-client": "owner",
  "connections-revoke-others": "owner",
  "connections-update-client": "owner",
  "connections-approve": "owner",
  "connections-deny": "owner",
  "connections-rotate-host-token": "owner",
  "connections-set-network": "owner",
  "connections-reload-certificate": "owner",
  "connections-discover": "owner",
  "host.shutdown": "owner",
  // Only the connection a call went to may answer it; the answer changes nothing else.
  "client-call-result": "read",
  // The job's own method is checked when it starts.
  "start-job": "read",
  "cancel-job": "write",
  "job-methods": "read",
} as const satisfies Record<string, MethodAccess>;

export function methodAccess(method: string): MethodAccess {
  return (HOST_METHOD_ACCESS as Record<string, MethodAccess | undefined>)[method] ?? "write";
}

export function readOnlyRefusal(action: string): Error {
  return Object.assign(new Error(`This device is paired Read only, so it may not ${action}.`), { code: HOST_ERROR.forbidden });
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
    throw Object.assign(new Error("Only a connection with the host token, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
  }
  if (principal.readOnly) {
    principal.audit?.(method, false);
    throw readOnlyRefusal(`call ${method}`);
  }
  principal.audit?.(method, true);
}
