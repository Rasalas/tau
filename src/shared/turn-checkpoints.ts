import type {
  ChangeStatus,
  DiffLoadOptions,
  UiChangedFile,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
} from "./contracts.js";

/** Custom entries are part of the Pi session tree and therefore survive reloads and forks. */
export const TURN_CHECKPOINT_CUSTOM_TYPE = "tau.turn-checkpoint.v1";

/** Keep the persisted checkpoint small even when a turn changes thousands of files. */
export const MAX_TURN_CHECKPOINT_PREVIEW_FILES = 8;

const SNAPSHOT_REF_PREFIX = "refs/tau/checkpoints";

/** Git ref components are derived from IDs, never accepted as raw arguments. */
export function sanitizeTurnSnapshotComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, "-");
  if (!sanitized || sanitized === "." || sanitized === ".." || sanitized.includes("..") || sanitized.endsWith(".lock")) {
    throw new Error("Invalid turn checkpoint snapshot namespace.");
  }
  return sanitized;
}

/** Exact ref expected for one session/client-turn/phase tuple. */
export function turnSnapshotRef(
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
): string {
  return `${SNAPSHOT_REF_PREFIX}/${sanitizeTurnSnapshotComponent(sessionId)}/${sanitizeTurnSnapshotComponent(turnId)}/${phase}`;
}

/** Exact ref expected when a caller already has a namespaced session/turn string. */
export function namespacedSnapshotRef(namespace: string, phase: "before" | "after"): string {
  const components = namespace.split("/").map(sanitizeTurnSnapshotComponent);
  if (components.length === 0) throw new Error("Invalid turn checkpoint snapshot namespace.");
  return `${SNAPSHOT_REF_PREFIX}/${components.join("/")}/${phase}`;
}

/**
 * A persisted checkpoint contains only immutable snapshot references and a
 * bounded summary. The file patch is deliberately not stored here: it is read
 * from Git when the user opens one file in the historical review.
 */
export interface StoredTurnCheckpoint extends UiTurnCheckpoint {
  beforeSnapshotId: string;
  afterSnapshotId: string;
}

const SNAPSHOT_ID_PATTERN = /^refs\/tau\/checkpoints\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/(?:before|after)$/u;

/** Snapshot IDs are refs created by the host, never arbitrary Git arguments. */
export function isTurnSnapshotId(value: unknown): value is string {
  if (typeof value !== "string" || !SNAPSHOT_ID_PATTERN.test(value)) return false;
  const components = value.split("/").slice(3, -1);
  return components.every((component) => component !== "."
    && component !== ".."
    && !component.includes("..")
    && !component.endsWith(".lock"));
}

export type TurnOutcome = "completed" | "aborted" | "error";

/**
 * Shared lifecycle state used by both the embedded host and the Pi bridge.
 * `Snapshot` is intentionally opaque to this transport-neutral module: the
 * host-side Git adapter owns how a snapshot is captured and addressed.
 */
export interface TurnCaptureState<Snapshot = unknown> {
  id: string;
  startedAt: number;
  beforeSnapshot: Promise<Snapshot | undefined>;
  /** Set once Pi has accepted this user message and entered its turn. */
  started?: boolean;
  /** Set when the input event for this client turn is actually delivered. */
  inputSeen?: boolean;
  /** Direct steer/follow-up APIs bypass Pi's `input` event. */
  expectsInput?: boolean;
  /** Internal lazy factory used for queued follow-ups. */
  beforeFactory?: () => Promise<Snapshot | undefined>;
  beforeStarted?: boolean;
  /** Provisional after boundary started at the terminal assistant event. */
  afterSnapshot?: Promise<Snapshot | undefined>;
  afterStarted?: boolean;
  outcome?: TurnOutcome;
  lastAssistant?: { stopReason?: string; timestamp?: number };
  /** Durable assistant-entry anchor resolved by the transport at turn_end. */
  anchorMessageId?: string;
  /** Last terminal reason seen before agent_end confirms retry/failure. */
  terminalStopReason?: string;
}

export interface TurnOutcomeEvent {
  messages?: readonly unknown[];
  willRetry?: boolean;
}

export interface TurnCheckpointCaptureResult<Snapshot> {
  beforeSnapshot: Snapshot;
  afterSnapshot: Snapshot;
  changes: UiWorkspaceChanges;
  anchorMessageId: string;
  endedAt: number;
}

