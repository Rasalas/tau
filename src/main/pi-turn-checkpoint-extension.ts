import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TurnCheckpointLifecycle } from "../shared/turn-checkpoint-lifecycle.js";

export interface PiTurnCheckpointExtensionOptions<Snapshot> {
  lifecycle: TurnCheckpointLifecycle<Snapshot>;
  nextTurnId(): string;
  /** Resolves the persisted session-entry id for the assistant at turn_end. */
  findAssistantAnchor(ctx: ExtensionContext, message: unknown): string | undefined;
  /** Binds a turn created by a Pi-native prompt to the context that received it. */
  bindTurnContext?(turnId: string, ctx: ExtensionContext): void;
}

/**
 * Resolves an assistant's durable session-entry id without depending on the
 * runtime that owns the branch. The host uses this after `message_end` has
 * persisted the entry, while the bridge passes its ExtensionContext through
 * the convenience wrapper below.
 */
export function assistantAnchorForBranch(entries: readonly unknown[], message: unknown): string | undefined {
  const branch = [...entries].reverse();
  const exact = branch.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as { type?: unknown; id?: unknown; message?: unknown };
    return item.type === "message"
      && typeof item.id === "string"
      && item.message !== null
      && typeof item.message === "object"
      && (item.message as { role?: unknown }).role === "assistant"
      && item.message === message;
  });
  if (exact && typeof (exact as { id?: unknown }).id === "string") return (exact as { id: string }).id;
  if (!message || typeof message !== "object") return undefined;
  const value = message as { timestamp?: unknown; stopReason?: unknown };
  const fallback = branch.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (item.type !== "message" || typeof item.id !== "string" || !item.message || typeof item.message !== "object") return false;
    const candidate = item.message as { role?: unknown; timestamp?: unknown; stopReason?: unknown };
    return candidate.role === "assistant"
      && (typeof value.timestamp !== "number" || candidate.timestamp === value.timestamp)
      && (typeof value.stopReason !== "string" || candidate.stopReason === value.stopReason);
  });
  return fallback && typeof (fallback as { id?: unknown }).id === "string"
    ? (fallback as { id: string }).id
    : undefined;
}

/**
 * Pi normally stores the exact message object delivered with `turn_end` in
 * the session branch. Prefer that identity over timestamps: providers can
 * legitimately emit two assistant messages with the same millisecond
 * timestamp. The timestamp/stop-reason fallback keeps resumed or adapted
 * runtimes usable when an adapter cloned the event payload.
 */
export function assistantAnchorForMessage(ctx: ExtensionContext, message: unknown): string | undefined {
  return assistantAnchorForBranch(ctx.sessionManager.getBranch(), message);
}

/**
 * Thin Pi adapter for the shared user-turn state machine. The lifecycle itself
 * owns all transitions; these handlers only translate Pi's awaited events and
 * supply the durable assistant anchor.
 */
export function createPiTurnCheckpointExtension<Snapshot>(
  options: PiTurnCheckpointExtensionOptions<Snapshot>,
): ExtensionFactory {
  return (pi) => {
    pi.on("input", async (event, ctx) => {
      const id = options.lifecycle.nextInputTurnId() ?? options.nextTurnId();
      options.bindTurnContext?.(id, ctx);
      // Pi emits `input` when a streaming prompt is queued, not when that
      // follow-up is delivered. Defer its boundary until the later turn_start.
      await options.lifecycle.acceptInput(id, { deferBefore: Boolean(event.streamingBehavior) });
    });
    pi.on("turn_start", async () => {
      await options.lifecycle.beginTurn();
    });
    pi.on("message_start", async (event) => {
      if (event.message.role === "user") await options.lifecycle.userMessage();
    });
    pi.on("turn_end", async (event, ctx) => {
      await options.lifecycle.endTurn(
        event.message,
        undefined,
        // Pi's turn_end extension callback runs before the SDK's listener
        // persists the assistant entry. Resolve only once the lifecycle is
        // settling, so a same-timestamp prior assistant cannot steal the card.
        () => options.findAssistantAnchor(ctx, event.message),
      );
    });
    // agent_end can be followed by a retry. The shared lifecycle therefore
    // waits for the next turn_start or the definitive settled event instead of
    // treating this low-level boundary as a completed user turn.
    pi.on("agent_settled", () => {
      // Persistence remains awaited by the lifecycle itself, but Pi's global
      // settled signal must not hold another workspace/thread behind Git I/O.
      void options.lifecycle.settle().catch(() => undefined);
    });
  };
}
