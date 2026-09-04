import type { ClientTurnIdentity, NewThreadRequestId, UiPromptAttachment } from "../shared/contracts.js";
import type { PiBridgeCommand, PiBridgeDescriptor, PiBridgePreparedPrompt, PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";

export interface NewSessionRequest {
  requestId: NewThreadRequestId;
  projectPath: string;
  initialPrompt?: string;
  attachments: readonly UiPromptAttachment[];
  identity?: ClientTurnIdentity;
  prepared?: PiBridgePreparedPrompt;
}

/**
 * Runtime ownership supplied by another process. The host depends on this
 * lifecycle and command boundary, not on the transport that implements it.
 */
export interface AttachedRuntimeBackend {
  readonly isAttached: boolean;
  readonly descriptor?: PiBridgeDescriptor;
  readonly snapshot?: PiBridgeSnapshot;
  owns(threadId: string | undefined): boolean;
  attach(cwd: string, sessionFile: string | undefined, options: { ownerPid?: number }, activationEpoch: number): Promise<boolean>;
  detach(cancelReconnect?: boolean): void;
  /**
   * Takes the thread back from Pi and returns its session file, or undefined
   * when Tau is not attached. Throws while Pi is actually running the thread:
   * repairing under its writer would race it.
   */
  releaseToHost(): Promise<string | undefined>;
  withoutAttaching<T>(work: () => Promise<T>): Promise<T>;
  send(command: PiBridgeCommand, timeoutMs?: number): Promise<unknown>;
  command(command: PiBridgeCommand, retainOnDisconnect?: boolean): Promise<unknown>;
  refreshSnapshot(): Promise<void>;
  adoptSnapshot(snapshot: PiBridgeSnapshot): void;
  requestNewSession(input: NewSessionRequest): Promise<{ snapshot?: PiBridgeSnapshot }>;
  cancelPendingNewSession(sessionId?: string): void;
}
