import type {
  UiChangedFile,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
} from "./contracts.js";

/** Outcome of one accepted user turn, independent of Pi's low-level retries. */
export type TurnOutcome = "completed" | "aborted" | "error";

export type TurnCheckpointStatus = "queued" | "waiting" | "capturing" | "persisting" | "ready" | "failed";

/** The lifecycle keeps this handle until the checkpoint entry is durable. */
export interface TurnCheckpointLease {
  release(): Promise<void> | void;
}

/**
 * State held for one client/user turn. Runtime objects and patch bytes do not
 * cross this transport-neutral seam.
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
  /** Durable assistant-entry anchor resolved by the transport at settle time. */
  anchorMessageId?: string;
  /** Resolve the anchor after Pi has persisted the terminal assistant entry. */
  anchorFactory?: () => string | undefined;
  /** Last terminal reason seen before agent_end confirms retry/failure. */
  terminalStopReason?: string;
  /** Shared workspace lease held from the before boundary through persistence. */
  lease?: TurnCheckpointLease;
  /** Cancels a queued lease acquisition when the client rejects its prompt. */
  abortController?: AbortController;
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
  /** Delete a phase by its deterministic id when capture failed before returning a snapshot. */
  discardTurnSnapshot?(turnId: string, phase: "before" | "after"): Promise<void> | void;
  /** Serialize mutations for one canonical workspace across runtimes/processes. */
  acquireLease?(turnId: string, signal?: AbortSignal): Promise<TurnCheckpointLease | undefined>;
  /** Persist only a bounded checkpoint record; patch bytes never cross this seam. */
  persist(result: TurnCheckpointCaptureResult<Snapshot>, capture: TurnCaptureState<Snapshot>): Promise<void>;
  onError?(error: unknown, capture: TurnCaptureState<Snapshot>): void;
  onStatus?(status: TurnCheckpointStatus, capture: TurnCaptureState<Snapshot>): void;
  /** Release transport/session references after all persistence and cleanup has settled. */
  onReleased?(capture: TurnCaptureState<Snapshot>): void | Promise<void>;
}

export interface AcceptTurnOptions {
  /** Follow-ups are accepted now but captured at Pi's later `input` event. */
  deferBefore?: boolean;
  /** Whether Pi will emit the extension `input` event for this accepted turn. */
  expectsInput?: boolean;
  startedAt?: number;
}

export interface StoredTurnCheckpoint extends UiTurnCheckpoint {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  /** Present only for fork batches until their commit journal entry is durable. */
  transactionId?: string;
}

/** Durable metadata for a pre-restore backup session and its workspace pair. */
export interface TurnRestoreBackup {
  version: 1;
  backupId: string;
  sessionId: string;
  turnId: string;
  sourceSessionId: string;
  sourceCheckpointId: string;
  cwd: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  createdAt: number;
}

/** Append-only journal marker for an all-or-nothing fork re-home. */
export interface TurnCheckpointBatch {
  transactionId: string;
  sessionId: string;
  checkpointIds: string[];
  state: "committed";
}

export type CheckpointPreviewFile = UiChangedFile;
