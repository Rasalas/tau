import type { UiMessage } from "../shared/contracts";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";

export type TranscriptNavigationScope =
  | { kind: "session"; projectPath?: string; sessionId: string }
  | { kind: "draft"; projectPath: string; draftId: string };

export function transcriptNavigationScopesEqual(
  left: TranscriptNavigationScope | undefined,
  right: TranscriptNavigationScope | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  if (left.kind === "draft" && right.kind === "draft") {
    return left.projectPath === right.projectPath && left.draftId === right.draftId;
  }
  if (left.kind === "session" && right.kind === "session") {
    return left.projectPath === right.projectPath && left.sessionId === right.sessionId;
  }
  return false;
}

/** The logical send that owns an anchored, streaming turn. */
export interface TranscriptTurnStart {
  /** Stable ID for the logical send, independent of any persisted message ID. */
  turnId: string;
  /** Discriminated semantic scope; draft IDs are never represented as sessions. */
  scope?: TranscriptNavigationScope;
  sessionId?: string;
  messageId?: string;
  /** Stable client ID used when Pi expands the submitted text. */
  clientMessageId?: string;
  text?: string;
  timestamp?: number;
  awaitingMessage?: boolean;
  preserveAcrossSessionChange?: boolean;
  /** Workbench-owned semantic transcript scope; navigation ignores stale scopes. */
  scopeKey?: string;
}

export interface TranscriptMessageLookup {
  byId: ReadonlyMap<string, UiMessage>;
  byClientIdentity: ReadonlyMap<string, UiMessage>;
  byText: ReadonlyMap<string, readonly UiMessage[]>;
  positions: ReadonlyMap<string, number>;
}

export type ScrollIntent = "older" | "newer";

export interface TranscriptNavigationState {
  sessionId?: string;
  scopeKey?: string;
  scope?: TranscriptNavigationScope;
  turnId?: string;
  anchorId?: string;
  anchorPending: boolean;
  anchorLocked: boolean;
  anchorSuppressed: boolean;
  following: boolean;
  scrollIntent?: ScrollIntent;
  lastTouchY?: number;
  lastScrollTop?: number;
  touchActive: boolean;
  pointerDown: boolean;
}

export interface TranscriptNavigationOptions {
  sessionId?: string;
  scopeKey?: string;
  scope?: TranscriptNavigationScope;
  /** Kept at the adapter boundary so lookup invalidation and navigation share one update. */
  lookupRevision?: number;
  turnStart?: TranscriptTurnStart;
  messages: UiMessage[];
  lookup?: TranscriptMessageLookup;
  onAnchorChange(id?: string): void;
}

export function clientIdentityKey(turnId: string, messageId: string): string {
  return `${turnId}\u0000${messageId}`;
}

export function resolveTurnMessage(
  messages: readonly UiMessage[],
  turnStart?: TranscriptTurnStart,
  lookup?: TranscriptMessageLookup,
): UiMessage | undefined {
  if (!turnStart) return undefined;
  if (turnStart.clientMessageId) {
    const byClientIdentity = lookup?.byClientIdentity.get(clientIdentityKey(turnStart.turnId, turnStart.clientMessageId))
      ?? messages.find((message) => message.role === "user"
        && message.clientTurnId === turnStart.turnId
        && message.clientMessageId === turnStart.clientMessageId);
    if (byClientIdentity) return byClientIdentity;
  }
  if (turnStart.messageId) {
    const byId = lookup?.byId.get(turnStart.messageId)
      ?? messages.find((message) => message.id === turnStart.messageId);
    // An authoritative explicit identity is never demoted to a legacy ID or
    // text match. This prevents an out-of-order message from stealing the
    // optimistic anchor.
    if (byId && matchesTranscriptTurnMessage(byId, turnStart)) return byId;
  }
  if (turnStart.text === undefined) return undefined;
  const candidates = lookup?.byText.get(turnStart.text);
  const matching = (candidates ? [...candidates].reverse() : [...messages].reverse())
    .find((message) => matchesTranscriptTurnMessage(message, turnStart));
  if (matching) return matching;
  if (turnStart.awaitingMessage) return undefined;
  // Persisted entries can use a different clock or test fixture epoch. The
  // logical turn ID is authoritative, so an exact text match is a safe
  // fallback when no ID survived reconciliation.
  return (candidates ? [...candidates].reverse() : [...messages].reverse())
    .find((message) => matchesTranscriptTurnMessage(message, turnStart, { allowUnclockedTextFallback: true }));
}

export function setAnchor(
  state: TranscriptNavigationState,
  id: string | undefined,
  onAnchorChange: (id?: string) => void,
): void {
  state.anchorId = id;
  onAnchorChange(id);
}

export function resetNavigation(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.sessionId = options.sessionId;
  state.scopeKey = options.scopeKey;
  state.scope = options.scope;
  state.turnId = options.turnStart?.turnId;
  const target = resolveTurnMessage(options.messages, options.turnStart, options.lookup);
  state.anchorPending = Boolean(options.turnStart);
  state.anchorLocked = false;
  state.anchorSuppressed = false;
  state.following = true;
  state.scrollIntent = undefined;
  state.lastTouchY = undefined;
  state.lastScrollTop = undefined;
  state.touchActive = false;
  state.pointerDown = false;
  setAnchor(state, target?.id, options.onAnchorChange);
}

export function startTurn(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.turnId = options.turnStart?.turnId;
  state.scopeKey = options.scopeKey;
  state.scope = options.turnStart?.scope;
  state.anchorPending = Boolean(options.turnStart);
  state.anchorLocked = false;
  state.anchorSuppressed = false;
  state.following = true;
  state.scrollIntent = undefined;
  setAnchor(
    state,
    resolveTurnMessage(options.messages, options.turnStart, options.lookup)?.id,
    options.onAnchorChange,
  );
}

export function followTail(
  state: TranscriptNavigationState,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = true;
  state.anchorPending = false;
  state.anchorLocked = false;
  state.anchorSuppressed = true;
  state.scrollIntent = undefined;
  setAnchor(state, undefined, onAnchorChange);
}

export function stopFollowing(
  state: TranscriptNavigationState,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = false;
  state.anchorPending = false;
  state.anchorLocked = false;
  state.anchorSuppressed = true;
  state.scrollIntent = undefined;
  setAnchor(state, undefined, onAnchorChange);
}
