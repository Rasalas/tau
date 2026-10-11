import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { PreparedPrompt, ThreadBackendKind, UiComposerCommand, UiPromptAttachment, UiSkillDraft } from "../shared/contracts.js";
import { skillFields, validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import type { RuntimeGate } from "./runtime-gate.js";
import { promptFiles, promptImages } from "./prompt-attachments.js";
import type { AgentRuntimeAdapter, RuntimePermissionLevel } from "./runtime-adapters.js";
import { prepareSkillPrompt } from "./skill-invocation.js";
import { ThreadRuntime, threadBackendKind } from "./thread-runtime.js";

export interface PromptPreparationPort {
  /** The provider behind a non-Pi backend kind, for its own prompt gate. */
  requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider;
  permissionLevel(): RuntimePermissionLevel;
  /** Whether a runtime may start work in a folder (ADR 0033). */
  runtimeGate: RuntimeGate;
  /** The terminal owns an attached Pi session; the gate is for threads Tau starts work on. */
  ownedByPi(thread: ThreadRuntime): boolean;
}

/**
 * The runtime spelling of a prompt, and the proof that a caller may execute it.
 *
 * A prepared prompt is an opaque host result, but IPC callers can replay or
 * forge one. Every path that reaches a backend binds it to the exact visible
 * input and runtime owner first, so a forged runtime text cannot travel on a
 * message the user never typed.
 */
export class PromptPreparation {
  constructor(private readonly port: PromptPreparationPort) {}

  /** Throws when the thread's runtime is off in its project (or in `cwd`, for a fork there). */
  assertRuntimeOn(thread: ThreadRuntime, cwd = thread.cwd): Promise<void> {
    return this.port.ownedByPi(thread) ? Promise.resolve() : this.port.runtimeGate.assert(thread.backend.kind, cwd);
  }

  /** Throws when `kind` is off in the project `cwd` belongs to. */
  assertRuntimeKind(kind: ThreadBackendKind, cwd: string): Promise<void> {
    return this.port.runtimeGate.assert(kind, cwd);
  }

  /** The message a start on `kind` in `cwd` is refused with, or undefined when it may go on. */
  async runtimeRefusal(kind: ThreadBackendKind, cwd: string): Promise<string | undefined> {
    try {
      await this.port.runtimeGate.assert(kind, cwd);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  runtimeEnabled(kind: ThreadBackendKind, cwd: string): Promise<boolean> {
    return this.port.runtimeGate.enabled(kind, cwd);
  }

  /** Resolves a prompt for a runtime the host has no thread of yet. */
  prepare(
    text: string,
    skill: UiSkillDraft | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
    threadId: string | undefined,
    backendKind: ThreadBackendKind,
  ): PreparedPrompt {
    if (adapter.id !== "pi") this.port.requireBackend(adapter.id).assertPromptAllowed?.(this.port.permissionLevel());
    const prepared = prepareSkillPrompt(text, adapter, commands, skill);
    const result: PreparedPrompt = {
      ...(threadId ? { tauThreadId: threadId } : {}),
      ...(threadId && adapter.id === "pi" ? { providerSessionId: threadId } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      backendKind,
      runtimeCapabilities: adapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...skillFields(prepared),
      sourceFingerprint: clientMessageFingerprint(text, [...knownSkillNames(commands)]),
    };
    validatePreparedPrompt(text, result, {
      backendKind,
      threadId,
      providerSessionId: threadId && adapter.id === "pi" ? threadId : undefined,
      runtimeCapabilities: adapter.capabilities,
      commands,
    });
    return result;
  }

  /** Binds a prepared prompt to the thread that is about to execute it. */
  assertBound(thread: ThreadRuntime, text: string, prepared: PreparedPrompt, commands: readonly UiComposerCommand[]): void {
    validatePreparedPrompt(text, prepared, {
      backendKind: threadBackendKind(thread),
      threadId: thread.threadId,
      providerSessionId: thread.backend.providerSessionId,
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      commands,
    });
  }

  /**
   * A prepared prompt from the visible thread may be carried into a new-thread
   * request. It is re-prepared after the new backend exists; only this
   * owner-less preflight can be checked before that.
   */
  assertUnbound(text: string, prepared: PreparedPrompt, adapter: AgentRuntimeAdapter, commands: readonly UiComposerCommand[], backendKind: ThreadBackendKind): void {
    validatePreparedPrompt(text, prepared, {
      backendKind,
      runtimeCapabilities: adapter.capabilities,
      commands,
    });
  }

  /**
   * Images travel to a runtime only when it says its model takes them, files
   * only when its adapter declares `fileAttachments`.
   */
  assertAttachmentInput(thread: ThreadRuntime, attachments: readonly UiPromptAttachment[]): void {
    if (attachments.length === 0) return;
    if (attachments.some((attachment) => attachment.kind === "image")) {
      if (!thread.state.supportsImageInput) throw new Error("The active model does not support image input.");
      promptImages(attachments);
    }
    if (promptFiles(attachments).length > 0 && thread.runtimeAdapter.capabilities.fileAttachments !== true) {
      throw new Error("This thread's runtime does not take file attachments; embed them in the prompt instead.");
    }
  }

  /** `assertAttachmentInput` for attachments that are stored, not sent now. */
  checked(thread: ThreadRuntime, attachments: readonly UiPromptAttachment[]): UiPromptAttachment[] {
    this.assertAttachmentInput(thread, attachments);
    return [...attachments];
  }
}
