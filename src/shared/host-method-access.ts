/**
 * What each host method does, for a device paired Read only (ADR 0024).
 * `read` only looks; `write` changes something on the host, runs something,
 * or reaches the host machine's own screen or clipboard; `owner` manages
 * access and is refused to every paired device and to the host token over a
 * LAN or proxy listener. A method missing here counts
 * as `write`, and a test fails until it is classified. Shared so a client can
 * refuse before it sends (API 1.13.0).
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
  "thread-goal": "write",
  "abort": "write",
  "new-session": "write",
  "start-thread": "write",
  "send-to-thread": "write",
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
  "restart-session": "write",
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
  // This machine's own Tau (K103): anyone may look; installing also needs the owner's leave for devices.
  "update-status": "read",
  "update-check": "read",
  "update-install": "write",
  "update-settings": "write",
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
  // Refresh asks the programs again, as a picker that opens does; running a package manager is the owner's.
  "runtime-tools": "read",
  "runtime-tools-change": "owner",
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
  // The machines this host's agents reach (ADR 0027): their keys are the owner's, like the host token.
  "machines-list": "owner",
  "machines-add": "owner",
  "machines-remove": "owner",
  // `tau machines`: the window's machines and the agents' in one list, pairing with a link, forgetting.
  "machines-overview": "owner",
  "machines-pair": "owner",
  "connect-status": "owner",
  "connect-configure": "owner",
  "connect-link": "owner",
  "connect-remove": "owner",
  "machines-forget": "owner",
  // `tau machines update`: another machine's Tau through the window's connection there (K103).
  "machines-update": "owner",
  // Another machine's agents send a file in pieces (plan-H); a Read-only device may not.
  "blob-put": "write",
  "blob-commit": "write",
  "blob-abort": "write",
  // The host's machine running it as a service: whether it does is anyone's to see, changing it the owner's.
  "service-status": "read",
  // How busy the machine is and what it could run; asked for, never pushed.
  "host-resources": "read",
  "readiness": "read",
  "service-install": "owner",
  "service-uninstall": "owner",
  "service-allow-sandbox": "owner",
  // A window's own list of machines (ADR 0025); a host refuses them all.
  "environments-list": "read",
  "environments-take-arrival": "read",
  "environments-pair": "write",
  "environments-cancel-pairing": "write",
  "environments-rename": "write",
  "environments-remove": "write",
  "environments-retry": "write",
  "environments-open": "write",
  "environments-discover": "write",
  "environments-wsl-list": "read",
  "environments-set-preferences": "write",
  "environments-set-agents": "write",
  // Another machine's own Tau, with the window's key there; that machine decides (K103).
  "environments-update": "write",
  // Reading another machine's thread over the window's own connection to it; its key decides there.
  "environments-transcript-page": "read",
  "environments-watch-thread": "read",
  "environments-extension-read": "read",
  "environments-extension-invoke": "write",
  "environments-extension-follow": "read",
  // This window's own machine's look, read and written with its own key.
  "environments-person-preferences": "read",
  "environments-set-person-preferences": "write",
  // Another machine's settings at its machine level, with the window's own key there (K170); that machine decides.
  "environments-config": "read",
  "environments-update-config": "write",
  "environments-clear-config": "write",
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

/**
 * What a host may ask another machine's host on its threads' behalf
 * (`services.machines.request`, ADR 0027): reading, starting or continuing a
 * thread there, answering its questions, steering or stopping its run, what models
 * it offers, and how busy and how ready that machine is. A kit's own commands go through `call`; access
 * management, jobs, subscriptions and a window's methods never go.
 */
export const MACHINE_REQUEST_METHODS = [
  "transcript-page",
  "thread-tree",
  "tool-output",
  "abort",
  "steer",
  "follow-up",
  "start-thread",
  "send-to-thread",
  "answer-extension-ui",
  "sync-extension-ui",
  "runtime-catalog",
  "host-resources",
  "readiness",
] as const satisfies readonly (keyof typeof HOST_METHOD_ACCESS)[];

export function isMachineRequestMethod(method: string): boolean {
  return (MACHINE_REQUEST_METHODS as readonly string[]).includes(method);
}

/** What a Read-only device's control says where it is disabled, and what a call it may not make is refused with before it is sent (API 1.13.0). */
export const READ_ONLY_REASON = "Read only: this needs a device with Full access.";
