import { randomUUID } from "node:crypto";
import type { HostClientCall } from "../shared/host-transport.js";
import type { DirectoryPickerOptions } from "./host-extensions.js";
import { currentCaller } from "./host-invocation.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";

/** A client half that never answers must not hold a tool call forever. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The folder dialog waits on the user. */
const PICK_DIRECTORY_TIMEOUT_MS = 10 * 60_000;

/** What the transport knows about one authenticated connection. */
export interface ClientPeer {
  /** The paired client it said hello as; absent for the host token. */
  pairedClient?: string;
  /** On the host's own machine (loopback). */
  local: boolean;
  /** Shared by a window's renderer and the window's process. */
  windowId?: string;
  /** Extensions whose window half this connection runs. */
  windowHalves?: readonly string[];
}

export interface ClientCallOptions {
  /** Overrides the default for a call that waits on the user, like a dialog. */
  timeoutMs?: number;
  /** Only the caller's own window may answer; the host's window is not asked instead. */
  callerOnly?: boolean;
}

interface PendingCall {
  /** The one connection whose answer counts. */
  addressee: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Calls that travel the other way: from the host to the process a client runs
 * in. A host extension whose work needs a window — a native view over the
 * panel, say — asks for it here, and the window's half answers with the
 * `client-call-result` method (ADR 0021).
 *
 * Each call goes to exactly one connection and only that connection's answer
 * counts (ADR 0023): the caller's own window, else the host token's window on
 * this machine. With neither the call fails at once.
 */
export class ClientCalls {
  private readonly pending = new Map<string, PendingCall>();
  /** In attach order, so the newest window on this machine is found last. */
  private readonly peers = new Map<string, ClientPeer>();

  /** `send` answers false when the connection can no longer be written to. */
  constructor(
    private readonly send: (connection: string, call: HostClientCall) => boolean,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  attach(connection: string, peer: ClientPeer): void {
    this.peers.delete(connection);
    this.peers.set(connection, peer);
  }

  /** A connection that went away cannot answer; what it was asked fails now. */
  detach(connection: string): void {
    this.peers.delete(connection);
    for (const [callId, call] of this.pending) {
      if (call.addressee === connection) this.settle(callId, undefined, "The window that was asked disconnected.", connection);
    }
  }

  /** `caller` defaults to the connection whose request is running. */
  call(extensionId: string, command: string, input?: unknown, options: ClientCallOptions = {}, caller: string | undefined = currentCaller()): Promise<unknown> {
    const addressee = this.addressee(extensionId, caller, options.callerOnly === true);
    if (!addressee) return Promise.reject(new Error(noWindow(extensionId, caller !== undefined && options.callerOnly === true)));
    const callId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`No window answered ${extensionId}/${command} within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(callId, { addressee, resolve, reject, timer });
      if (!this.send(addressee, { callId, extensionId, command, ...(input === undefined ? {} : { input }) })) {
        this.settle(callId, undefined, "The window that was asked disconnected.", addressee);
      }
    });
  }

  /**
   * The window's own folder picker (core's half, not a kit's). Only the asking
   * client's window shows it: a browser or a phone must not open a dialog on
   * the host's screen and get the answer.
   */
  async pickDirectory(options?: DirectoryPickerOptions, caller: string | undefined = currentCaller()): Promise<string | undefined> {
    const path = await this.call(WINDOW_SERVICES_ID, "pick-directory", options, { timeoutMs: PICK_DIRECTORY_TIMEOUT_MS, callerOnly: true }, caller);
    return typeof path === "string" ? path : undefined;
  }

  /**
   * An answer from connection `from`. One for an unknown id, or from anyone
   * but the addressee, is dropped without a word: a late reply, or a forgery.
   */
  settle(callId: string, result: unknown, error: string | undefined, from: string | undefined): void {
    const call = this.pending.get(callId);
    if (!call || from === undefined || call.addressee !== from) return;
    this.pending.delete(callId);
    clearTimeout(call.timer);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  }

  /** Every waiting call fails at once; used when the host stops. */
  dispose(): void {
    for (const [callId, call] of this.pending) this.settle(callId, undefined, "The host stopped waiting for this client.", call.addressee);
  }

  private addressee(extensionId: string, caller: string | undefined, callerOnly: boolean): string | undefined {
    const own = caller === undefined ? undefined : this.ownWindow(caller, extensionId);
    if (own || callerOnly && caller !== undefined) return own;
    // Never a paired client's window: it gets only the calls it caused itself.
    let local: string | undefined;
    for (const [connection, peer] of this.peers) {
      if (peer.local && peer.pairedClient === undefined && peer.windowHalves?.includes(extensionId)) local = connection;
    }
    return local;
  }

  /** The caller itself, or the window process beside the caller's renderer, holding the same credential. */
  private ownWindow(caller: string, extensionId: string): string | undefined {
    const peer = this.peers.get(caller);
    if (!peer) return undefined;
    if (peer.windowHalves?.includes(extensionId)) return caller;
    if (!peer.windowId) return undefined;
    let found: string | undefined;
    for (const [connection, other] of this.peers) {
      if (other.windowId === peer.windowId && other.pairedClient === peer.pairedClient && other.windowHalves?.includes(extensionId)) found = connection;
    }
    return found;
  }
}

function noWindow(extensionId: string, callerOnly: boolean): string {
  if (callerOnly) return "This client has no window that can answer this; open it in the Tau desktop app.";
  return `No Tau window on this host has the window half of ${extensionId}.`;
}
