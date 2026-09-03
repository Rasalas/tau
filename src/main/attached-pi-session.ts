import type { HostEvent, NewThreadRequestId } from "../shared/contracts.js";
import type {
  PiBridgeCommand,
  PiBridgeDescriptor,
  PiBridgeExtensionEvent,
  PiBridgeServerFrame,
  PiBridgeSnapshot,
} from "../shared/pi-bridge-protocol.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { findPiBridge, PiBridgeClient, PiBridgeReconnectLoop } from "./pi-bridge-client.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { AttachedRuntimeBackend, NewSessionRequest } from "./attached-runtime.js";

/** What the attached session needs from the host that owns the workbench. */
export interface AttachedSessionHost {
  readonly safeMode: boolean;
  readonly clientTurns: ClientTurnLedger;
  emit(event: HostEvent): void;
  log(label: string, detail?: string): void;
  errorMessage(error: unknown): string;
  fail(error: unknown): void;
  beginActivation(): number;
  isCurrentActivation(epoch: number): boolean;
  /** Pi is the sole writer of the file while attached; a local runtime for it is released. */
  releaseLocalThread(sessionFile: string): Promise<void>;
  clearActiveThread(): void;
  setCwd(cwd: string): void;
  /** A Pi session event for the attached thread; `turn` carries its live state. */
  onSessionEvent(event: unknown, turn: LiveTurnState, sessionId: string): void;
  /** Pi published a fresh snapshot; `stillCurrent` is false once another client took over. */
  onSnapshot(requestId: NewThreadRequestId | undefined, stillCurrent: () => boolean): void;
  /** The socket came back after a disconnect; the host republishes its state. */
  onReconnected(activationEpoch: number): Promise<void>;
}

interface PendingNewSession {
  previousSessionId?: string;
  projectPath: string;
  bridgeEpoch: string;
  resolve: (snapshot: PiBridgeSnapshot) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  observed?: { sessionId: string; sessionFile: string; bridgeEpoch: string };
  acknowledging?: boolean;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * A Pi terminal that owns the visible thread. Tau attaches over the session
 * bridge socket, follows Pi's snapshots and events, sends prompts and
 * commands there, and reconnects with backoff when the socket drops. The
 * host sees one object with "attached or not"; everything about the bridge
 * protocol (epochs, new-session handshakes, awaiting-input prompts) stays here.
 */
export class AttachedPiSession implements AttachedRuntimeBackend {
  client?: PiBridgeClient;
  snapshot?: PiBridgeSnapshot;
  /** Set while the host deliberately takes a thread over from Pi, so it does not re-attach. */
  suppressAttach = false;
  private readonly pendingNewSessions = new Map<NewThreadRequestId, PendingNewSession>();
  /** Requests detached during a transport handoff still need Pi-side cleanup. */
  private readonly pendingNewSessionAborts = new Map<NewThreadRequestId, { projectPath: string; attempting?: boolean }>();
  private readonly reconnectLoop = new PiBridgeReconnectLoop();
  private unsubscribe?: () => void;
  /**
   * Pi answers its own extension questions in its terminal, so Tau cannot offer
   * the choices. It can still stop the thread from looking like ordinary work and
   * say where the answer is expected.
   */
  private awaitingPromptId?: string;
  /** Bridge events have no local runtime; a detached carrier keeps their live state. */
  private turn?: LiveTurnState & { sessionId: string };

  constructor(private readonly host: AttachedSessionHost) {}

  get isAttached(): boolean {
    return Boolean(this.client);
  }

  get descriptor(): PiBridgeDescriptor | undefined {
    return this.client?.descriptor;
  }

  /** Whether a Tau thread id names the thread Pi's TUI owns; no id means "the visible one". */
  owns(threadId: string | undefined): boolean {
    return Boolean(this.client) && (!threadId || threadId === this.snapshot?.sessionId);
  }

  /** Live state carrier for the attached thread's events. */
  turnState(sessionId: string): LiveTurnState {
    if (this.turn?.sessionId !== sessionId) this.turn = { sessionId, tools: new Map() };
    return this.turn;
  }

