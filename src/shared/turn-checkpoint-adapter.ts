import { createStoredTurnCheckpoint } from "./turn-checkpoint-codec.js";
import type {
  StoredTurnCheckpoint,
  TurnCaptureState,
  TurnCheckpointCaptureResult,
  TurnCheckpointLease,
  TurnCheckpointLifecycleAdapter,
  TurnCheckpointStatus,
} from "./turn-checkpoint-types.js";
import type { UiWorkspaceChanges } from "./workspace-kit-types.js";

/**
 * Runtime-specific hooks for the shared checkpoint lifecycle. Host and bridge
 * both use this factory so record validation, bounded persistence, and status
 * forwarding cannot drift between transports.
 */
export interface TurnCheckpointAdapterOptions<Snapshot extends { id: string }> {
  sessionIdForTurn(turnId: string): string | undefined;
  createBefore(turnId: string): Promise<Snapshot | undefined>;
  createAfter(turnId: string): Promise<Snapshot | undefined>;
  summarize(before: Snapshot, after: Snapshot, turnId: string): Promise<UiWorkspaceChanges>;
  discardSnapshot(snapshot: Snapshot): Promise<void> | void;
  discardTurnSnapshot?(turnId: string, phase: "before" | "after"): Promise<void> | void;
  acquireLease?(turnId: string, signal?: AbortSignal): Promise<TurnCheckpointLease | undefined>;
  /** Append one already validated, bounded record to the durable session. */
  appendCheckpoint(
    checkpoint: StoredTurnCheckpoint,
    result: TurnCheckpointCaptureResult<Snapshot>,
    capture: TurnCaptureState<Snapshot>,
  ): Promise<void>;
  onError?(error: unknown, capture: TurnCaptureState<Snapshot>): void;
  onStatus?(status: TurnCheckpointStatus, capture: TurnCaptureState<Snapshot>): void;
  onReleased?(capture: TurnCaptureState<Snapshot>): void | Promise<void>;
}

/** Build the one lifecycle adapter shared by embedded host and Pi bridge. */
export function createTurnCheckpointAdapter<Snapshot extends { id: string }>(
  options: TurnCheckpointAdapterOptions<Snapshot>,
): TurnCheckpointLifecycleAdapter<Snapshot> {
  return {
    createBefore: options.createBefore,
    createAfter: options.createAfter,
    summarize: options.summarize,
    discardSnapshot: options.discardSnapshot,
    ...(options.discardTurnSnapshot ? { discardTurnSnapshot: options.discardTurnSnapshot } : {}),
    ...(options.acquireLease ? { acquireLease: options.acquireLease } : {}),
    persist: async (result, capture) => {
      const sessionId = options.sessionIdForTurn(capture.id);
      if (!sessionId) throw new Error("The turn checkpoint session is unavailable.");
      const checkpoint = createStoredTurnCheckpoint(result, capture, sessionId);
      await options.appendCheckpoint(checkpoint, result, capture);
    },
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.onReleased ? { onReleased: options.onReleased } : {}),
  };
}