export interface TurnCheckpointLifecycleAdapter<Snapshot> {
  createBefore(turnId: string): Promise<Snapshot | undefined>;
  createAfter(turnId: string): Promise<Snapshot | undefined>;
  summarize(before: Snapshot, after: Snapshot, turnId: string): Promise<UiWorkspaceChanges>;
  /** Delete a provisional snapshot. Completed refs remain owned by the session. */
  discardSnapshot(snapshot: Snapshot): Promise<void> | void;
  /** Persist only a bounded checkpoint record; patch bytes must never cross this seam. */
  persist(result: TurnCheckpointCaptureResult<Snapshot>, capture: TurnCaptureState<Snapshot>): Promise<void>;
  onError?(error: unknown, capture: TurnCaptureState<Snapshot>): void;
}

export interface AcceptTurnOptions {
  /** Follow-ups are accepted now but captured at Pi's later `input` event. */
  deferBefore?: boolean;
  /** Whether Pi will emit the extension `input` event for this accepted turn. */
  expectsInput?: boolean;
  startedAt?: number;
}

/** Shared before-boundary creation used by both the desktop host and bridge. */
export function startTurnCapture<Snapshot>(
  id: string,
  startedAt: number,
  createBeforeSnapshot: () => Promise<Snapshot | undefined>,
  onError?: (error: unknown) => void,
  options: { deferBefore?: boolean; expectsInput?: boolean } = {},
): TurnCaptureState<Snapshot> {
  const start = () => {
    const beforeSnapshot = Promise.resolve()
      .then(createBeforeSnapshot)
      .catch((error) => {
        onError?.(error);
        return undefined;
      });
    return beforeSnapshot;
  };
  return {
    id,
    startedAt,
    beforeSnapshot: options.deferBefore ? Promise.resolve(undefined) : start(),
    ...(options.deferBefore ? { beforeFactory: start } : {}),
    beforeStarted: !options.deferBefore,
    expectsInput: options.expectsInput !== false,
    started: false,
  };
}