  async attach(
    cwd: string,
    sessionFile: string | undefined,
    options: { ownerPid?: number },
    activationEpoch: number,
  ): Promise<boolean> {
    const { host } = this;
    if (host.safeMode || this.suppressAttach) return false;
    const descriptor = await findPiBridge(cwd, sessionFile, options.ownerPid);
    if (!descriptor) return false;
    if (!host.isCurrentActivation(activationEpoch)) return false;
    if (this.client?.descriptor.epoch === descriptor.epoch && this.client.isConnected) return true;
    const client = new PiBridgeClient(descriptor);
    let snapshot: PiBridgeSnapshot;
    try {
      snapshot = await client.open();
    } catch (error) {
      client.close();
      host.log("bridge.connect.failed", host.errorMessage(error));
      if (!processIsAlive(descriptor.pid)) return false;
      throw new Error(`Pi owns this session, but Tau could not connect to it: ${host.errorMessage(error)}`);
    }
    if (!host.isCurrentActivation(activationEpoch)) {
      client.close();
      return false;
    }
    if (snapshot.runtimeCapabilities
      && snapshot.runtimeCapabilities.skillInvocationDialect !== PI_AGENT_RUNTIME_ADAPTER.capabilities.skillInvocationDialect) {
      client.close();
      throw new Error("The attached bridge does not advertise the Pi runtime adapter.");
    }
    for (const clientMessageId of snapshot.failedClientMessageIds ?? []) {
      if (typeof clientMessageId === "string" && clientMessageId.length > 0) {
        host.emit({
          type: "user-message-failed",
          sessionId: snapshot.sessionId,
          clientMessageId,
          message: "Pi did not add the prompt to the transcript.",
        });
      }
    }
    await host.releaseLocalThread(descriptor.sessionFile);
    if (!host.isCurrentActivation(activationEpoch)) {
      client.close();
      return false;
    }
    host.clearActiveThread();
    this.detach(false);
    this.client = client;
    this.snapshot = snapshot;
    await this.flushNewSessionAborts(client, snapshot);
    this.acceptPendingSnapshot(snapshot, client.descriptor.epoch);
    host.setCwd(snapshot.cwd);
    const unsubscribeEvents = client.subscribe((frame) => this.handleFrame(frame, client));
    const unsubscribeDisconnect = client.subscribeDisconnect(() => {
      if (this.client === client) this.reconnect(client);
    });
    this.unsubscribe = () => { unsubscribeEvents(); unsubscribeDisconnect(); };
    host.log("bridge.attached", snapshot.sessionId.slice(0, 8));
    return true;
  }

  detach(cancelReconnect = true): void {
    const { host } = this;
    if (cancelReconnect) this.reconnectLoop.cancel();
    if (!this.client) {
      if (cancelReconnect) host.clientTurns.clearAny();
      return;
    }
    const client = this.client;
    const detachedEpoch = client.descriptor.epoch;
    if (cancelReconnect) {
      for (const [requestId, pending] of this.pendingNewSessions) {
        if (pending.bridgeEpoch !== detachedEpoch) continue;
        this.abortNewSession(client, requestId, pending);
        this.deletePendingNewSession(requestId);
        pending.reject(new Error("The Pi bridge was detached before the new thread was reported."));
      }
    }
    // Pi's run state was ours only while attached; leaving it set would keep the
    // thread looking busy forever once Tau is no longer following that session.
    const detachedSessionId = this.snapshot?.sessionId;
    if (detachedSessionId) {
      host.clientTurns.clear(detachedSessionId);
      host.emit({ type: "agent-status", sessionId: detachedSessionId, running: false });
    }
    this.syncAwaitingInput({ ...(this.snapshot ?? {}), awaitingInput: undefined } as PiBridgeSnapshot);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    client.close();
    this.client = undefined;
    this.snapshot = undefined;
  }

  /** Runs `work` with attaching suppressed, e.g. while Tau takes a session over from Pi. */
  async withoutAttaching<T>(work: () => Promise<T>): Promise<T> {
    this.suppressAttach = true;
    try {
      return await work();
    } finally {
      this.suppressAttach = false;
    }
  }

