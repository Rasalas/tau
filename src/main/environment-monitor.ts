import { WebSocket, type ClientOptions } from "ws";
import type { HostBootstrap, ThreadIndexSnapshot } from "../shared/contracts.js";
import type { EnvironmentStatus } from "../shared/environments.js";
import {
  HOST_CAPABILITY,
  HOST_CLOSE_CODE,
  HOST_TRANSPORT_VERSION,
  decodeHostServerFrame,
  type HostHelloReply,
} from "../shared/host-transport.js";
import type { HostLogger } from "./host-log.js";
import { HostCertificateRefusedError, pinnedTlsConnect } from "./host-tls-trust.js";

/** What the window knows about one machine from its own connection to it. */
export interface MonitorState {
  status: EnvironmentStatus;
  detail?: string;
  roundTripMs?: number;
  lastSeenAt?: number;
  /** The socket URL in use, or the one last used. */
  address?: string;
  hostVersion?: string;
  readOnly?: boolean;
  host?: { id: string; name: string };
  index?: ThreadIndexSnapshot;
  running: ReadonlySet<string>;
}

/** The parts of `ws` the monitor uses, so a test can hand it anything that behaves alike. */
export interface MonitorSocket {
  send(data: string): void;
  close(code?: number): void;
  terminate?(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface EnvironmentMonitorOptions {
  /** Socket URLs in the order to try them; read again at every attempt. */
  urls(): string[];
  token: string;
  /** Pins every `wss:` address; absent for a plaintext loopback or tunnel address. */
  fingerprint?: string;
  onChange(state: MonitorState): void;
  /** The machine answered at this address; it is tried first next time. */
  onReached?(url: string, reply: HostHelloReply): void;
  logger?: HostLogger;
  createSocket?(url: string, fingerprint: string | undefined): MonitorSocket;
  now?(): number;
  /** Timers, injectable so tests need not wait. */
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

const HELLO_TIMEOUT_MS = 10_000;
const PING_EVERY_MS = 20_000;
const PING_DEADLINE_MS = 10_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
/** An unreachable machine is tried less and less often, but never less than twice a minute. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

type IndexUpdate =
  | { type: "thread-index"; index?: ThreadIndexSnapshot }
  | { type: "thread-shell"; update?: { sessionId?: string; shell?: ThreadIndexSnapshot["sessions"][number]; removed?: boolean } }
  | { type: string };

/** The index after a host's `thread-index` or `thread-shell` update; undefined when it says nothing about the index. */
export function applyIndexUpdate(index: ThreadIndexSnapshot | undefined, update: IndexUpdate): ThreadIndexSnapshot | undefined {
  if (update.type === "thread-index") {
    const next = (update as { index?: ThreadIndexSnapshot }).index;
    return next && Array.isArray(next.sessions) && Array.isArray(next.projects) ? next : undefined;
  }
  if (update.type !== "thread-shell" || !index) return undefined;
  const change = (update as { update?: { sessionId?: string; shell?: ThreadIndexSnapshot["sessions"][number]; removed?: boolean } }).update;
  if (!change?.sessionId) return undefined;
  const others = index.sessions.filter((session) => session.id !== change.sessionId);
  if (change.removed) return { ...index, sessions: others };
  return change.shell ? { ...index, sessions: [change.shell, ...others] } : undefined;
}

function defaultSocket(url: string, fingerprint: string | undefined): MonitorSocket {
  const options: ClientOptions = fingerprint && url.startsWith("wss:")
    ? { createConnection: pinnedTlsConnect(fingerprint) as unknown as ClientOptions["createConnection"] }
    : {};
  return new WebSocket(url, options) as unknown as MonitorSocket;
}

/**
 * The window's own small connection to one machine (ADR 0025): says hello as
 * an auxiliary client that subscribes to nothing, reads the thread index once
 * and follows its pushes, pings to notice a machine that went away, and tries
 * the machine's addresses in turn when it cannot reach it.
 */
export class EnvironmentMonitor {
  private state: MonitorState = { status: "connecting", running: new Set() };
  private socket: MonitorSocket | undefined;
  private closed = false;
  private attempt = 0;
  private urlIndex = 0;
  private retryTimer: unknown;
  private pingTimer: unknown;
  private deadline: unknown;
  private pingSentAt: number | undefined;
  private counter = 0;
  private readonly pending = new Map<string, (result: { value?: unknown; error?: string }) => void>();

  constructor(private readonly options: EnvironmentMonitorOptions) {
    this.connect();
  }

  get current(): MonitorState { return this.state; }

  /** Tries now instead of at the next scheduled attempt. */
  retryNow(): void {
    if (this.closed) return;
    if (this.state.status === "connected") return;
    this.clear(this.retryTimer);
    this.attempt = 0;
    this.urlIndex = 0;
    this.drop();
    this.set({ status: "connecting", detail: undefined });
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.clear(this.retryTimer);
    this.drop();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private timer(callback: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(callback, ms);
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  }

  private clear(handle: unknown): void {
    if (handle === undefined) return;
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private set(patch: Partial<MonitorState>): void {
    const next: MonitorState = { ...this.state, ...patch };
    for (const key of Object.keys(patch) as (keyof MonitorState)[]) {
      if (patch[key] === undefined) delete next[key];
    }
    this.state = next;
    this.options.onChange(next);
  }

  private connect(): void {
    if (this.closed) return;
    const urls = this.options.urls();
    const url = urls[this.urlIndex % Math.max(urls.length, 1)];
    if (!url) {
      this.set({ status: "offline", detail: "No address is known for this machine." });
      return;
    }
    let settled = false;
    let helloAnswered = false;
    const socket = (this.options.createSocket ?? defaultSocket)(url, this.options.fingerprint);
    this.socket = socket;
    const helloDeadline = this.timer(() => {
      if (!helloAnswered && this.socket === socket) this.fail(socket, `${url} did not answer in time.`);
    }, HELLO_TIMEOUT_MS);
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.write(socket, {
        type: "hello",
        id: "hello",
        hello: { protocol: HOST_TRANSPORT_VERSION, token: this.options.token, auxiliary: true, subscription: { threads: [], topics: [] } },
      });
    });
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      this.onFrame(socket, url, String(data), () => {
        helloAnswered = true;
        this.clear(helloDeadline);
      });
    });
    socket.on("error", (error) => {
      if (this.socket !== socket || settled) return;
      if (error instanceof HostCertificateRefusedError) {
        settled = true;
        this.clear(helloDeadline);
        this.refuse(`It presented a certificate with SHA-256 ${error.presented}, not the one saved when it was added. Someone may be in between; remove it and add it again only if its certificate was replaced on purpose.`);
      }
    });
    socket.on("close", (code) => {
      this.clear(helloDeadline);
      if (this.socket !== socket || settled) return;
      settled = true;
      if (code === HOST_CLOSE_CODE.unauthorized) {
        this.refuse("It no longer accepts this window's key: the device was revoked there or its access expired. Remove it and add it again.");
        return;
      }
      if (code === HOST_CLOSE_CODE.forbiddenOrigin) {
        this.refuse("It refused the connection's origin.");
        return;
      }
      this.fail(socket, helloAnswered ? "The connection dropped." : `${url} could not be reached.`);
    });
  }

  private onFrame(socket: MonitorSocket, url: string, text: string, onHello: () => void): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const frame = decodeHostServerFrame(parsed);
    if (!frame) return;
    this.clear(this.deadline);
    this.deadline = undefined;
    if (frame.type === "hello-reply") {
      onHello();
      this.attempt = 0;
      const reply = frame.reply;
      this.set({
        status: "connected",
        detail: undefined,
        address: url,
        hostVersion: reply.hostVersion,
        readOnly: reply.access === "read-only" ? true : undefined,
        host: reply.host,
        lastSeenAt: this.now(),
      });
      this.options.onReached?.(url, reply);
      if (reply.capabilities.includes(HOST_CAPABILITY.heartbeat)) this.schedulePing(socket);
      void this.request<HostBootstrap>(socket, "bootstrap", BOOTSTRAP_TIMEOUT_MS)
        .then((bootstrap) => { if (this.socket === socket) this.set({ index: bootstrap.threadIndex, lastSeenAt: this.now() }); })
        .catch((error: unknown) => this.options.logger?.warn("environment.bootstrap.failed", { url, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (frame.type === "pong") {
      if (this.pingSentAt !== undefined) this.set({ roundTripMs: Math.max(0, this.now() - this.pingSentAt), lastSeenAt: this.now() });
      this.pingSentAt = undefined;
      return;
    }
    if (frame.type === "response") {
      const settle = this.pending.get(frame.response.id);
      if (!settle) return;
      this.pending.delete(frame.response.id);
      settle(frame.response.error ? { error: frame.response.error.message } : { value: frame.response.result });
      return;
    }
    if (frame.type !== "push") return;
    const event = frame.push.event as { type?: unknown; threadIndex?: unknown; sessionId?: unknown; running?: unknown; update?: unknown };
    if (event.type === "thread-index" && event.threadIndex && typeof event.threadIndex === "object") {
      this.set({ index: event.threadIndex as ThreadIndexSnapshot, lastSeenAt: this.now() });
    } else if (event.type === "host-update" && event.update && typeof event.update === "object") {
      const index = applyIndexUpdate(this.state.index, event.update as IndexUpdate);
      if (index) this.set({ index, lastSeenAt: this.now() });
    } else if (event.type === "agent-status" && typeof event.sessionId === "string") {
      const running = new Set(this.state.running);
      if (event.running === true) running.add(event.sessionId);
      else running.delete(event.sessionId);
      this.set({ running, lastSeenAt: this.now() });
    }
  }

  private request<T>(socket: MonitorSocket, method: string, timeoutMs: number): Promise<T> {
    this.counter += 1;
    const id = `m${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timer(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, ({ value, error }) => {
        this.clear(timer);
        if (error !== undefined) reject(new Error(error));
        else resolve(value as T);
      });
      this.write(socket, { type: "request", request: { id, method, params: [] } });
    });
  }

  private schedulePing(socket: MonitorSocket): void {
    this.clear(this.pingTimer);
    this.pingTimer = this.timer(() => {
      if (this.socket !== socket) return;
      this.pingSentAt = this.now();
      this.write(socket, { type: "ping", id: `p${this.now()}` });
      // Any frame clears it; a half-open link to a machine that slept answers none.
      this.deadline = this.timer(() => {
        if (this.socket === socket) this.fail(socket, "It stopped answering.");
      }, PING_DEADLINE_MS);
      this.schedulePing(socket);
    }, PING_EVERY_MS);
  }

  private write(socket: MonitorSocket, frame: unknown): void {
    try { socket.send(JSON.stringify(frame)); } catch { /* the close handler takes over */ }
  }

  /** Could not reach it, or lost it: offline, and another try later, at the next address. */
  private fail(socket: MonitorSocket, detail: string): void {
    if (this.socket !== socket) return;
    const wasConnected = this.state.status === "connected";
    this.drop();
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.urlIndex += 1;
    this.set({
      status: "offline",
      detail,
      roundTripMs: undefined,
      ...(wasConnected ? { lastSeenAt: this.now() } : {}),
      running: new Set(),
    });
    this.retryTimer = this.timer(() => this.connect(), delay);
  }

  /** A refusal that no retry can change. */
  private refuse(detail: string): void {
    this.drop();
    this.closed = true;
    this.set({ status: "refused", detail, roundTripMs: undefined, running: new Set() });
  }

  private drop(): void {
    this.clear(this.pingTimer);
    this.clear(this.deadline);
    this.pingTimer = undefined;
    this.deadline = undefined;
    this.pingSentAt = undefined;
    for (const settle of this.pending.values()) settle({ error: "The connection dropped." });
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try { (socket.terminate ?? socket.close).call(socket); } catch { /* already gone */ }
  }
}