function ensureBeforeSnapshot<Snapshot>(capture: TurnCaptureState<Snapshot>): Promise<Snapshot | undefined> {
  if (capture.beforeStarted) return capture.beforeSnapshot;
  capture.beforeStarted = true;
  capture.beforeSnapshot = capture.beforeFactory?.() ?? Promise.resolve(undefined);
  capture.beforeFactory = undefined;
  return capture.beforeSnapshot;
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

/**
 * Shared Pi user-turn state machine. `agent_end` is deliberately not a turn
 * boundary: retries and queued follow-ups can follow it. A capture is assigned
 * at `input`/`turn_start` and finalized at the corresponding final `turn_end`.
 * Host and bridge provide only the Git and durable transport adapters.
 */
export class TurnCheckpointLifecycle<Snapshot> {
  private readonly captures = new Map<string, TurnCaptureState<Snapshot>>();
  private readonly queuedIds: string[] = [];
  /** Settled turn writes continue off the Pi event path and never block another thread. */
  private readonly writes = new Set<Promise<void>>();
  private activeId: string | undefined;
  /** True when the current `turn_start` selected a new client capture. */
  private activeTurnFreshCapture = false;

  constructor(private readonly adapter: TurnCheckpointLifecycleAdapter<Snapshot>) {}

  acceptUserTurn(id: string, options: AcceptTurnOptions = {}): TurnCaptureState<Snapshot> {
    const existing = this.captures.get(id);
    if (existing) return existing;
    let capture: TurnCaptureState<Snapshot>;
    capture = startTurnCapture(
      id,
      options.startedAt ?? Date.now(),
      () => this.adapter.createBefore(id),
      (error) => this.adapter.onError?.(error, capture),
      { deferBefore: options.deferBefore, expectsInput: options.expectsInput },
    );
    this.captures.set(id, capture);
    this.queuedIds.push(id);
    return capture;
  }

  get(id: string): TurnCaptureState<Snapshot> | undefined {
    return this.captures.get(id);
  }

  get active(): TurnCaptureState<Snapshot> | undefined {
    return this.activeId ? this.captures.get(this.activeId) : undefined;
  }

  get pendingCount(): number {
    return this.captures.size + this.writes.size;
  }

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
        // Direct `AgentSession.steer/followUp` calls do not emit Pi's input
        // event. `beforeFactory` is the explicit accepted-but-deferred marker
        // for that path; the actual before boundary is still made here.
        && (capture.inputSeen || capture.beforeStarted || capture.beforeFactory));
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
   * while the current capture is still in a tool-use phase. In that case the
   * message boundary is the only reliable point at which to hand ownership to
   * the queued capture.
   */
  async userMessage(): Promise<TurnCaptureState<Snapshot> | undefined> {
    // `turn_start` is emitted before the queued user's `message_start`. When
    // that start already selected a fresh capture, this message belongs to it;
    // a second queued capture must wait for the next turn_start.
    if (this.active && this.activeTurnFreshCapture) {
      this.activeTurnFreshCapture = false;
      await ensureBeforeSnapshot(this.active);
      return this.active;
    }
    const queuedId = this.queuedIds.find((candidate) => {
      const capture = this.captures.get(candidate);
      return Boolean(capture && !capture.outcome && !capture.started
        && (capture.inputSeen || capture.expectsInput === false || capture.beforeStarted || capture.beforeFactory));
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
      if (previous.outcome === "completed") await this.captureAndQueuePersistence(previous);
      else await this.discard(previous);
    }

    const capture = this.startTurn();
    this.activeTurnFreshCapture = false;
    if (capture) await ensureBeforeSnapshot(capture);
    return capture;
  }

  /**
   * Starts a Pi turn and fixes a deferred before boundary before tools run.
   * A completed preceding capture is finalized first; this is the precise
   * boundary immediately before a queued user message starts.
   */
  async beginTurn(): Promise<TurnCaptureState<Snapshot> | undefined> {
    const previous = this.active;
    if (previous?.outcome === "completed") await this.captureAndQueuePersistence(previous);
    const previousId = this.activeId;
    const capture = this.startTurn();
    this.activeTurnFreshCapture = Boolean(capture && capture.id !== previousId);
    if (capture) await ensureBeforeSnapshot(capture);
    return capture;
  }

  /**
   * Handles one low-level `turn_end`; only non-tool-use assistant messages
   * complete a user turn. The actual after boundary is deferred until the
   * next Pi turn (for a queued follow-up) or `agent_settled` (for the final
   * turn), so an `agent_end`/retry cannot accidentally close the wrong turn.
   */
  async endTurn(message: unknown, anchorMessageId?: string): Promise<void> {
    const capture = this.active ?? this.startTurn();
    if (!capture) return;
    recordTurnAssistant(capture, message);
    if (anchorMessageId) capture.anchorMessageId = anchorMessageId;
    const item = record(message);
    const stopReason = typeof item?.stopReason === "string" ? item.stopReason : undefined;
    if (stopReason === "toolUse") return;
    capture.terminalStopReason = stopReason;
    if (stopReason === "error" || stopReason === "aborted") return;
    // Pi can auto-compact and retry after a length stop. Keep this capture
    // active until the retry's final assistant boundary (or settle confirms
    // that no retry followed).
    if (stopReason === "length") return;
    capture.outcome = "completed";
    // Start the immutable after capture at the assistant boundary. The Git
    // operation is kicked off on this thread's queue, while its result and all
    // summary/persistence work remain independent of the global settled signal.
    void startAfterSnapshot(capture, () => this.adapter.createAfter(capture.id));
  }

  /** `agent_end` only resolves failure/retry state; it never starts a new checkpoint. */
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

  /** Rejects an accepted prompt (including extension-command handling) and removes its provisional ref. */
  async reject(id: string | undefined): Promise<void> {
    if (!id) return;
    const capture = this.captures.get(id);
    if (capture) await this.discard(capture);
  }

  /**
   * Finalizes the last successful user turn and discards only unfinished
   * captures when Pi settles. Completed snapshots are then written in the
   * background; the settled event does not wait for summary/transport I/O.
   */
  async settle(): Promise<void> {
    const captures = [...this.captures.values()];
    for (const capture of captures) {
      if (!capture.outcome && capture.terminalStopReason === "length") capture.outcome = "completed";
      // `agent_settled` is a global Pi lifecycle signal. Start finalization in
      // this thread's background queue and return immediately; a session close
      // uses `close()` when it really needs to flush it.
      this.forget(capture);
      const operation = capture.outcome === "completed"
        ? this.captureAndQueuePersistence(capture)
        : this.discard(capture);
      this.trackWrite(operation);
    }
    // Settled writes belong to completed checkpoints and must survive a run
    // boundary. They are intentionally not awaited here: Pi's global settled
    // broadcast and other threads must not wait for Git summary/persistence.
    this.queuedIds.length = 0;
    this.activeId = undefined;
    this.activeTurnFreshCapture = false;
  }

  /** Flushes completed writes when the session itself is being replaced/closed. */
  async close(): Promise<void> {
    await this.settle();
    while (this.writes.size > 0) await Promise.allSettled([...this.writes]);
  }

  /** Capture the after boundary on the awaited turn event, then do summary and persistence off-path. */
  private async captureAndQueuePersistence(capture: TurnCaptureState<Snapshot>): Promise<void> {
    if (!shouldPersistTurnCapture(capture) || !capture.anchorMessageId) {
      await this.discard(capture);
      return;
    }
    let before: Snapshot | undefined;
    let after: Snapshot | undefined;
    try {
      before = await ensureBeforeSnapshot(capture);
      if (!before) throw new Error("The turn before snapshot was not created.");
      after = await startAfterSnapshot(capture, () => this.adapter.createAfter(capture.id));
      if (!after) throw new Error("The turn after snapshot was not created.");
      const resultWithoutSummary = { beforeSnapshot: before, afterSnapshot: after, anchorMessageId: capture.anchorMessageId, endedAt: Date.now() };
      this.forget(capture);
      const write = this.persistCapturedSnapshots(capture, resultWithoutSummary);
      this.trackWrite(write);
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
      await this.discardSnapshots(capture, [after, before]);
      this.forget(capture);
    }
  }

  private async persistCapturedSnapshots(
    capture: TurnCaptureState<Snapshot>,
    boundary: Omit<TurnCheckpointCaptureResult<Snapshot>, "changes">,
  ): Promise<void> {
    try {
      const result: TurnCheckpointCaptureResult<Snapshot> = {
        ...boundary,
        // The Git adapter may inspect the complete name/status result locally,
        // but the persistence seam receives only the bounded record shape.
        changes: boundedTurnCheckpointSummary(await this.adapter.summarize(
          boundary.beforeSnapshot,
          boundary.afterSnapshot,
          capture.id,
        )),
      };
      await this.adapter.persist(result, capture);
    } catch (error) {
      reportLifecycleError(this.adapter, error, capture);
      await this.discardSnapshots(capture, [boundary.afterSnapshot, boundary.beforeSnapshot]);
    }
  }

  private async discard(capture: TurnCaptureState<Snapshot>): Promise<void> {
    // Rejecting a queued prompt before Pi delivered it must not create a
    // snapshot merely to delete it. If either boundary already started, await
    // it so no provisional ref can leak after rejection/abort/error.
    try {
      const after = capture.afterStarted ? await this.resolveSnapshot(capture, capture.afterSnapshot) : undefined;
      const before = capture.beforeStarted ? await this.resolveSnapshot(capture, capture.beforeSnapshot) : undefined;
      await this.discardSnapshots(capture, [after, before]);
    } catch (error) {
      // Promise rejections are not expected from the built-in capture
      // factories, but custom adapters/tests may supply them. Keep the state
      // machine recoverable and still remove the capture from the queue.
      reportLifecycleError(this.adapter, error, capture);
    } finally {
      this.forget(capture);
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
    for (const result of results) {
      if (result.status === "rejected") reportLifecycleError(this.adapter, result.reason, capture);
    }
  }

  private trackWrite(write: Promise<void>): void {
    this.writes.add(write);
    void write.then(
      () => this.writes.delete(write),
      () => this.writes.delete(write),
    );
  }

  private forget(capture: TurnCaptureState<Snapshot>): void {
    this.captures.delete(capture.id);
    removeId(this.queuedIds, capture.id);
    if (this.activeId === capture.id) this.activeId = undefined;
    if (this.activeId === undefined) this.activeTurnFreshCapture = false;
  }
}

/**
 * Shared after-boundary and summary lifecycle. Transports provide only their
 * Git adapter and durable assistant anchor; no wire/session implementation is
 * coupled to this module.
 */
export async function completeTurnCapture<Snapshot>(
  capture: TurnCaptureState<Snapshot>,
  options: {
    createAfterSnapshot: () => Promise<Snapshot | undefined>;
    summarize: (before: Snapshot, after: Snapshot) => Promise<UiWorkspaceChanges>;
    anchorMessageId?: string;
  },
): Promise<TurnCheckpointCaptureResult<Snapshot> | undefined> {
  if (!shouldPersistTurnCapture(capture)) return undefined;
  const beforeSnapshot = await ensureBeforeSnapshot(capture);
  if (!beforeSnapshot || !options.anchorMessageId) return undefined;
  const afterSnapshot = await options.createAfterSnapshot();
  if (!afterSnapshot) return undefined;
  return {
    beforeSnapshot,
    afterSnapshot,
    changes: await options.summarize(beforeSnapshot, afterSnapshot),
    anchorMessageId: options.anchorMessageId,
    endedAt: Date.now(),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function status(value: unknown): value is ChangeStatus {
  return value === "modified" || value === "added" || value === "deleted"
    || value === "renamed" || value === "untracked";
}

function changedFile(value: unknown): UiChangedFile | undefined {
  const item = record(value);
  if (!item
    || typeof item.path !== "string"
    || typeof item.name !== "string"
    || typeof item.directory !== "string"
    || !status(item.status)
    || !finite(item.added)
    || !finite(item.removed)
  ) return undefined;
  return {
    path: item.path,
    name: item.name,
    directory: item.directory,
    status: item.status,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
  };
}

export function cloneTurnCheckpoint(checkpoint: UiTurnCheckpoint): UiTurnCheckpoint {
  const files = checkpoint.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES);
  const fileCount = checkpoint.fileCount === undefined
    ? checkpoint.files.length
    : Math.max(files.length, checkpoint.fileCount);
  return {
    ...checkpoint,
    files: files.map((file) => ({ ...file })),
    fileCount,
  };
}

export function cloneStoredTurnCheckpoint(checkpoint: StoredTurnCheckpoint): StoredTurnCheckpoint {
  return {
    ...cloneTurnCheckpoint(checkpoint),
    beforeSnapshotId: checkpoint.beforeSnapshotId,
    afterSnapshotId: checkpoint.afterSnapshotId,
  };
}

/** Parse untrusted session data without allowing malformed entries into the UI. */
export function parseStoredTurnCheckpoint(value: unknown, expectedSessionId?: string): StoredTurnCheckpoint | undefined {
  const item = record(value);
  if (!item
    || typeof item.id !== "string"
    || typeof item.turnId !== "string"
    || item.id !== item.turnId
    || typeof item.sessionId !== "string"
    || (expectedSessionId !== undefined && item.sessionId !== expectedSessionId)
    || typeof item.anchorMessageId !== "string"
    || !isTurnSnapshotId(item.beforeSnapshotId)
    || !isTurnSnapshotId(item.afterSnapshotId)
    || !finite(item.startedAt)
    || !finite(item.endedAt)
    || !Array.isArray(item.files)
    || !finite(item.added)
    || !finite(item.removed)
  ) return undefined;
  // A stale/legacy session may contain an unbounded `files` array. Inspect and
  // clone only the preview allowed across the transport seam.
  const files = item.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES).map(changedFile);
  if (!files.every((file): file is UiChangedFile => Boolean(file))) return undefined;
  let expectedBefore: string;
  let expectedAfter: string;
  try {
    expectedBefore = turnSnapshotRef(item.sessionId, item.turnId, "before");
    expectedAfter = turnSnapshotRef(item.sessionId, item.turnId, "after");
  } catch {
    return undefined;
  }
  if (item.beforeSnapshotId !== expectedBefore || item.afterSnapshotId !== expectedAfter) return undefined;
  const fileCount = item.fileCount === undefined
    ? item.files.length
    : (typeof item.fileCount === "number" && Number.isSafeInteger(item.fileCount) && item.fileCount >= 0 ? item.fileCount : -1);
  if (fileCount < files.length) return undefined;
  const checkpoint: StoredTurnCheckpoint = {
    id: item.id,
    turnId: item.turnId,
    sessionId: item.sessionId,
    anchorMessageId: item.anchorMessageId,
    beforeSnapshotId: item.beforeSnapshotId,
    afterSnapshotId: item.afterSnapshotId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    files: files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES),
    fileCount,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
    ...(typeof item.branch === "string" ? { branch: item.branch } : {}),
  };
  return cloneStoredTurnCheckpoint(checkpoint);
}

/** Read checkpoints from the active Pi branch, preserving their append order. */
export function turnCheckpointsFromEntries(
  entries: readonly unknown[],
  sessionId?: string,
): StoredTurnCheckpoint[] {
  const seen = new Set<string>();
  const result: StoredTurnCheckpoint[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || item.type !== "custom" || item.customType !== TURN_CHECKPOINT_CUSTOM_TYPE) continue;
    const checkpoint = parseStoredTurnCheckpoint(item.data, sessionId);
    if (!checkpoint || seen.has(checkpoint.id)) continue;
    seen.add(checkpoint.id);
    result.push(checkpoint);
  }
  return result;
}

