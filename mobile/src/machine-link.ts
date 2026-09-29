import {
  HOST_TRANSPORT_VERSION,
  decodeHostServerFrame,
  tokenRefused,
  type HostHelloReply,
  type HostPush,
} from "../../src/shared/host-transport";
import type { CertificateRefusal, RaceFailure, RaceTimers } from "./endpoints";

/** The part of `RacingSocket` a link uses, so a test can hand it a fake. */
export interface LinkSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Why a link closed without being asked to. */
export type LinkEnd =
  | { kind: "refused"; reason: string }
  | { kind: "certificate"; refusal: CertificateRefusal }
  | { kind: "lost"; detail: string };

export interface MachineLinkOptions {
  /** Opens the socket: every address raced, pinned. `onFailure` hears why none opened. */
  open(onFailure: (failure: RaceFailure) => void): LinkSocket;
  token: string;
  /** The last push seen before; the host replays what came since instead of a snapshot. */
  lastSeq(): number | undefined;
  onHello(reply: HostHelloReply): void;
  onPush(push: HostPush): void;
  onEnd(end: LinkEnd): void;
  /** How long an idle link stays open for the next call. */
  lingerMs?: number;
  timers?: RaceTimers;
}

export const LINK_LINGER_MS = 20_000;
const HELLO_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

/**
 * A short connection to a paired host the phone does not show: an auxiliary
 * hello that subscribes to no thread and no topic, a few calls, and a close
 * once it sat idle for `lingerMs`. It never reconnects by itself; the next
 * call opens it again.
 */
export class MachineLink {
  private socket: LinkSocket | undefined;
  private hello: Promise<void> | undefined;
  private idle: unknown;
  private counter = 0;
  private inFlight = 0;
  private failHello: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: unknown }>();
  private readonly timers: RaceTimers;

  constructor(private readonly options: MachineLinkOptions) {
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  get open(): boolean { return this.socket !== undefined; }

  /** Asks the host; opens the link first when it is closed. */
  async call<T>(method: string, params: readonly unknown[] = [], timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    this.inFlight += 1;
    this.timers.clearTimeout(this.idle);
    try {
      await this.ready();
      const socket = this.socket;
      if (!socket) throw new Error("The connection closed.");
      return await this.request<T>(socket, method, params, timeoutMs);
    } finally {
      this.inFlight -= 1;
      this.arm();
    }
  }

  /** Says hello if it has not; resolves once the host answered. */
  ready(): Promise<void> {
    if (this.hello) return this.hello;
    const attempt = new Promise<void>((resolve, reject) => {
      let settled = false;
      let failure: RaceFailure | undefined;
      const socket = this.options.open((why) => { failure = why; });
      this.socket = socket;
      this.failHello = (error) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(deadline);
        reject(error);
      };
      const deadline = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("It did not answer in time."));
        this.end(socket, { kind: "lost", detail: "It did not answer in time." });
      }, HELLO_TIMEOUT_MS);
      socket.onopen = () => {
        const lastSeq = this.options.lastSeq();
        this.write(socket, {
          type: "hello",
          id: "hello",
          hello: {
            protocol: HOST_TRANSPORT_VERSION,
            token: this.options.token,
            auxiliary: true,
            subscription: { threads: [], topics: [] },
            ...(lastSeq !== undefined ? { lastSeq } : {}),
          },
        });
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || typeof event.data !== "string") return;
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { return; }
        const frame = decodeHostServerFrame(parsed);
        if (!frame) return;
        if (frame.type === "hello-reply") {
          if (settled) return;
          settled = true;
          this.timers.clearTimeout(deadline);
          this.options.onHello(frame.reply);
          resolve();
          return;
        }
        if (frame.type === "response") {
          const waiting = this.pending.get(frame.response.id);
          if (!waiting) return;
          this.pending.delete(frame.response.id);
          this.timers.clearTimeout(waiting.timer);
          if (frame.response.error) waiting.reject(Object.assign(new Error(frame.response.error.message), { code: frame.response.error.code }));
          else waiting.resolve(frame.response.result);
          return;
        }
        if (frame.type === "push") this.options.onPush(frame.push);
      };
      socket.onclose = (event) => {
        this.timers.clearTimeout(deadline);
        if (this.socket !== socket) return;
        const end: LinkEnd = tokenRefused(event?.code, event?.reason)
          ? { kind: "refused", reason: event?.reason ?? "unauthorized" }
          : failure && failure.reason !== "unreachable"
            ? { kind: "certificate", refusal: failure }
            : { kind: "lost", detail: settled ? "The connection dropped." : "It could not be reached." };
        if (!settled) {
          settled = true;
          reject(new Error(end.kind === "lost" ? end.detail : end.kind === "refused" ? "It no longer accepts this phone." : "Its certificate was refused."));
        }
        this.end(socket, end);
      };
    });
    this.hello = attempt;
    // A failed hello leaves the link closed for the next call to open again.
    attempt.catch(() => undefined);
    return attempt;
  }

  /** Closes now; calls under way fail. */
  close(): void {
    const socket = this.socket;
    if (!socket) return;
    this.drop(socket, new Error("The connection closed."));
    try { socket.close(); } catch { /* already gone */ }
  }

  private arm(): void {
    this.timers.clearTimeout(this.idle);
    if (this.inFlight > 0 || !this.socket) return;
    this.idle = this.timers.setTimeout(() => this.close(), this.options.lingerMs ?? LINK_LINGER_MS);
  }

  private request<T>(socket: LinkSocket, method: string, params: readonly unknown[], timeoutMs: number): Promise<T> {
    this.counter += 1;
    const id = `k${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write(socket, { type: "request", request: { id, method, params } });
    });
  }

  private write(socket: LinkSocket, frame: unknown): void {
    try { socket.send(JSON.stringify(frame)); } catch { /* the close handler takes over */ }
  }

  private end(socket: LinkSocket, end: LinkEnd): void {
    if (this.socket !== socket) return;
    this.drop(socket, new Error(end.kind === "lost" ? end.detail : "The connection closed."));
    this.options.onEnd(end);
  }

  private drop(socket: LinkSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.hello = undefined;
    this.timers.clearTimeout(this.idle);
    this.failHello?.(error);
    this.failHello = undefined;
    for (const waiting of this.pending.values()) {
      this.timers.clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
