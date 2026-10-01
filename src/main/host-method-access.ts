import { methodAccess } from "../shared/host-method-access.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { isHostOwner, type AuditedCall, type HostInvocationPrincipal } from "./host-invocation.js";

export { HOST_METHOD_ACCESS, MACHINE_REQUEST_METHODS, isMachineRequestMethod, methodAccess, type MethodAccess } from "../shared/host-method-access.js";

export function readOnlyRefusal(action: string): Error {
  return Object.assign(new Error(`This device is paired Read only, so it may not ${action}.`), { code: HOST_ERROR.forbidden });
}

/** The refusal of an `owner` method or kit command to anyone but the host token on this machine. */
export function ownerRefusal(): Error {
  return Object.assign(new Error("Only a connection with the host token, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
}

/**
 * How a change reads in Settings → Connections, for every method that is not
 * `read` (a test holds it complete). `thread` is the index of the param that
 * names the thread; `automatic` marks a call a client makes on its own as part
 * of something else, so it never replaces the device's last change; `quiet`
 * leaves an allowed call out of the log (a refused one is still recorded).
 */
export const HOST_METHOD_AUDIT: Readonly<Record<string, { label: string; thread?: number; automatic?: true; quiet?: true }>> = {
  "prepare-prompt": { label: "prepared a prompt", thread: 1, automatic: true },
  "prompt": { label: "sent a prompt", thread: 2 },
  "run-shell-action": { label: "ran a shell command" },
  "steer": { label: "steered a run", thread: 2 },
  "follow-up": { label: "sent a follow-up", thread: 2 },
  "queue-message": { label: "queued a message", thread: 0 },
  "take-queued": { label: "took a queued message", thread: 0 },
  "move-queued": { label: "reordered queued messages", thread: 0 },
  "resume-limited": { label: "resumed a thread after a limit", thread: 0 },
  "abort": { label: "stopped a run", thread: 0 },
  "new-session": { label: "started a thread" },
  "start-thread": { label: "started a thread" },
  "send-to-thread": { label: "sent a message to a thread", thread: 0 },
  "fork-thread": { label: "forked a thread", thread: 1 },
  "navigate-thread-tree": { label: "moved within a thread's tree", thread: 2 },
  "duplicate-thread": { label: "duplicated a thread", thread: 0 },
  "set-model": { label: "changed the model" },
  "set-thinking": { label: "changed the thinking level" },
  "set-mode": { label: "changed the mode", thread: 1 },
  "compact-context": { label: "compacted the context" },
  "reload-runtime": { label: "reloaded the runtime" },
  "reload-extensions": { label: "reloaded extensions" },
  "answer-extension-ui": { label: "answered a question" },
  "recover-thread": { label: "recovered a thread" },
  "rename-thread": { label: "renamed a thread", thread: 1 },
  "copy-text": { label: "copied text on the host" },
  "copy-image": { label: "copied an image on the host" },
  "notify": { label: "showed a notification on the host" },
  "set-badge": { label: "set the app badge" },
  "context-menu": { label: "opened a menu on the host" },
  "window-action": { label: "used the host's window" },
  "host-extension-active": { label: "turned an extension on or off" },
  "extension-grant": { label: "changed an extension's grant" },
  "prepare-workbench-reload": { label: "reloaded the workbench" },
  "release-workbench-reload": { label: "finished reloading the workbench", automatic: true },
  "rebuild-workbench": { label: "rebuilt the workbench" },
  "relaunch-workbench": { label: "relaunched the workbench" },
  "install-update": { label: "installed an update" },
  "update-install": { label: "started a Tau update" },
  "update-settings": { label: "changed automatic updates" },
  "open-project": { label: "opened a project" },
  "remove-project": { label: "removed a project" },
  "update-config": { label: "changed settings" },
  "clear-config": { label: "reset settings" },
  "add-model-provider": { label: "added a model provider" },
  "open-external-editor": { label: "opened an external editor" },
  "environments-pair": { label: "paired a machine" },
  "environments-cancel-pairing": { label: "cancelled pairing a machine" },
  "environments-rename": { label: "renamed a machine" },
  "environments-remove": { label: "removed a machine" },
  "environments-retry": { label: "reconnected a machine" },
  "environments-open": { label: "opened a machine" },
  "environments-discover": { label: "looked for machines" },
  "environments-set-preferences": { label: "changed machine preferences" },
  "environments-set-agents": { label: "changed where this machine's agents may work" },
  "environments-extension-invoke": { label: "ran a command on another machine" },
  "environments-update": { label: "updated a machine's Tau" },
  "environments-set-person-preferences": { label: "changed how the workbench looks", automatic: true, quiet: true },
  "cancel-job": { label: "cancelled a job" },
  // One entry per file, not per 8 MB piece.
  "blob-put": { label: "sent part of a file", automatic: true, quiet: true },
  "blob-commit": { label: "sent a file" },
  "blob-abort": { label: "cancelled sending a file", automatic: true },
};

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