export function summariesFromStoredTurnCheckpoints(
  checkpoints: readonly StoredTurnCheckpoint[],
): UiTurnCheckpoint[] {
  return checkpoints.map(cloneTurnCheckpoint);
}

/** Convert a full Git summary into the only file data allowed in a checkpoint entry. */
export function boundedTurnCheckpointSummary(changes: UiWorkspaceChanges): Pick<UiTurnCheckpoint, "files" | "fileCount" | "added" | "removed" | "branch"> {
  const files = changes.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES);
  const fileCount = changes.fileCount === undefined
    ? changes.files.length
    : (Number.isSafeInteger(changes.fileCount) && changes.fileCount >= files.length
      ? changes.fileCount
      : changes.files.length);
  return {
    ...(changes.branch ? { branch: changes.branch } : {}),
    files: files.map((file) => ({ ...file })),
    fileCount,
    added: Math.max(0, changes.added),
    removed: Math.max(0, changes.removed),
  };
}

function fileEqual(left: UiChangedFile | undefined, right: UiChangedFile): boolean {
  return Boolean(left
    && left.status === right.status
    && left.added === right.added
    && left.removed === right.removed);
}

function turnStats(before: UiChangedFile | undefined, after: UiChangedFile): { added: number; removed: number } {
  if (!before) return { added: after.added, removed: after.removed };
  const addedDelta = after.added - before.added;
  const removedDelta = after.removed - before.removed;
  return {
    added: Math.max(0, addedDelta) + Math.max(0, -removedDelta),
    removed: Math.max(0, removedDelta) + Math.max(0, -addedDelta),
  };
}

