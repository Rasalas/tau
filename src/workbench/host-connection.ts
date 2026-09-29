import type { HostBootstrap, HostEvent } from "../shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import {
  HOST_CAPABILITY,
  HOST_TRANSPORT_VERSION,
  decodeHostHelloReply,
  hostTopicKey,
  isHostJobEvent,
  jobMethodKey,
  type HostHello,
  type HostHelloReply,
  type HostJobEvent,
  type HostPush,
  type HostResponse,
  type HostSubscription,
} from "../shared/host-transport";
import type { HostLink } from "./host-link";
import { MessageTextStream } from "./message-text-stream";
import { ToolOutputStream, isWireEvent } from "./tool-output-stream";

/**
 * `reconnecting` means pushes are missing; `resyncing` means the state is being
 * refetched; `refused` is final: this client will not talk to that host
 * (its certificate is not the trusted one), and `getRefusal()` says why.
 */
export type HostConnectionState = "connected" | "reconnecting" | "resyncing" | "refused";

/** One way of moving frames to a host. Electron IPC is one, a local socket another. */
export interface HostTransport {
  readonly platform: string;
  request(method: string, params: readonly unknown[]): Promise<HostResponse>;
  onPush(listener: (push: HostPush) => void): () => void;
  /** A link that can drop reports both edges; the in-process transport reports neither. */
  onOpen?(listener: () => void): () => void;
  onClose?(listener: () => void): () => void;
  close?(): void;
  /** The socket underneath, for a transport that has one. */
  getLink?(): HostLink;
  onLink?(listener: (link: HostLink) => void): () => void;
  /** Tries now instead of waiting out the backoff, or checks an open link. */
  retryNow?(): void;
  /** The token the next hello carries; a transport without one ignores it. */
  updateToken?(token: string): void;
}

interface PendingJob {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?(message: string, fraction?: number): void;
}

export class HostRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HostRequestError";
  }
}

/**
 * The client half of the host protocol: one request path, one push stream with
 * a sequence, and the recovery that follows from it. A gap in the sequence is
 * repaired by replaying the host's buffer; when the buffer no longer reaches
 * back far enough, the connection refetches the bootstrap and says so.
 *
 * Once `limitToWatched` is called, the host sends thread streams and topic
 * events only for what is watched (`watchThread`, `watchNewThread`,
 * `watchTopic`). A new subscription goes out before the next request, so a
 * thread watched before its detail is fetched misses nothing in between.
 */
export class HostConnection {
  private lastSeq = 0;
  /** Which client this is, repeated in every hello so the host can count profiles. */
  private profile?: string;
  /** The window this renderer sits in, so the host sends the calls it causes to that window. */
  private windowId?: string;
  private state: HostConnectionState = "connected";
  private refusal: string | undefined;
  private recovering = false;
  private queued: HostPush[] = [];
  private capabilities = new Set<string>();
  private readOnly = false;
  private owner: boolean | undefined;
  private hostVersion: string | undefined;
  private hostName: string | undefined;
  private readonly helloListeners = new Set<() => void>();
  private jobMethods = new Set<string>();
  private readonly eventListeners = new Set<(event: HostEvent) => void>();
  private readonly stateListeners = new Set<(state: HostConnectionState) => void>();
  private readonly jobs = new Map<string, PendingJob>();
  /** A job that finished before its `start-job` response arrived. */
  private readonly earlyJobResults = new Map<string, HostJobEvent>();
  private readonly toolOutputs = new ToolOutputStream();
  private readonly messageTexts = new MessageTextStream();
  /** `thread:`, `request:` or `topic:` keys, with how many watchers hold each. */
  private readonly watched = new Map<string, number>();
  private limited = false;
  private subscriptionQueued = false;
  /** What the host filters this connection by, as far as it answered; undefined is every push. */
  private confirmed: HostSubscription | undefined;
  /** The last subscription sent on this link, answered or not. */
  private requested: string | undefined;

  constructor(private readonly transport: HostTransport) {
    transport.onPush((push) => this.receive(push));
    transport.onClose?.(() => this.setState("reconnecting"));
    transport.onOpen?.(() => void this.recover());
  }

