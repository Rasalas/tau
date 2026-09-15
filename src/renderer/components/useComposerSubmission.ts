import { useCallback } from "react";
import type {
  SubmissionResult,
  ThreadBackendKind,
  UiModel,
  UiPromptAttachment,
  UiSkillDraft,
} from "../../shared/contracts";
import { errorMessage } from "../../workbench/error-message";
import { writeComposerDraft } from "../../workbench/draft-store";
import type { ClientStorage } from "../../workbench/client-storage";
import type {
  ComposerScope,
  ComposerScopeStore,
  SubmissionHandle,
} from "../../workbench/composer-scope-store";
import { expandFileMentions } from "../file-mention-expander.js";
import type { DocumentSourceContribution } from "../extension-system";
import type { SelectedSkill } from "./ComposerAutocomplete";
import { selectedSkillDraft } from "./ComposerAutocomplete";

export type ComposerDelivery = "followUp" | "steer";

export interface ComposerSubmissionInput {
  text: string;
  answerable: boolean;
  promptActionAvailable: boolean;
  shellActionAvailable: boolean;
  delivery?: ComposerDelivery;
}

export type ComposerSubmissionIntent =
  | { kind: "prompt-action" }
  | { kind: "prompt-answer"; text: string }
  | { kind: "shell"; command: string; includeInContext: boolean; historyText: string }
  | { kind: "prompt"; delivery?: ComposerDelivery }
  | { kind: "noop" };

/** Resolves editor text into one of the composer actions before any side effect starts. */
export function classifyComposerInput({
  text,
  answerable,
  promptActionAvailable,
  shellActionAvailable,
  delivery,
}: ComposerSubmissionInput): ComposerSubmissionIntent {
  if (answerable) {
    if (!text.trim()) return promptActionAvailable ? { kind: "prompt-action" } : { kind: "noop" };
    return { kind: "prompt-answer", text };
  }

  const trimmedInput = text.trim();
  if (shellActionAvailable && trimmedInput.startsWith("!")) {
    const isExcluded = trimmedInput.startsWith("!!");
    const command = (isExcluded ? trimmedInput.slice(2) : trimmedInput.slice(1)).trim();
    if (command.length > 0) {
      return {
        kind: "shell",
        command,
        includeInContext: !isExcluded,
        historyText: trimmedInput,
      };
    }
  }

  return { kind: "prompt", delivery };
}

/** Pi subscription warnings apply only to the runtimes that present Pi's login. */
export function requiresSubscriptionAcknowledgement(
  model: UiModel | undefined,
  backendKind: ThreadBackendKind | undefined,
  hasAcknowledged: (provider: string) => boolean,
): boolean {
  if (model?.login !== "subscription") return false;
  if (backendKind !== "antigravity" && backendKind !== "claude-code") return false;
  return !hasAcknowledged(model.provider);
}

export interface UseComposerSubmissionOptions {
  scopeStore: ComposerScopeStore;
  scope: ComposerScope;
  /** Persistence is enabled only when the caller has a named draft scope. */
  draftStorageKey?: string;
  clientStorage: ClientStorage;
  documentSource?: DocumentSourceContribution;
  selectedSkill?: SelectedSkill;
  onSubmit(
    text?: string,
    attachments?: UiPromptAttachment[],
    delivery?: ComposerDelivery,
    skillDraft?: UiSkillDraft,
  ): Promise<SubmissionResult>;
  recordPrompt(text: string): void;
  clearPreviewForScope(scope: ComposerScope): void;
}

export interface UseComposerSubmissionResult {
  /** Captures the current scope and starts its asynchronous host submission. */
  submit(delivery?: ComposerDelivery): void;
}

/**
 * Owns the scope transaction around a prompt submission. The scope store keeps
 * editor recovery and concurrency rules; this hook only prepares the captured
 * payload, calls the host, and reports the result back to that store.
 */
