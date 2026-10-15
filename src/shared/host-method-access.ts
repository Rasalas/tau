import { HOST_COMMAND_METADATA, type HostCommandName } from "./host-command-metadata.js";
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

export const HOST_METHOD_ACCESS: Readonly<Record<string, MethodAccess>> = Object.fromEntries(
  Object.entries(HOST_COMMAND_METADATA).map(([name, declaration]) => [name, declaration.access]),
);

export function methodAccess(method: string): MethodAccess {
  return HOST_METHOD_ACCESS[method] ?? "write";
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
] as const satisfies readonly HostCommandName[];

export function isMachineRequestMethod(method: string): boolean {
  return (MACHINE_REQUEST_METHODS as readonly string[]).includes(method);
}

/** What a Read-only device's control says where it is disabled, and what a call it may not make is refused with before it is sent (API 1.13.0). */
export const READ_ONLY_REASON = "Read only: this needs a device with Full access.";