  get platform(): string {
    return this.transport.platform;
  }

  getState = (): HostConnectionState => this.state;

  getRefusal = (): string | undefined => this.refusal;

  /** The socket's own state; undefined for a transport without one (Electron IPC). */
  getLink = (): HostLink | undefined => this.transport.getLink?.();

  onLink(listener: (link: HostLink) => void): () => void {
    return this.transport.onLink?.(listener) ?? (() => undefined);
  }

  reconnectNow(): void {
    if (this.refusal === undefined) this.transport.retryNow?.();
  }

  /** Stops talking to the host for good; every request after this fails at once. */
  refuse(reason: string): void {
    if (this.refusal !== undefined) return;
    this.refusal = reason;
    this.setState("refused");
    this.transport.close?.();
  }

  /** The Tau version the host reported in its last hello. */
  getHostVersion = (): string | undefined => this.hostVersion;

  /** Called after every hello the host answered, a reconnect's included. */
  onHello(listener: () => void): () => void {
    this.helloListeners.add(listener);
    return () => this.helloListeners.delete(listener);
  }

  /** What the host said it can do in its hello; `local-files` is read by the workbench. */
  hasCapability = (capability: string): boolean => this.capabilities.has(capability);

  /** The host said in its hello that this device was paired Read only (ADR 0024). */
  isReadOnly = (): boolean => this.readOnly;

  /** Whether the host said this connection manages access; undefined before a hello, or from an older host. */
  isOwner = (): boolean | undefined => this.owner;

  /** The host machine's name from its last hello (ADR 0025). */
  getHostName = (): string | undefined => this.hostName;

  onState(listener: (state: HostConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Says hello without a `lastSeq`: a fresh client starts from the bootstrap it fetches. */
  async start(profile?: string, windowId?: string): Promise<HostHelloReply | undefined> {
    this.profile = profile;
    this.windowId = windowId;
    const reply = await this.hello(undefined);
    this.sendSubscription();
    return reply;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (this.refusal !== undefined) throw new HostRequestError("Tau refused the connection to this host.", "refused");
    if (this.subscriptionQueued) this.sendSubscription();
    const response = await this.transport.request(method, params);
    if (response.error) throw new HostRequestError(response.error.message, response.error.code);
    return response.result as T;
  }

  /** Whether a call should run as a job, as the host reported it. */
  isJobMethod(method: string, extensionId?: string, command?: string): boolean {
    return this.jobMethods.has(jobMethodKey(method, extensionId, command));
  }

  /** Asks the host which calls it wants run as jobs; failures leave the plain path in place. */
  async refreshJobMethods(): Promise<void> {
    if (!this.capabilities.has(HOST_CAPABILITY.jobs)) return;
    try {
      const methods = await this.request<string[]>("job-methods");
      this.jobMethods = new Set(methods);
    } catch {
      // Not knowing about jobs only means long calls stay plain requests.
    }
  }

  /**
   * Runs a long method as a host job and waits for `job-done`, so callers keep
   * a promise. A job failure is a rejected promise, never a lost connection.
   */
  async runJob<T>(method: string, params: readonly unknown[] = [], onProgress?: (message: string, fraction?: number) => void): Promise<T> {
    const { jobId } = await this.request<{ jobId: string }>("start-job", [method, params]);
    const early = this.earlyJobResults.get(jobId);
    if (early) {
      this.earlyJobResults.delete(jobId);
      return this.settleJob<T>(early);
    }
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(jobId, { resolve: (value) => resolve(value as T), reject, ...(onProgress ? { onProgress } : {}) });
    });
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const result = await this.request<{ cancelled: boolean }>("cancel-job", [jobId]);
    return result.cancelled;
  }

  close(): void {
    this.transport.close?.();
  }

  /** Keeps this thread's stream coming while the returned function is not called. */
  watchThread(sessionId: string): () => void {
    return this.watch(`thread:${sessionId}`);
  }

  /** The thread a `new-session` call with this request id creates, from its first detail on. */
  watchNewThread(requestId: string): () => void {
    return this.watch(`request:${requestId}`);
  }