export function useComposerSubmission({
  scopeStore,
  scope,
  draftStorageKey,
  clientStorage,
  documentSource,
  selectedSkill,
  onSubmit,
  recordPrompt,
  clearPreviewForScope,
}: UseComposerSubmissionOptions): UseComposerSubmissionResult {
  const submit = useCallback((delivery?: ComposerDelivery) => {
    const submission = scopeStore.beginSubmission(scope);
    if ("busy" in submission) return;

    const sendSubmission = async (handle: SubmissionHandle) => {
      if (!handle.text.trim() && handle.attachments.length === 0) {
        handle.cancel();
        return;
      }

      // The selected skill is typed metadata. Keep the editor's text intact;
      // the host/runtime adapter resolves provider syntax at the boundary.
      let prepared: {
        submittedText: string;
        skillDraft?: UiSkillDraft;
        promptToSend: string;
        attachmentsToSend: UiPromptAttachment[];
      };
      try {
        const submittedText = handle.text;
        const skillDraft = selectedSkillDraft(submittedText, selectedSkill);
        let promptToSend = submittedText;
        let attachmentsToSend = [...handle.attachments];

        if (!skillDraft && promptToSend.includes("@") && documentSource) {
          const expanded = await expandFileMentions(promptToSend, documentSource);
          promptToSend = expanded.text;
          if (expanded.attachments.length > 0) {
            attachmentsToSend = [...attachmentsToSend, ...expanded.attachments];
          }
        }

        // beginSubmission clears the live editor before the host round trip. Keep
        // the persisted copy in step so a reload cannot resurrect a sent prompt.
        if (draftStorageKey !== undefined) {
          writeComposerDraft(clientStorage, scope, scopeStore.getSnapshot(scope).draft);
        }
        prepared = { submittedText, skillDraft, promptToSend, attachmentsToSend };
      } catch (error) {
        // Preparation failures are submission failures. Settling here releases
        // the scope and restores the captured draft for a retry.
        handle.settle({ accepted: false, message: errorMessage(error) });
        return;
      }

      const { submittedText, skillDraft, promptToSend, attachmentsToSend } = prepared;
      let result: SubmissionResult;
      try {
        result = skillDraft
          ? await onSubmit(promptToSend, attachmentsToSend, delivery, skillDraft)
          : delivery
            ? await onSubmit(promptToSend, attachmentsToSend, delivery)
            : await onSubmit(promptToSend, attachmentsToSend);
      } catch (error) {
        result = { accepted: false, message: errorMessage(error) };
      }

      handle.settle(result);
      try {
        // Settling empties an accepted draft in the scope store. The persisted
        // copy is written per keystroke and has to follow it, or the next start
        // seeds the composer with a prompt that was already sent.
        if (draftStorageKey !== undefined) {
          writeComposerDraft(clientStorage, scope, scopeStore.getSnapshot(scope).draft);
        }
        if (result.accepted) {
          recordPrompt(submittedText);
          clearPreviewForScope(scope);
        }
      } catch {
        // These effects run after the handle is settled. Keep their failure
        // from looking like another failed submission in the scope store.
      }
    };

    if ("then" in submission) {
      void submission.then(sendSubmission).catch((error) => {
        // No handle exists when attachment processing rejects. Keep this
        // failure attached to the attachment operation itself.
        const message = errorMessage(error);
        scopeStore.setAttachmentError(
          scope,
          message,
          scopeStore.getAttachmentGeneration(scope),
        );
      });
    } else {
      // sendSubmission handles every expected preparation and host error. Any
      // post-settlement side effect is deliberately contained there as well.
      void sendSubmission(submission);
    }
  }, [
    clearPreviewForScope,
    clientStorage,
    documentSource,
    draftStorageKey,
    onSubmit,
    recordPrompt,
    scope,
    scopeStore,
    selectedSkill,
  ]);

  return { submit };
}