  private reconnect(disconnected: PiBridgeClient): void {
    const { host } = this;
    if (this.client !== disconnected) return;
    const { cwd, sessionFile, pid } = disconnected.descriptor;
    const activationEpoch = host.beginActivation();
    host.emit({ type: "event-log", label: "bridge.reconnecting", detail: "Pi session bridge", timestamp: Date.now() });
    this.reconnectLoop.start(
      async () => {
        if (!host.isCurrentActivation(activationEpoch) || this.client !== disconnected) return true;
        if (await this.attach(cwd, sessionFile, {}, activationEpoch)) return true;
        if (!host.isCurrentActivation(activationEpoch) || this.client !== disconnected) return true;
        return this.attach(cwd, undefined, { ownerPid: pid }, activationEpoch);
      },
      () => {
        if (!host.isCurrentActivation(activationEpoch)) return;
        void host.onReconnected(activationEpoch).catch((error) => host.fail(error));
      },
      (error) => host.log("bridge.reconnect.retry", host.errorMessage(error)),
    );
  }

  /** A raw command on the socket; the caller decides what a failure means. */
  send(command: PiBridgeCommand, timeoutMs?: number): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error("Pi bridge is not connected."));
    return timeoutMs === undefined ? this.client.command(command) : this.client.command(command, timeoutMs);
  }

  /**
   * A bridge peer that stops answering must not strand ordinary commands: Tau
   * detaches and runs the thread itself. New thread creation keeps its request
   * owner until Pi either reports the matching session or explicitly rejects
   * it, so a delayed report cannot create a duplicate local thread.
   */
  async command(command: PiBridgeCommand, retainOnDisconnect = false): Promise<unknown> {
    const client = this.client;
    if (!client) throw new Error("Pi bridge is not connected.");
    try {
      return await client.command(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out|not connected|closed|disconnected/iu.test(message)) throw error;
      this.host.log("bridge.unresponsive", command.command);
      if (retainOnDisconnect) return undefined;
      this.detach();
      throw new Error("Pi stopped responding, so Tau detached from it and now runs this thread itself.");
    }
  }

  async refreshSnapshot(): Promise<void> {
    if (!this.client) return;
    this.snapshot = await this.client.command({ command: "snapshot" }) as PiBridgeSnapshot;
  }

  /** Pi reported a session as the answer to a new-thread request; follow it. */
  adoptSnapshot(snapshot: PiBridgeSnapshot): void {
    this.snapshot = snapshot;
    if (this.client) {
      this.client.descriptor.sessionId = snapshot.sessionId;
      this.client.descriptor.sessionFile = snapshot.sessionFile;
    }
  }

  /**
   * Asks Pi to open a new session. Resolves with the snapshot Pi reported for
   * this request, or without one when an older bridge only acknowledges the
   * command; rejects when Pi refuses or the bridge goes away first.
   */
  async requestNewSession(input: NewSessionRequest): Promise<{ snapshot?: PiBridgeSnapshot }> {
    const { requestId } = input;
    let resolveSession: ((snapshot: PiBridgeSnapshot) => void) | undefined;
    let rejectSession: ((error: unknown) => void) | undefined;
    const session = new Promise<PiBridgeSnapshot>((resolve, reject) => {
      resolveSession = resolve;
      rejectSession = reject;
    });
    void session.catch(() => undefined);
    const timeout = setTimeout(() => {
      const pending = this.pendingNewSessions.get(requestId);
      if (!pending) return;
      this.deletePendingNewSession(requestId);
      if (this.client) this.abortNewSession(this.client, requestId, pending);
      pending.reject(new Error("Pi did not report the new thread before message delivery timed out."));
    }, 15_000);
    timeout.unref?.();
    this.pendingNewSessions.set(requestId, {
      previousSessionId: this.snapshot?.sessionId,
      projectPath: input.projectPath,
      bridgeEpoch: this.client?.descriptor.epoch ?? "",
      resolve: resolveSession!,
      reject: rejectSession!,
      timeout,
    });
    try {
      const response = await this.command({
        command: "new_session",
        initialPrompt: input.initialPrompt,
        ...(input.attachments.length > 0 ? { attachments: [...input.attachments] } : {}),
        requestId,
        ...(input.identity ?? {}),
        ...(input.prepared ? { prepared: input.prepared } : {}),
      }, true);
      const responseRequestId = response && typeof response === "object" && "requestId" in response
        ? response.requestId
        : undefined;
      if (response && responseRequestId !== requestId) {
        throw new Error("The Pi bridge did not acknowledge this new-thread request.");
      }
      const snapshot = response && typeof response === "object" && "snapshot" in response
        ? response.snapshot as PiBridgeSnapshot
        : undefined;
      if (snapshot?.sessionId && snapshot.cwd) {
        const pending = this.pendingNewSessions.get(requestId);
        if (snapshot.newSessionRequestId !== requestId
          || snapshot.cwd !== input.projectPath
          || !pending
          || pending.projectPath !== snapshot.cwd
          || pending.bridgeEpoch !== this.client?.descriptor.epoch) {
          throw new Error("Pi returned an uncorrelated new-thread snapshot.");
        }
        pending.observed = {
          sessionId: snapshot.sessionId,
          sessionFile: snapshot.sessionFile,
          bridgeEpoch: this.client?.descriptor.epoch ?? "",
        };
        clearTimeout(pending.timeout);
        void this.acknowledgeNewSession(requestId, this.client?.descriptor.epoch);
        return { snapshot };
      }
      // A bridge without snapshots cannot prove a handoff, but should not
      // strand legacy callers that only expect command acceptance.
      if (!response && !this.snapshot) {
        this.deletePendingNewSession(requestId);
        return {};
      }
      return { snapshot: await session };
    } catch (error) {
      this.deletePendingNewSession(requestId);
      throw error;
    }
  }

  /** Aborts the new-thread request of a session, when one is still pending. */
  cancelPendingNewSession(sessionId?: string): void {
    const currentSessionId = this.snapshot?.sessionId;
    for (const [requestId, pending] of this.pendingNewSessions) {
      if (sessionId && currentSessionId !== sessionId) continue;
      this.deletePendingNewSession(requestId);
      pending.reject(new Error("The new-thread request was aborted."));
      if (this.client) this.abortNewSession(this.client, requestId, pending);
      break;
    }
  }

  private abortNewSession(
    client: PiBridgeClient,
    requestId: NewThreadRequestId,
    pending: { projectPath: string; observed?: { sessionId: string; sessionFile: string; bridgeEpoch: string } },
  ): void {
    const tombstone = this.pendingNewSessionAborts.get(requestId) ?? { projectPath: pending.projectPath };
    this.pendingNewSessionAborts.set(requestId, tombstone);
    void this.tryAbortNewSession(client, requestId, pending.observed?.sessionId);
  }

  private async flushNewSessionAborts(client: PiBridgeClient, snapshot: PiBridgeSnapshot): Promise<void> {
    const attempts = [...this.pendingNewSessionAborts.keys()]
      .filter((requestId) => this.pendingNewSessionAborts.get(requestId)?.projectPath === snapshot.cwd)
      .map((requestId) => this.tryAbortNewSession(client, requestId, snapshot.sessionId, snapshot.newSessionRequestId));
    await Promise.allSettled(attempts);
  }

  private async tryAbortNewSession(
    client: PiBridgeClient,
    requestId: NewThreadRequestId,
    sessionId?: string,
    snapshotRequestId?: NewThreadRequestId,
  ): Promise<void> {
    const tombstone = this.pendingNewSessionAborts.get(requestId);
    if (!tombstone || tombstone.attempting || (snapshotRequestId && snapshotRequestId !== requestId)) return;
    tombstone.attempting = true;
    const targetSessionId = sessionId ?? client.descriptor.sessionId;
    try {
      const response = await client.command({
        command: "new_session_abort",
        requestId,
        sessionId: targetSessionId,
        bridgeEpoch: client.descriptor.epoch,
      }, 3_000);
      if (response && typeof response === "object"
        && (response as { accepted?: unknown }).accepted === true
        && (response as { requestId?: unknown }).requestId === requestId
        && (response as { sessionId?: unknown }).sessionId === targetSessionId
        && (response as { bridgeEpoch?: unknown }).bridgeEpoch === client.descriptor.epoch) {
        this.pendingNewSessionAborts.delete(requestId);
      }
    } catch (error) {
      this.host.log("bridge.new_session.abort_failed", this.host.errorMessage(error));
    } finally {
      if (this.pendingNewSessionAborts.get(requestId) === tombstone) tombstone.attempting = false;
    }
  }

  private acceptPendingSnapshot(snapshot: PiBridgeSnapshot, transportEpoch?: string): NewThreadRequestId | undefined {
    const requestId = snapshot.newSessionRequestId;
    if (!requestId) return undefined;
    const pending = this.pendingNewSessions.get(requestId);
    if (!pending
      || snapshot.sessionId === pending.previousSessionId
      || snapshot.cwd !== pending.projectPath
      || transportEpoch === undefined
      || transportEpoch !== this.client?.descriptor.epoch) return undefined;
    pending.observed = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      bridgeEpoch: transportEpoch,
    };
    clearTimeout(pending.timeout);
    pending.resolve(snapshot);
    void this.acknowledgeNewSession(requestId, transportEpoch);
    return requestId;
  }

  private async acknowledgeNewSession(requestId: NewThreadRequestId, transportEpoch?: string): Promise<void> {
    const pending = this.pendingNewSessions.get(requestId);
    const client = this.client;
    const observed = pending?.observed;
    if (!pending || !observed || !client || transportEpoch !== client.descriptor.epoch || observed.bridgeEpoch !== transportEpoch) return;
    if (pending.acknowledging) return;
    pending.acknowledging = true;
    try {
      const response = await client.command({
        command: "new_session_ack",
        requestId,
        sessionId: observed.sessionId,
        bridgeEpoch: observed.bridgeEpoch,
      }, 3_000);
      if (!response || typeof response !== "object"
        || !("accepted" in response) || response.accepted !== true
        || !("requestId" in response) || response.requestId !== requestId
        || !("sessionId" in response) || response.sessionId !== observed.sessionId
        || !("bridgeEpoch" in response) || response.bridgeEpoch !== observed.bridgeEpoch) {
        pending.acknowledging = false;
        return;
      }
      if (this.pendingNewSessions.get(requestId) === pending) this.deletePendingNewSession(requestId);
    } catch (error) {
      pending.acknowledging = false;
      this.host.log("bridge.new_session.ack_failed", this.host.errorMessage(error));
    }
  }

  private handleFrame(frame: PiBridgeServerFrame, source: PiBridgeClient): void {
    const { host } = this;
    if (this.client !== source) return;
    if (frame.type === "event") {
      const event = frame.event;
      if (event && typeof event === "object" && (event as { type?: unknown }).type === "new_session_failed") {
        const failed = event as { requestId?: unknown; message?: unknown };
        const requestId = failed.requestId as NewThreadRequestId | undefined;
        const pending = requestId ? this.pendingNewSessions.get(requestId) : undefined;
        if (requestId && pending && failed.requestId === requestId) {
          this.deletePendingNewSession(requestId);
          pending.reject(new Error(typeof failed.message === "string" ? failed.message : "Pi could not create the new thread."));
          return;
        }
      }
      // Extensions inside Pi publish their own events; the host routes them by id.
      if (event && typeof event === "object" && (event as { type?: unknown }).type === "extension-event") {
        const { extensionId, name, payload } = event as Partial<PiBridgeExtensionEvent>;
        if (typeof extensionId === "string" && typeof name === "string") host.emit({ type: "extension-event", extensionId, name, payload });
        return;
      }
      host.onSessionEvent(event, this.turnState(frame.sessionId), frame.sessionId);
      return;
    }
    if (frame.type !== "snapshot") return;
    this.snapshot = frame.snapshot;
    void this.flushNewSessionAborts(source, frame.snapshot);
    const requestId = this.acceptPendingSnapshot(frame.snapshot, frame.epoch);
    this.syncAwaitingInput(frame.snapshot);
    host.setCwd(frame.snapshot.cwd);
    host.onSnapshot(requestId, () => this.client === source);
  }

  private syncAwaitingInput(snapshot: PiBridgeSnapshot): void {
    const { host } = this;
    const awaiting = snapshot.awaitingInput;
    if (awaiting && !this.awaitingPromptId) {
      const id = `bridge-await-${snapshot.sessionId}`;
      this.awaitingPromptId = id;
      host.emit({
        type: "extension-ui-prompt",
        sessionId: snapshot.sessionId,
        prompt: {
          id,
          sessionId: snapshot.sessionId,
          kind: awaiting.kind,
          title: awaiting.title ?? "Pi is waiting for an answer",
          message: "This thread runs in Pi, which asks in its own terminal. Answer it there to continue.",
          answerElsewhere: true,
        },
      });
      return;
    }
    if (!awaiting && this.awaitingPromptId) {
      host.emit({ type: "extension-ui-resolved", id: this.awaitingPromptId, sessionId: snapshot.sessionId });
      this.awaitingPromptId = undefined;
    }
  }

  private deletePendingNewSession(requestId: NewThreadRequestId): void {
    const pending = this.pendingNewSessions.get(requestId);
    if (pending) clearTimeout(pending.timeout);
    this.pendingNewSessions.delete(requestId);
  }
}
