import { randomUUID } from "node:crypto";
import type { HostClientCall } from "../shared/host-transport.js";
import type { DirectoryPickerOptions } from "./host-extensions.js";
import { currentCaller } from "./host-invocation.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";
import { DISPLAY_WINDOW_ATTACH_TIMEOUT_MS } from "./display-window.js";

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

/**
 * Which window a call may reach (API 1.13.0). `"host"`: a window on the host's
 * own machine only — the caller's, when it is one, else the newest — for work
 * on what lives on this machine. A window id from `clientWindow`: exactly that
 * window, or an immediate rejection once it is gone.
 */
export type ClientCallWindow = "host" | (string & {});

export interface ClientCallOptions {
  /** Overrides the default for a call that waits on the user, like a dialog. */
  timeoutMs?: number;
  /** Only the caller's own window may answer; the host's window is not asked instead. */
  callerOnly?: boolean;
  window?: ClientCallWindow;
}

/** The message a call to a pinned window that went away rejects with. */
export const PINNED_WINDOW_GONE = "The window this was pinned to is gone.";

/** Starts a window on this machine when a call finds none: the invisible display's (`display-window.ts`). */
export interface ClientWindowLauncher {
  ensure(): Promise<void>;
  /** A call went to a window on this machine. */
  activity(): void;
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
  private launcher: ClientWindowLauncher | undefined;
  private attachTimeoutMs = DISPLAY_WINDOW_ATTACH_TIMEOUT_MS;
  /** Calls waiting for a window the launcher started. */
  private readonly arrivals = new Set<() => void>();

  /** `send` answers false when the connection can no longer be written to. */
  constructor(
    private readonly send: (connection: string, call: HostClientCall) => boolean,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  attach(connection: string, peer: ClientPeer): void {
    this.peers.delete(connection);
    this.peers.set(connection, peer);
    if (onHostMachine(peer) && peer.windowHalves?.length) for (const arrived of [...this.arrivals]) arrived();
  }

  /** Without one, a call that finds no window fails at once. */
  setWindowLauncher(launcher: ClientWindowLauncher | undefined, attachTimeoutMs: number = DISPLAY_WINDOW_ATTACH_TIMEOUT_MS): void {
    this.launcher = launcher;
    this.attachTimeoutMs = attachTimeoutMs;
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
    const addressee = this.addressee(extensionId, caller, options);
    if (!addressee) {
      const pinned = options.window !== undefined && options.window !== "host";
      const callerOnly = caller !== undefined && options.callerOnly === true;
      if (this.launcher && !pinned && !callerOnly && !this.localWindowAttached()) return this.launchThenCall(extensionId, command, input, options, caller);
      return Promise.reject(new Error(pinned ? PINNED_WINDOW_GONE : noWindow(extensionId, callerOnly)));
    }
    if (this.launcher && onHostMachine(this.peers.get(addressee)!)) this.launcher.activity();
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

  /** Whether a window on the host's machine runs `extensionId`'s half now; unlike `call`, it never starts one. */
  hasLocalWindow(extensionId: string): boolean {
    for (const peer of this.peers.values()) if (onHostMachine(peer) && peer.windowHalves?.includes(extensionId)) return true;
    return false;
  }

  /**
   * The id of the host-machine window a call with `{ window: "host" }` would
   * reach now, for pinning later calls to it; undefined when there is none
   * or it never said its id.
   */
  clientWindow(extensionId: string, caller: string | undefined = currentCaller()): string | undefined {
    const connection = this.addressee(extensionId, caller, { window: "host" });
    return connection === undefined ? undefined : this.peers.get(connection)?.windowId;
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
    if (this.launcher && this.peers.has(from) && onHostMachine(this.peers.get(from)!)) this.launcher.activity();
    clearTimeout(call.timer);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  }

  /** Every waiting call fails at once; used when the host stops. */
  dispose(): void {
    for (const [callId, call] of this.pending) this.settle(callId, undefined, "The host stopped waiting for this client.", call.addressee);
  }

  private localWindowAttached(): boolean {
    for (const peer of this.peers.values()) if (onHostMachine(peer) && peer.windowHalves?.length) return true;
    return false;
  }

  /** Starts the display's window, waits for it to say hello, then asks it; one without the half says so. */
  private async launchThenCall(extensionId: string, command: string, input: unknown, options: ClientCallOptions, caller: string | undefined): Promise<unknown> {
    let arrived!: () => void;
    const attached = new Promise<void>((resolve) => { arrived = resolve; });
    this.arrivals.add(arrived);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.launcher!.ensure();
      if (!this.localWindowAttached()) {
        await Promise.race([attached, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`The window on this machine's invisible display did not connect within ${Math.round(this.attachTimeoutMs / 1000)} s.`)), this.attachTimeoutMs);
          timer.unref?.();
        })]);
      }
    } finally {
      this.arrivals.delete(arrived);
      clearTimeout(timer);
    }
    if (!this.addressee(extensionId, caller, options)) throw new Error(noWindow(extensionId, false));
    return this.call(extensionId, command, input, options, caller);
  }

  private addressee(extensionId: string, caller: string | undefined, options: ClientCallOptions): string | undefined {
    const { window } = options;
    if (window !== undefined && window !== "host") return this.pinned(extensionId, window);
    const onHost = window === "host";
    const own = caller === undefined ? undefined : this.ownWindow(caller, extensionId);
    if (own && (!onHost || onHostMachine(this.peers.get(own)!))) return own;
    if (options.callerOnly === true && caller !== undefined) return undefined;
    // Never a paired client's window: it gets only the calls it caused itself.
    let local: string | undefined;
    for (const [connection, peer] of this.peers) {
      if (onHostMachine(peer) && peer.windowHalves?.includes(extensionId)) local = connection;
    }
    return local;
  }

  /** A window on this machine by id; the newest connection wins after a reconnect. */
  private pinned(extensionId: string, windowId: string): string | undefined {
    let found: string | undefined;
    for (const [connection, peer] of this.peers) {
      if (peer.windowId === windowId && onHostMachine(peer) && peer.windowHalves?.includes(extensionId)) found = connection;
    }
    return found;
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

/** A window process beside the host: loopback, with the host token. */
function onHostMachine(peer: ClientPeer): boolean {
  return peer.local && peer.pairedClient === undefined;
}

function noWindow(extensionId: string, callerOnly: boolean): string {
  if (callerOnly) return "This client has no window that can answer this; open it in the Tau desktop app.";
  return `No Tau window on this host has the window half of ${extensionId}.`;
}
