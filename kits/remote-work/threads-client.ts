import {
  REMOTE_WORK_EXTENSION_ID,
  type RemoteThreadCommands,
  type RemoteThreadDelivery,
  type RemoteThreadLink,
  type RemoteThreadStartInput,
  type RemoteThreadWaitResult,
} from "./protocol.js";

/** `context.invokeHostExtension` of the kit that calls. */
export type HostInvoke = (extensionId: string, command: string, input?: unknown) => Promise<unknown>;

/**
 * `tau.remote-work/threads` as another kit's host half sees it. Every method
 * is one host command of Remote Work Kit on this machine; the caller's id has
 * to be in `TRANSFER_CALLERS` (ADR 0020).
 */
export interface RemoteThreadsService {
  start(input: RemoteThreadStartInput): Promise<RemoteThreadLink>;
  list(filter?: { machine?: string; parentThreadId?: string; active?: boolean }): Promise<RemoteThreadLink[]>;
  get(link: string): Promise<RemoteThreadLink>;
  send(link: string, text: string, delivery?: RemoteThreadDelivery): Promise<RemoteThreadLink>;
  abort(link: string): Promise<RemoteThreadLink>;
  wait(link: string, timeoutMs?: number): Promise<RemoteThreadWaitResult>;
  fetchResult(link: string): Promise<RemoteThreadLink>;
  settle(link: string, how: "apply" | "discard"): Promise<RemoteThreadLink>;
}

export function remoteThreadsClient(invoke: HostInvoke): RemoteThreadsService {
  const call = <C extends keyof RemoteThreadCommands>(command: C, input: RemoteThreadCommands[C]["input"]) =>
    invoke(REMOTE_WORK_EXTENSION_ID, command, input) as Promise<RemoteThreadCommands[C]["output"]>;
  return {
    start: (input) => call("thread-start", input),
    list: (filter) => call("threads", filter ?? {}),
    get: (link) => call("thread", { link }),
    send: (link, text, delivery) => call("thread-send", { link, text, ...(delivery ? { delivery } : {}) }),
    abort: (link) => call("thread-abort", { link }),
    wait: (link, timeoutMs) => call("thread-wait", { link, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
    fetchResult: (link) => call("thread-result", { link }),
    settle: (link, how) => call("thread-settle", { link, how }),
  };
}
