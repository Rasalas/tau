import { randomUUID } from "node:crypto";
import type { ClientTurnIdentity, HostEvent, PreparedPrompt, UiPromptAttachment } from "../shared/contracts.js";
import type { ClientMessageTracker } from "./client-message-tracker.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { HostTurnObserverSet } from "./host-extensions.js";
import { clientIdentityForRequest, type ClientTurnRequest } from "./pi-host-support.js";
import type { PromptPreparation } from "./prompt-preparation.js";
import type { ThreadBinding } from "./thread-binding.js";
import type { ThreadIndex } from "./thread-index.js";
import type { ThreadProjection } from "./thread-projection.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export type TurnDeliveryKind = "prompt" | "steer" | "followUp";

export interface TurnDeliveryPort {
  clientTurns: ClientTurnLedger;
  clientMessages: ClientMessageTracker;
  turnObservers: HostTurnObserverSet;
  projection: ThreadProjection;
  prompts: PromptPreparation;
  binding: ThreadBinding;
  index: ThreadIndex;
  /** Refuses a delivery while the workbench is reloading. */
  assertAvailable(): void;
  requireThread(sessionId: string | undefined): ThreadRuntime;
  emit(event: HostEvent): void;
  fail(error: unknown, sessionId?: string): void;
}

/**
 * Handing a runtime a message for a turn it is already running, and the whole
 * delivery path of a runtime that keeps no host-owned journal.
 *
 * The first prompt of a turn is not here: it reports a preflight result and
 * owns the marker bookkeeping around it, which is the host's own path.
 */
export class TurnDelivery {
  constructor(private readonly port: TurnDeliveryPort) {}

  /**
   * Steering and follow-up share one path: both hand the runtime a message for
   * a turn that is already in flight, so neither reports a preflight result.
   */
  async queued(
    delivery: "steer" | "followUp",
    text: string,
    attachments: UiPromptAttachment[],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    this.port.assertAvailable();
    const identity = clientIdentityForRequest(clientMessageIdOrIdentity);
    const clientMessageId = identity?.clientMessageId;
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.port.requireThread(sessionId);
      await this.port.binding.settle(thread);
      if (!thread.backend.capabilities.journal) {
        await this.toRuntime(thread, text, attachments, delivery, identity, prepared);
        return;
      }
      if (identity) this.port.clientTurns.enqueue(thread.threadId, identity);
      this.port.prompts.assertImageInput(thread, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.port.prompts.assertBound(thread, text, resolvedPrepared, this.port.projection.composerCommands(thread));
      if (!this.port.projection.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        this.port.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.port.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery, ...(identity ? { identity } : {}), prepared: resolvedPrepared, attachments });
      } catch (error) {
        if (markerActive) {
          this.port.clientMessages.failIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        if (identity) this.port.clientTurns.cancel(thread.threadId, identity);
        if (preparedTurnId) await this.port.turnObservers.cancelled(thread.threadId, preparedTurnId);
        throw error;
      }
    } catch (error) {
      if (identity && thread?.backend.capabilities.journal) this.port.clientTurns.cancel(thread.threadId, identity);
      if (delivery === "followUp") this.port.fail(error, sessionId);
      else this.port.fail(error);
      if (thread && preparedTurnId) await this.port.turnObservers.cancelled(thread.threadId, preparedTurnId);
      throw error;
    }
  }

  /**
   * Delivery for a runtime that keeps no host-owned journal: it owns the turn
   * itself, so there is no request marker and no host turn observer for it.
   */
  async toRuntime(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: TurnDeliveryKind,
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (thread.backend.turnReporting === "awaited") {
      await this.throughAdapter(thread, text, attachments, delivery, identity, prepared);
      return;
    }
    this.port.prompts.assertImageInput(thread, attachments);
    if (prepared) this.port.prompts.assertBound(thread, text, prepared, this.port.projection.composerCommands(thread));
    try {
      if (identity) this.port.clientTurns.enqueue(thread.threadId, identity);
      await thread.backend.prompt({
        text,
        delivery,
        attachments,
        ...(identity ? { identity } : {}),
        ...(prepared ? { prepared } : {}),
      });
    } catch (error) {
      if (identity) this.port.clientTurns.cancel(thread.threadId, identity);
      throw error;
    }
  }

  /**
   * A backend whose `prompt` resolves only when the turn is over reports no
   * events of its own, so this owns the running status and serialises requests
   * per thread. An abort bumps the thread's generation; anything still queued
   * behind it is refused rather than delivered into the next turn.
   */
  private async throughAdapter(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: TurnDeliveryKind,
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const clientMessageId = identity?.clientMessageId;
    thread.adapterPending ??= 0;
    thread.adapterAbortGeneration ??= 0;
    const generation = thread.adapterAbortGeneration;
    const wasPending = thread.adapterPending > 0;
    thread.adapterPending += 1;
    thread.adapterStreaming = true;
    if (!wasPending) this.port.emit({ type: "agent-status", sessionId: thread.threadId, running: true });
    const operation = thread.adapterQueue.then(() => {
      if (generation !== thread.adapterAbortGeneration) {
        if (clientMessageId) {
          this.port.emit({
            type: "user-message-failed",
            sessionId: thread.threadId,
            clientMessageId,
            message: "The selected runtime request was aborted.",
          });
        }
        const error = new Error("The selected runtime request was aborted.");
        error.name = "AbortError";
        throw error;
      }
      return this.throughAdapterNow(thread, text, attachments, delivery, identity, prepared);
    });
    const settled = operation.finally(() => {
      thread.adapterPending = Math.max(0, thread.adapterPending - 1);
      if (thread.adapterPending === 0) {
        thread.adapterStreaming = false;
        this.port.emit({ type: "agent-status", sessionId: thread.threadId, running: false });
      }
    });
    thread.adapterQueue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async throughAdapterNow(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: TurnDeliveryKind,
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const clientMessageId = identity?.clientMessageId;
    if (prepared) this.port.prompts.assertBound(thread, text, prepared, this.port.projection.composerCommands(thread));
    const abortController = new AbortController();
    thread.adapterAbortControllers ??= new Set<AbortController>();
    thread.adapterAbortControllers.add(abortController);
    try {
      if (attachments.length > 0) throw new Error("Image attachments are not supported by the selected runtime adapter.");
      await thread.backend.prompt({ text, delivery, ...(identity ? { identity } : {}), ...(prepared ? { prepared } : {}), signal: abortController.signal });
      thread.adapterMessages = await thread.backend.transcript();
      const state = thread.state;
      thread.adapterTitle = state.title;
      thread.adapterTitleSource = state.titleSource;
      await this.port.index.refreshShell(thread, true);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (clientMessageId) {
        this.port.emit({
          type: "user-message-failed",
          sessionId: thread.threadId,
          clientMessageId,
          message: aborted ? "The selected runtime request was aborted." : "The selected runtime rejected the message.",
        });
      }
      if (!aborted) this.port.fail(error);
      throw error;
    } finally {
      thread.adapterAbortControllers.delete(abortController);
    }
  }
}
