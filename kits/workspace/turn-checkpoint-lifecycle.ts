import { boundedTurnCheckpointSummary } from "./turn-checkpoint-codec.js";
import type {
  AcceptTurnOptions,
  TurnCaptureState,
  TurnCheckpointCaptureResult,
  TurnCheckpointLease,
  TurnCheckpointLifecycleAdapter,
  TurnCheckpointStatus,
  TurnOutcomeEvent,
} from "./turn-checkpoint-types.js";

/** Shared before-boundary creation used by both the embedded host and bridge. */
export function startTurnCapture<Snapshot>(
  id: string,
  startedAt: number,
  createBeforeSnapshot: () => Promise<Snapshot | undefined>,
  onError?: (error: unknown) => void,
  options: {
    deferBefore?: boolean;
    expectsInput?: boolean;
    acquireLease?: (signal?: AbortSignal) => Promise<TurnCheckpointLease | undefined>;
    /** Give up on the lease after this long and run the turn without a checkpoint. */
    leaseTimeoutMs?: number;
    onStatus?: (status: TurnCheckpointStatus) => void;
  } = {},
): TurnCaptureState<Snapshot> {
  const capture: TurnCaptureState<Snapshot> = {
    id,
    startedAt,
    beforeSnapshot: Promise.resolve(undefined),
    beforeStarted: false,
    expectsInput: options.expectsInput !== false,
    started: false,
    abortController: new AbortController(),
  };
  const start = () => {
    if (capture.beforeStarted) return capture.beforeSnapshot;
    capture.beforeStarted = true;
    capture.beforeSnapshot = Promise.resolve()
      .then(async () => {
        options.onStatus?.("waiting");
        if (options.acquireLease) {
          const lease = await acquireLeaseWithin(options.acquireLease, capture.abortController?.signal, options.leaseTimeoutMs);
          if (lease === "busy") {
            capture.skipped = true;
            options.onStatus?.("skipped");
            return undefined;
          }
          if (!lease) {
            options.onStatus?.("failed");
            return undefined;
          }
          capture.lease = lease;
        }
        options.onStatus?.("capturing");
        return createBeforeSnapshot();
      })
      .catch((error) => {
        options.onStatus?.("failed");
        onError?.(error);
        return undefined;
      });
    return capture.beforeSnapshot;
  };
  capture.beforeFactory = start;
  if (!options.deferBefore) start();
  return capture;
}

/**
 * Bounds lease acquisition so a busy workspace never delays the prompt. A
 * timeout aborts this turn's queue ticket; the client's own abort still
 * surfaces as an error.
 */
