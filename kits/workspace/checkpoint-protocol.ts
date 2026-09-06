/**
 * The slice of Workspace Kit's contract that Tau's own Pi extension reads.
 * `.pi/extensions/tau-session-bridge.ts` runs under jiti and NodeNext, where
 * `tau` does not resolve, so this leaf names only `tau/host-extension` — whose
 * types come from the same `src/shared` declarations `tau` publishes.
 * `protocol.ts` re-exports everything here; nothing else imports this file
 * directly (ticket 09 splits the bridge and folds it back in).
 */
import type { TurnCheckpointStatus, UiTurnCheckpoint } from "tau/host-extension";

export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

/** Published for every checkpoint the host records or whose capture status changes. */
export const CHECKPOINT_EVENT = "checkpoint";

export interface WorkspaceCheckpointList {
  checkpoints: UiTurnCheckpoint[];
  /** Whether completed checkpoints can restore this thread; false while Pi owns it. */
  restoreSupported: boolean;
}

export type CheckpointEvent =
  | { type: "turn-checkpoint"; sessionId: string; checkpoint: UiTurnCheckpoint }
  | { type: "turn-checkpoint-status"; sessionId: string; turnId: string; status: TurnCheckpointStatus }
  | { type: "turn-checkpoint-error"; sessionId: string; turnId: string; message: string };
