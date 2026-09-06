import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TurnCheckpointLifecycle } from "./turn-checkpoint-lifecycle.js";
import { assistantAnchorForBranch } from "tau/host-extension";

export { assistantAnchorForBranch };

export interface PiTurnCheckpointExtensionOptions<Snapshot> {
  lifecycle: TurnCheckpointLifecycle<Snapshot>;
  nextTurnId(): string;
  /** Resolves the persisted session-entry id for the assistant at turn_end. */
  findAssistantAnchor(ctx: ExtensionContext, message: unknown): string | undefined;
  /** Binds a turn created by a Pi-native prompt to the context that received it. */
  bindTurnContext?(turnId: string, ctx: ExtensionContext): void;
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
      // A queued follow-up is deliberately left in the state machine until its
      // own input/turn boundary; session shutdown calls the final mode.
      void options.lifecycle.settle({ final: false }).catch(() => undefined);
    });
  };
}