/** Legacy renderer activity helper; persisted checkpoints use Git snapshots instead. */
export function changesSinceTurn(
  baseline: UiWorkspaceChanges | undefined,
  current: UiWorkspaceChanges,
): UiWorkspaceChanges {
  if (!baseline) return { branch: current.branch, files: [], added: 0, removed: 0 };
  const beforeByPath = new Map(baseline.files.map((file) => [file.path, file]));
  const files = current.files.flatMap((file) => {
    const before = beforeByPath.get(file.path);
    if (fileEqual(before, file)) return [];
    return [{ ...file, ...turnStats(before, file) }];
  });
  return {
    branch: current.branch,
    refreshStatus: current.refreshStatus,
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

/**
 * Keep diff paging bounded at the shared seam. Both host implementations pass
 * these values to the Git adapter, which loads exactly the requested file.
 */
export function normalizeDiffLoadOptions(
  options: DiffLoadOptions | undefined,
  maxHunks: number,
): Required<DiffLoadOptions> {
  const offset = Number.isFinite(options?.hunkOffset) ? Math.max(0, Math.floor(options?.hunkOffset ?? 0)) : 0;
  const limit = Number.isFinite(options?.hunkLimit)
    ? Math.min(maxHunks, Math.max(1, Math.floor(options?.hunkLimit ?? maxHunks)))
    : maxHunks;
  return { hunkOffset: offset, hunkLimit: limit };
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
  if (event.willRetry) {
    return;
  } else if (assistant.stopReason === "toolUse") {
    capture.outcome = undefined;
  } else if (assistant.stopReason === "length") {
    // A recoverable length stop can be followed by auto-compaction and another
    // turn for the same user message. `settle()` promotes it only when no retry
    // arrived.
    capture.outcome = undefined;
  } else if (assistant.stopReason === "aborted") {
    capture.outcome = "aborted";
  } else if (assistant.stopReason === "error") {
    capture.outcome = "error";
  } else {
    capture.outcome = "completed";
  }
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