async function acquireLeaseWithin(
  acquire: (signal?: AbortSignal) => Promise<TurnCheckpointLease | undefined>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<TurnCheckpointLease | undefined | "busy"> {
  if (timeoutMs === undefined) return acquire(signal);
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await acquire(controller.signal);
  } catch (error) {
    if (timedOut && !signal?.aborted) return "busy";
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

function ensureBeforeSnapshot<Snapshot>(capture: TurnCaptureState<Snapshot>): Promise<Snapshot | undefined> {
  if (capture.beforeStarted) return capture.beforeSnapshot;
  const factory = capture.beforeFactory;
  capture.beforeFactory = undefined;
  return factory?.() ?? Promise.resolve(undefined);
}

function startAfterSnapshot<Snapshot>(
  capture: TurnCaptureState<Snapshot>,
  createAfterSnapshot: () => Promise<Snapshot | undefined>,
): Promise<Snapshot | undefined> {
  if (capture.afterStarted) return capture.afterSnapshot ?? Promise.resolve(undefined);
  capture.afterStarted = true;
  capture.afterSnapshot = Promise.resolve()
    .then(createAfterSnapshot)
    .catch(() => undefined);
  return capture.afterSnapshot;
}

function reportLifecycleError<Snapshot>(
  adapter: TurnCheckpointLifecycleAdapter<Snapshot>,
  error: unknown,
  capture: TurnCaptureState<Snapshot>,
): void {
  try {
    adapter.onError?.(error, capture);
  } catch {
    // Error reporting is best effort. A failing notification must never stop
    // cleanup of the immutable refs that belong to this capture.
  }
}

function removeId(ids: string[], id: string): void {
  const index = ids.indexOf(id);
  if (index >= 0) ids.splice(index, 1);
}

export interface TurnCheckpointLifecycleOptions {
  /** How long a turn waits for the workspace lease before running without a checkpoint. */
  leaseTimeoutMs?: number;
}

/**
 * Shared Pi user-turn state machine. `agent_end` is deliberately not a turn
 * boundary: retries and queued follow-ups can follow it. A capture is assigned
 * at `input`/`turn_start` and finalized at the corresponding final `turn_end`.
 * Host and bridge provide only Git and durable transport adapters.
 */
export class TurnCheckpointLifecycle<Snapshot> {
  private readonly captures = new Map<string, TurnCaptureState<Snapshot>>();
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly queuedIds: string[] = [];
  private settling?: Promise<void>;
  private activeId: string | undefined;
  /** True when the current `turn_start` selected a new client capture. */
  private activeTurnFreshCapture = false;

  constructor(
    private readonly adapter: TurnCheckpointLifecycleAdapter<Snapshot>,
    private readonly options: TurnCheckpointLifecycleOptions = {},
  ) {}

  acceptUserTurn(id: string, options: AcceptTurnOptions = {}): TurnCaptureState<Snapshot> {
    const existing = this.captures.get(id);
    if (existing) return existing;
    let capture: TurnCaptureState<Snapshot>;
    capture = startTurnCapture(
      id,
      options.startedAt ?? Date.now(),
      () => this.adapter.createBefore(id),
      (error) => this.adapter.onError?.(error, capture),
      {
        // The lease is acquired before the first Git read. Queued messages keep
        // the factory deferred until Pi reaches their actual turn boundary.
        deferBefore: true,
        expectsInput: options.expectsInput,
        acquireLease: this.adapter.acquireLease ? (signal) => this.adapter.acquireLease!(id, signal) : undefined,
        leaseTimeoutMs: this.options.leaseTimeoutMs,
        onStatus: (status) => this.status(status, capture),
      },
    );
    this.captures.set(id, capture);
    this.queuedIds.push(id);
    this.status("queued", capture);
    if (!options.deferBefore) void ensureBeforeSnapshot(capture);
    return capture;
  }

  get(id: string): TurnCaptureState<Snapshot> | undefined { return this.captures.get(id); }

  get active(): TurnCaptureState<Snapshot> | undefined {
    return this.activeId ? this.captures.get(this.activeId) : undefined;
  }

  /** Includes captures whose persistence is still in flight. */
  get pendingCount(): number { return this.captures.size; }

  /** Returns the first accepted client turn that Pi has not delivered yet. */
  nextInputTurnId(): string | undefined {
    return this.queuedIds.find((id) => {
      const capture = this.captures.get(id);
      return Boolean(capture && capture.expectsInput !== false && !capture.inputSeen);
    });
  }

  /** Prepares an accepted idle prompt without pretending Pi has delivered it yet. */
  async prepare(id: string): Promise<void> {
    const capture = this.captures.get(id);
    if (!capture) return;
    await ensureBeforeSnapshot(capture);
  }

  /** Marks the next accepted client turn as delivered by Pi and starts its before boundary. */
  async acceptInput(id?: string, options: { deferBefore?: boolean } = {}): Promise<TurnCaptureState<Snapshot>> {
    let capture = id ? this.captures.get(id) : undefined;
    if (!capture) {
      capture = this.acceptUserTurn(id ?? `turn-${Date.now()}-${this.captures.size}`, { deferBefore: true });
    }
    capture.inputSeen = true;
    if (!options.deferBefore) await ensureBeforeSnapshot(capture);
    return capture;
  }

  /** Assigns one Pi `turn_start`; multiple low-level turns can share one user capture while tools run. */
  startTurn(): TurnCaptureState<Snapshot> | undefined {
    if (this.active) {
      this.active.started = true;
      return this.active;
    }
    const id = this.queuedIds.find((candidate) => {
      const capture = this.captures.get(candidate);
      return Boolean(capture && !capture.outcome && !capture.started
        && (capture.inputSeen || capture.beforeStarted || capture.expectsInput === false));
    });
    if (!id) return undefined;
    const capture = this.captures.get(id);
    if (!capture) return undefined;
    removeId(this.queuedIds, id);
    this.activeId = id;
    capture.started = true;
    return capture;
  }

  /**
   * Resolves a user message that Pi is about to deliver. Normal prompts have
   * already selected their capture at `turn_start`; direct steer/follow-up
   * APIs do not emit `input`, however, and can enqueue a second client turn
   * while the current capture is still in a tool-use phase.
   */
  async userMessage(): Promise<TurnCaptureState<Snapshot> | undefined> {
    if (this.active && this.activeTurnFreshCapture) {
      this.activeTurnFreshCapture = false;
      await ensureBeforeSnapshot(this.active);
      return this.active;
    }
    const queuedId = this.queuedIds.find((candidate) => {
      const capture = this.captures.get(candidate);
      return Boolean(capture && !capture.outcome && !capture.started
        && (capture.inputSeen || capture.expectsInput === false || capture.beforeStarted));
    });
    const queued = queuedId ? this.captures.get(queuedId) : undefined;
    if (!queued || queued === this.active) {
      const active = this.active;
      this.activeTurnFreshCapture = false;
      if (active) await ensureBeforeSnapshot(active);
      return active;
    }

    // A queued message can arrive after a tool-use turn whose assistant has no
    // final stop reason. That user turn is incomplete and must not become a
    // misleading checkpoint merely because a later prompt was delivered.
    const previous = this.active;
    if (previous) {
      if (previous.outcome === "completed") await this.captureAndPersist(previous);
      else await this.discard(previous);
    }

    const capture = this.startTurn();
    this.activeTurnFreshCapture = false;
    if (capture) await ensureBeforeSnapshot(capture);
    return capture;
  }

  /** Starts a Pi turn and fixes a deferred before boundary before tools run. */
  async beginTurn(): Promise<TurnCaptureState<Snapshot> | undefined> {
    const previous = this.active;
    if (previous?.outcome === "completed") await this.captureAndPersist(previous);
    const previousId = this.activeId;
    const capture = this.startTurn();
    this.activeTurnFreshCapture = Boolean(capture && capture.id !== previousId);
    if (capture) await ensureBeforeSnapshot(capture);
    return capture;
  }

  /** Handles one low-level turn_end; only a final assistant message completes a user turn. */
  async endTurn(
    message: unknown,
    anchorMessageId?: string,
    resolveAnchor?: () => string | undefined,
  ): Promise<void> {
    const capture = this.active ?? this.startTurn();
    if (!capture) return;
    recordTurnAssistant(capture, message);
    if (anchorMessageId) capture.anchorMessageId = anchorMessageId;
    if (!capture.anchorMessageId && resolveAnchor) capture.anchorFactory = resolveAnchor;
    const item = record(message);
    const stopReason = typeof item?.stopReason === "string" ? item.stopReason : undefined;
    if (stopReason === "toolUse") return;
    capture.terminalStopReason = stopReason;
    if (stopReason === "error" || stopReason === "aborted") return;
    if (stopReason === "length") return;
    capture.outcome = "completed";
    if (capture.skipped) return;
    // After capture is started at the assistant boundary; summary/persistence
    // remains on this thread's lifecycle queue and holds the lease.
    void startAfterSnapshot(capture, () => this.adapter.createAfter(capture.id));
  }

  /** `agent_end` only resolves failure/retry state; it never starts a checkpoint. */
  async endAgent(event: TurnOutcomeEvent): Promise<void> {
    const capture = this.active;
    if (!capture) return;
    recordTurnOutcome(capture, event);
    if (event.willRetry) {
      capture.outcome = undefined;
      return;
    }
    if (capture.outcome === "error" || capture.outcome === "aborted") await this.discard(capture);
  }

  /** Rejects an accepted prompt and removes its provisional ref. */
  async reject(id: string | undefined): Promise<void> {
    if (!id) return;
    const capture = this.captures.get(id);
    if (capture) await this.discard(capture);
  }

  /**
   * Finalizes captures on this thread's queue. A runtime's `agent_settled`
   * event is not necessarily session shutdown: Pi can still have accepted
   * follow-ups waiting for their own turn boundary. The non-final mode drains
   * only captures that reached a terminal assistant outcome and leaves those
   * queued client turns addressable by their original IDs.
   */
  async settle(options: { final?: boolean } = {}): Promise<void> {
    const final = options.final !== false;
    const captures = [...this.captures.values()]
      .filter((capture) => !this.finishing.has(capture.id))
      .filter((capture) => final || capture.started === true || capture.outcome !== undefined
        || capture.terminalStopReason === "error" || capture.terminalStopReason === "aborted"
        || capture.terminalStopReason === "length");
    for (const capture of captures) removeId(this.queuedIds, capture.id);
    if (this.activeId && captures.some((capture) => capture.id === this.activeId)) this.activeId = undefined;
    this.activeTurnFreshCapture = false;
    const operation = this.settleCaptures(captures);
    const previous = this.settling;
    const combined = previous ? Promise.all([previous, operation]).then(() => undefined) : operation;
    let settling!: Promise<void>;
    settling = combined.finally(() => {
      if (this.settling === settling) this.settling = undefined;
    });
    this.settling = settling;
    return settling;
  }

  private async settleCaptures(captures: readonly TurnCaptureState<Snapshot>[]): Promise<void> {
    for (const capture of captures) {
      if (!capture.outcome && capture.terminalStopReason === "length") capture.outcome = "completed";
      if (capture.outcome === "completed") await this.captureAndPersist(capture);
      else await this.discard(capture);
    }
  }

  /** Flushes the per-thread durable boundary when the session is replaced/closed. */
  async close(): Promise<void> { await this.settle(); }

  private async captureAndPersist(capture: TurnCaptureState<Snapshot>): Promise<void> {
    return this.finishOnce(capture, () => this.captureAndPersistOnce(capture));
  }

  private async captureAndPersistOnce(capture: TurnCaptureState<Snapshot>): Promise<void> {
    // A skipped capture owns no refs and no lease; there is nothing to persist or discard.
    if (capture.skipped) { await this.forget(capture); return; }
    if (!capture.anchorMessageId && capture.anchorFactory) {
      try { capture.anchorMessageId = capture.anchorFactory(); } catch (error) { reportLifecycleError(this.adapter, error, capture); }
    }
    if (!shouldPersistTurnCapture(capture) || !capture.anchorMessageId) {
      await this.discardOnce(capture);
      return;
    }
    let before: Snapshot | undefined;
    let after: Snapshot | undefined;
    try {
      before = await ensureBeforeSnapshot(capture);
      if (!before) throw new Error("The turn before snapshot was not created.");
      after = await startAfterSnapshot(capture, () => this.adapter.createAfter(capture.id));
      if (!after) throw new Error("The turn after snapshot was not created.");
      this.status("persisting", capture);
      const result: TurnCheckpointCaptureResult<Snapshot> = {
        beforeSnapshot: before,
        afterSnapshot: after,
        changes: boundedTurnCheckpointSummary(await this.adapter.summarize(before, after, capture.id)),
        anchorMessageId: capture.anchorMessageId,
        endedAt: Date.now(),
      };
      await this.adapter.persist(result, capture);
      this.status("ready", capture);
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
      await this.discardSnapshots(capture, [after, before]);
      await this.discardStartedPhases(capture, ["after", "before"]);
      this.status("failed", capture);
    } finally {
      await this.releaseLease(capture);
      await this.forget(capture);
    }
  }

  private async discard(capture: TurnCaptureState<Snapshot>): Promise<void> {
    return this.finishOnce(capture, () => this.discardOnce(capture));
  }

  private async discardOnce(capture: TurnCaptureState<Snapshot>): Promise<void> {
    capture.abortController?.abort();
    if (capture.skipped) { await this.forget(capture); return; }
    try {
      const after = capture.afterStarted ? await this.resolveSnapshot(capture, capture.afterSnapshot) : undefined;
      const before = capture.beforeStarted ? await this.resolveSnapshot(capture, capture.beforeSnapshot) : undefined;
      await this.discardSnapshots(capture, [after, before]);
      await this.discardStartedPhases(capture, ["after", "before"]);
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
    } finally {
      await this.releaseLease(capture);
      this.status("failed", capture);
      await this.forget(capture);
    }
  }

  private async finishOnce(capture: TurnCaptureState<Snapshot>, operation: () => Promise<void>): Promise<void> {
    const existing = this.finishing.get(capture.id);
    if (existing) return existing;
    const pending = operation();
    this.finishing.set(capture.id, pending);
    try {
      await pending;
    } finally {
      if (this.finishing.get(capture.id) === pending) this.finishing.delete(capture.id);
    }
  }

  private async resolveSnapshot(
    capture: TurnCaptureState<Snapshot>,
    snapshot: Promise<Snapshot | undefined> | undefined,
  ): Promise<Snapshot | undefined> {
    if (!snapshot) return undefined;
    try {
      return await snapshot;
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
      return undefined;
    }
  }

  private async discardSnapshots(
    capture: TurnCaptureState<Snapshot>,
    snapshots: readonly (Snapshot | undefined)[],
  ): Promise<void> {
    const present = snapshots.filter((snapshot): snapshot is Snapshot => snapshot !== undefined);
    const results = await Promise.allSettled(present.map((snapshot) => Promise.resolve().then(() => this.adapter.discardSnapshot(snapshot))));
    for (const result of results) if (result.status === "rejected") reportLifecycleError(this.adapter, result.reason, capture);
  }

  private async discardStartedPhases(
    capture: TurnCaptureState<Snapshot>,
    phases: readonly ("before" | "after")[],
  ): Promise<void> {
    if (!this.adapter.discardTurnSnapshot) return;
    for (const phase of phases) {
      const started = phase === "before" ? capture.beforeStarted : capture.afterStarted;
      if (!started) continue;
      try {
        await this.adapter.discardTurnSnapshot(capture.id, phase);
      } catch (error) {
        reportLifecycleError(this.adapter, error, capture);
      }
    }
  }

  private status(status: TurnCheckpointStatus, capture: TurnCaptureState<Snapshot>): void {
    try { this.adapter.onStatus?.(status, capture); } catch { /* status reporting is best effort */ }
  }

  private async releaseLease(capture: TurnCaptureState<Snapshot>): Promise<void> {
    const lease = capture.lease;
    capture.lease = undefined;
    if (!lease) return;
    try {
      await lease.release();
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
    }
  }

  private async forget(capture: TurnCaptureState<Snapshot>): Promise<void> {
    this.captures.delete(capture.id);
    removeId(this.queuedIds, capture.id);
    if (this.activeId === capture.id) this.activeId = undefined;
    if (this.activeId === undefined) this.activeTurnFreshCapture = false;
    try {
      await this.adapter.onReleased?.(capture);
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assistantFromMessages(messages: readonly unknown[]): { stopReason?: string; timestamp?: number } | undefined {
  const message = [...messages].reverse().map(record).find((candidate) => candidate?.role === "assistant");
  if (!message) return undefined;
  return {
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(finite(message.timestamp) ? { timestamp: message.timestamp } : {}),
  };
}

/** Shared outcome semantics: retries keep one turn identity until a final result. */
export function recordTurnOutcome<Snapshot>(capture: TurnCaptureState<Snapshot>, event: TurnOutcomeEvent): void {
  const assistant = assistantFromMessages(event.messages ?? []);
  if (event.willRetry) capture.outcome = undefined;
  if (!assistant) return;
  capture.lastAssistant = assistant;
  capture.terminalStopReason = assistant.stopReason;
  if (event.willRetry) return;
  if (assistant.stopReason === "toolUse" || assistant.stopReason === "length") capture.outcome = undefined;
  else if (assistant.stopReason === "aborted") capture.outcome = "aborted";
  else if (assistant.stopReason === "error") capture.outcome = "error";
  else capture.outcome = "completed";
}

/** Keep only the small assistant marker needed for lifecycle diagnostics. */
export function recordTurnAssistant<Snapshot>(capture: TurnCaptureState<Snapshot>, message: unknown): void {
  const item = record(message);
  if (item?.role !== "assistant") return;
  capture.lastAssistant = {
    ...(typeof item.stopReason === "string" ? { stopReason: item.stopReason } : {}),
    ...(finite(item.timestamp) ? { timestamp: item.timestamp } : {}),
  };
}

export function shouldPersistTurnCapture<Snapshot>(capture: TurnCaptureState<Snapshot>): boolean {
  return capture.started === true && capture.outcome === "completed";
}

export type {
  AcceptTurnOptions,
  TurnCaptureState,
  TurnCheckpointCaptureResult,
  TurnCheckpointLease,
  TurnCheckpointLifecycleAdapter,
  TurnCheckpointStatus,
  TurnOutcome,
  TurnOutcomeEvent,
} from "./turn-checkpoint-types.js";