  /** An extension's events published with this topic. */
  watchTopic(extensionId: string, topic: string): () => void {
    return this.watch(`topic:${hostTopicKey(extensionId, topic)}`);
  }

  /**
   * From now on the host sends this client thread streams and topic events
   * only for what is watched. Call it once what the client shows is watched.
   */
  limitToWatched(): void {
    if (this.limited) return;
    this.limited = true;
    this.queueSubscription();
  }

  private watch(key: string): () => void {
    this.watched.set(key, (this.watched.get(key) ?? 0) + 1);
    this.queueSubscription();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.watched.get(key) ?? 1) - 1;
      if (left > 0) this.watched.set(key, left);
      else this.watched.delete(key);
      this.queueSubscription();
    };
  }

  private wantedSubscription(): HostSubscription | undefined {
    if (!this.limited) return undefined;
    const subscription: Required<HostSubscription> = { threads: [], topics: [], requests: [] };
    for (const key of [...this.watched.keys()].sort()) {
      const split = key.indexOf(":");
      const kind = key.slice(0, split);
      const value = key.slice(split + 1);
      if (kind === "thread") subscription.threads.push(value);
      else if (kind === "topic") subscription.topics.push(value);
      else subscription.requests.push(value);
    }
    const { requests, ...rest } = subscription;
    return requests.length > 0 ? subscription : rest;
  }

  private queueSubscription(): void {
    if (this.subscriptionQueued) return;
    this.subscriptionQueued = true;
    queueMicrotask(() => { if (this.subscriptionQueued) this.sendSubscription(); });
  }

  /** Tells the host what this client watches, if that changed; recovery sends it once it is done. */
  private sendSubscription(): void {
    this.subscriptionQueued = false;
    const wanted = this.wantedSubscription();
    if (!wanted || !this.capabilities.has(HOST_CAPABILITY.subscriptions)) return;
    if (this.recovering || this.state !== "connected" || this.refusal !== undefined) return;
    const key = JSON.stringify(wanted);
    if (key === this.requested) return;
    this.requested = key;
    // Answers arrive in order, and a push after one is filtered by it: what a replay must match.
    void this.transport.request("subscribe", [wanted]).then((response) => {
      if (!response.error) this.confirmed = wanted;
    }, () => undefined);
  }

  /** After a rotation: this connection stays, and its next reconnect says hello with `token`. */
  updateToken(token: string): void {
    this.transport.updateToken?.(token);
  }

  private settleJob<T>(event: HostJobEvent): T {
    if (event.type === "job-done" && event.error) throw new HostRequestError(event.error.message, event.error.code);
    return (event.type === "job-done" ? event.result : undefined) as T;
  }

  /** Next in line: `prev` says the pushes between went to other clients. */
  private follows(push: HostPush): boolean {
    return push.seq === this.lastSeq + 1 || (push.prev !== undefined && push.prev <= this.lastSeq);
  }

  private receive(push: HostPush): void {
    if (push.seq <= this.lastSeq) return;
    if (this.recovering) {
      this.queued.push(push);
      return;
    }
    if (!this.follows(push)) {
      this.queued.push(push);
      void this.recover();
      return;
    }
    this.apply(push);
  }

  private apply(push: HostPush): void {
    this.lastSeq = push.seq;
    const withText = this.messageTexts.receive(push);
    if (this.messageTexts.lost && !this.recovering) void this.recover();
    const event = withText && this.toolOutputs.receive({ seq: push.seq, event: withText });
    if (!event || isWireEvent(event)) return;
    if (!isHostJobEvent(event)) {
      for (const listener of this.eventListeners) listener(event);
      return;
    }
    const job = this.jobs.get(event.jobId);
    if (event.type === "job-progress") {
      job?.onProgress?.(event.message, event.fraction);
      return;
    }
    if (!job) {
      this.earlyJobResults.set(event.jobId, event);
      return;
    }
    this.jobs.delete(event.jobId);
    if (event.error) job.reject(new HostRequestError(event.error.message, event.error.code));
    else job.resolve(event.result);
  }

  /**
   * Repairs a gap: replay what the host still has, otherwise refetch everything. A text this
   * client lacks starts it over as a new client, so the host sends whole texts again.
   */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    this.setState("reconnecting");
    const restart = this.messageTexts.lost;
    this.messageTexts.lost = false;
    try {
      await this.hello(restart ? undefined : this.lastSeq, restart);
    } catch {
      if (restart) this.messageTexts.lost = true;
      this.setState("reconnecting");
    } finally {
      this.recovering = false;
      this.drain();
      this.sendSubscription();
    }
    if (this.messageTexts.lost && this.state === "connected") void this.recover();
  }

  /**
   * A replay says hello with the subscription the host last confirmed, so it
   * replays what it would have sent; a fresh start takes every push until the
   * client has applied its snapshot and says what it watches.
   */
  private async hello(lastSeq: number | undefined, restart = false): Promise<HostHelloReply | undefined> {
    const subscription = lastSeq === undefined ? undefined : this.confirmed;
    const hello: HostHello = {
      protocol: HOST_TRANSPORT_VERSION,
      ...(lastSeq === undefined ? {} : { lastSeq }),
      ...(this.profile ? { profile: this.profile } : {}),
      ...(this.windowId ? { windowId: this.windowId } : {}),
      ...(subscription ? { subscription } : {}),
    };
    const reply = decodeHostHelloReply(await this.request<unknown>("hello", [hello]));
    if (!reply) throw new HostRequestError("The host answered hello with a frame this client cannot read.", "invalid-hello");
    this.capabilities = new Set(reply.capabilities);
    this.readOnly = reply.access === "read-only";
    this.owner = reply.owner;
    this.hostName = reply.host?.name;
    this.confirmed = reply.capabilities.includes(HOST_CAPABILITY.subscriptions) ? subscription : undefined;
    this.requested = this.confirmed && JSON.stringify(this.confirmed);
    // A snapshot of a thread this client did not follow would miss what streams until it subscribes.
    if (reply.resync && this.confirmed) return this.hello(undefined, true);
    if (reply.hostVersion !== this.hostVersion) {
      this.hostVersion = reply.hostVersion;
      for (const listener of this.helloListeners) listener();
    }
    if (lastSeq === undefined) {
      // A first connection starts from the bootstrap it is about to fetch.
      this.lastSeq = reply.nextSeq - 1;
      if (restart) await this.startOver();
      this.setState("connected");
      return reply;
    }
    for (const push of reply.missed) if (push.seq > this.lastSeq) this.apply(push);
    // A filtered replay may end before the host's newest push; nothing after it was for this client.
    if (this.confirmed && !reply.resync) this.lastSeq = Math.max(this.lastSeq, reply.nextSeq - 1);
    if (reply.resync) {
      this.lastSeq = reply.nextSeq - 1;
      await this.startOver();
    }
    this.setState("connected");
    return reply;
  }

  private async startOver(): Promise<void> {
    this.toolOutputs.clear();
    this.messageTexts.clear();
    await this.resync();
  }

  /** Refetches the bootstrap and republishes it as the updates a client already applies. */
  private async resync(): Promise<void> {
    this.setState("resyncing");
    const bootstrap = await this.request<HostBootstrap>("bootstrap");
    const emit = (event: HostEvent) => { for (const listener of this.eventListeners) listener(event); };
    emit({ type: "thread-index", threadIndex: bootstrap.threadIndex });
    emit({ type: "host-update", update: { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: bootstrap.catalog } });
    emit({ type: "host-update", update: { version: HOST_PROTOCOL_VERSION, type: "project", project: bootstrap.project } });
    emit({ type: "host-update", update: { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: bootstrap.detail } });
  }

  private drain(): void {
    const queued = this.queued.sort((left, right) => left.seq - right.seq);
    this.queued = [];
    for (const push of queued) if (push.seq > this.lastSeq && this.follows(push)) this.apply(push);
  }

  private setState(state: HostConnectionState): void {
    if (this.state === state || this.state === "refused") return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
