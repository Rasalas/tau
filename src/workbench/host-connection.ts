import type { HostBootstrap, HostEvent } from "../shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import {
  HOST_CAPABILITY,
  HOST_TRANSPORT_VERSION,
  decodeHostHelloReply,
  isHostJobEvent,
  jobMethodKey,
  type HostHelloReply,
  type HostJobEvent,
  type HostPush,
  type HostResponse,
} from "../shared/host-transport";
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
 */
export class HostConnection {
  private lastSeq = 0;
  /** Which client this is, repeated in every hello so the host can count profiles. */
  private profile?: string;
  private state: HostConnectionState = "connected";
  private refusal: string | undefined;
  private recovering = false;
  private queued: HostPush[] = [];
  private capabilities = new Set<string>();
  private hostVersion: string | undefined;
  private readonly helloListeners = new Set<() => void>();
  private jobMethods = new Set<string>();
  private readonly eventListeners = new Set<(event: HostEvent) => void>();
  private readonly stateListeners = new Set<(state: HostConnectionState) => void>();
  private readonly jobs = new Map<string, PendingJob>();
  /** A job that finished before its `start-job` response arrived. */
  private readonly earlyJobResults = new Map<string, HostJobEvent>();
  private readonly toolOutputs = new ToolOutputStream();

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

  onState(listener: (state: HostConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Says hello without a `lastSeq`: a fresh client starts from the bootstrap it fetches. */
  async start(profile?: string): Promise<HostHelloReply | undefined> {
    this.profile = profile;
    return this.hello(undefined);
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (this.refusal !== undefined) throw new HostRequestError("Tau refused the connection to this host.", "refused");
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

  private settleJob<T>(event: HostJobEvent): T {
    if (event.type === "job-done" && event.error) throw new HostRequestError(event.error.message, event.error.code);
    return (event.type === "job-done" ? event.result : undefined) as T;
  }

  private receive(push: HostPush): void {
    if (push.seq <= this.lastSeq) return;
    if (this.recovering) {
      this.queued.push(push);
      return;
    }
    if (push.seq > this.lastSeq + 1) {
      this.queued.push(push);
      void this.recover();
      return;
    }
    this.apply(push);
  }

  private apply(push: HostPush): void {
    this.lastSeq = push.seq;
    const event = this.toolOutputs.receive(push);
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

  /** Repairs a gap: replay what the host still has, otherwise refetch everything. */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    this.setState("reconnecting");
    try {
      await this.hello(this.lastSeq);
    } catch {
      this.setState("reconnecting");
    } finally {
      this.recovering = false;
      this.drain();
    }
  }

  private async hello(lastSeq: number | undefined): Promise<HostHelloReply | undefined> {
    const reply = decodeHostHelloReply(await this.request<unknown>("hello", [{
      protocol: HOST_TRANSPORT_VERSION,
      ...(lastSeq === undefined ? {} : { lastSeq }),
      ...(this.profile ? { profile: this.profile } : {}),
    }]));
    if (!reply) throw new HostRequestError("The host answered hello with a frame this client cannot read.", "invalid-hello");
    this.capabilities = new Set(reply.capabilities);
    if (reply.hostVersion !== this.hostVersion) {
      this.hostVersion = reply.hostVersion;
      for (const listener of this.helloListeners) listener();
    }
    if (lastSeq === undefined) {
      // A first connection starts from the bootstrap it is about to fetch.
      this.lastSeq = reply.nextSeq - 1;
      this.setState("connected");
      return reply;
    }
    for (const push of reply.missed) if (push.seq > this.lastSeq) this.apply(push);
    if (reply.resync) {
      this.lastSeq = reply.nextSeq - 1;
      this.toolOutputs.clear();
      await this.resync();
    }
    this.setState("connected");
    return reply;
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
    for (const push of queued) if (push.seq === this.lastSeq + 1) this.apply(push);
  }

  private setState(state: HostConnectionState): void {
    if (this.state === state || this.state === "refused") return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
