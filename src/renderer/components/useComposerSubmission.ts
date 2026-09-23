import { useCallback } from "react";
import type {
  SubmissionResult,
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
import type { ComposerInlineContext, ComposerInlineContribution, DocumentSourceContribution } from "../extension-system";
import type { SelectedSkill } from "./ComposerAutocomplete";
import { selectedSkillDraft } from "./ComposerAutocomplete";

/** `alternate` is a plain send with the modifier held, which an extension may claim for a new thread. */
export type ComposerDelivery = "followUp" | "steer" | "alternate";

const NO_INLINES: readonly ComposerInlineContribution[] = [];

export interface ComposerSubmissionInput {
  text: string;
  answerable: boolean;
  /** Files wait in the composer and the open question takes them with its answer. */
  answerFiles?: boolean;
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
  answerFiles = false,
  promptActionAvailable,
  shellActionAvailable,
  delivery,
}: ComposerSubmissionInput): ComposerSubmissionIntent {
  if (answerable) {
    if (!text.trim()) return promptActionAvailable ? { kind: "prompt-action" } : answerFiles ? { kind: "prompt-answer", text } : { kind: "noop" };
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

interface InlineSend {
  context: string;
  attachments: UiPromptAttachment[];
  /** Every contribution that was asked, and so has to hear how the prompt fared. */
  asked: ComposerInlineContribution[];
}

/** Asks each inline contribution what it adds; one that throws rejects the whole send. */
export async function collectInlineSend(
  inlines: readonly ComposerInlineContribution[],
  context: ComposerInlineContext & { text: string },
): Promise<InlineSend> {
  const send: InlineSend = { context: "", attachments: [], asked: [] };
  const parts: string[] = [];
  try {
    for (const inline of inlines) {
      if (!inline.prepareSend) continue;
      send.asked.push(inline);
      const result = await inline.prepareSend(context);
      if (result?.context?.trim()) parts.push(result.context.trim());
      if (result?.attachments?.length) send.attachments.push(...result.attachments);
    }
  } catch (error) {
    settleInlineSend(send.asked, context.scope, false);
    throw error;
  }
  send.context = parts.join("\n\n");
  return send;
}

export function settleInlineSend(asked: readonly ComposerInlineContribution[], scope: string, accepted: boolean): void {
  for (const inline of asked) {
    try { inline.settleSend?.(scope, accepted); } catch (error) { console.error(`Composer inline ${inline.id} failed to settle`, error); }
  }
}

/** Context goes before the user's text; a skill reads its instruction first, so there it follows. */
export function withInlineContext(text: string, context: string, skillDraft?: UiSkillDraft): { text: string; skillDraft?: UiSkillDraft } {
  if (!context) return { text, skillDraft };
  if (!skillDraft) return { text: text.trim() ? `${context}\n\n${text}` : context };
  const append = (value: string) => value ? `${value}\n\n${context}` : context;
  return { text: append(text), skillDraft: { ...skillDraft, visibleText: append(skillDraft.visibleText) } };
}

export interface UseComposerSubmissionOptions {
  scopeStore: ComposerScopeStore;
  scope: ComposerScope;
  /** Persistence is enabled only when the caller has a named draft scope. */
  draftStorageKey?: string;
  clientStorage: ClientStorage;
  documentSource?: DocumentSourceContribution;
  selectedSkill?: SelectedSkill;
  /** Typed context the composer's extensions hold for this draft. */
  inlines?: readonly ComposerInlineContribution[];
  inlineContext?: Omit<ComposerInlineContext, "scope">;
  onSubmit(
    text?: string,
    attachments?: UiPromptAttachment[],
    delivery?: ComposerDelivery,
    skillDraft?: UiSkillDraft,
  ): Promise<SubmissionResult>;
  recordPrompt(text: string): void;
  clearPreviewForScope(scope: ComposerScope): void;
}

/** Takes the prepared text and files as the answer to the open question instead of a prompt. */
export type ComposerAnswerSink = (text: string, attachments: UiPromptAttachment[]) => void;

export interface UseComposerSubmissionResult {
  /** Captures the current scope and starts its asynchronous host submission, or answers with it. */
  submit(delivery?: ComposerDelivery, answer?: ComposerAnswerSink): void;
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
  inlines = NO_INLINES,
  inlineContext,
  onSubmit,
  recordPrompt,
  clearPreviewForScope,
}: UseComposerSubmissionOptions): UseComposerSubmissionResult {
  const submit = useCallback((delivery?: ComposerDelivery, answer?: ComposerAnswerSink) => {
    const submission = scopeStore.beginSubmission(scope);
    if ("busy" in submission) return;

    const sendSubmission = async (handle: SubmissionHandle) => {
      // A `/command` is not a prompt the context belongs to; it stays for the next one.
      const isCommand = !answer && !selectedSkillDraft(handle.text, selectedSkill) && handle.text.trimStart().startsWith("/");
      let inline: InlineSend = { context: "", attachments: [], asked: [] };
      if (!isCommand && inlines.length > 0) {
        try {
          inline = await collectInlineSend(inlines, {
            scope,
            fileAttachments: inlineContext?.fileAttachments ?? false,
            imageInput: inlineContext?.imageInput ?? false,
            ...(inlineContext?.snapshot ? { snapshot: inlineContext.snapshot } : {}),
            text: handle.text,
          });
        } catch (error) {
          handle.settle({ accepted: false, message: errorMessage(error) });
          return;
        }
      }
      if (!handle.text.trim() && handle.attachments.length === 0 && !inline.context && inline.attachments.length === 0) {
        settleInlineSend(inline.asked, scope, false);
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
        let skillDraft = selectedSkillDraft(submittedText, selectedSkill);
        let promptToSend = submittedText;
        let attachmentsToSend = [...handle.attachments];

        if (!skillDraft && promptToSend.includes("@") && documentSource) {
          const expanded = await expandFileMentions(promptToSend, documentSource);
          promptToSend = expanded.text;
          if (expanded.attachments.length > 0) {
            attachmentsToSend = [...attachmentsToSend, ...expanded.attachments];
          }
        }
        // After the mentions, so text a chip carries is never read as one.
        const withContext = withInlineContext(promptToSend, inline.context, skillDraft);
        promptToSend = withContext.text;
        skillDraft = withContext.skillDraft;
        attachmentsToSend = [...attachmentsToSend, ...inline.attachments];

        // beginSubmission clears the live editor before the host round trip. Keep
        // the persisted copy in step so a reload cannot resurrect a sent prompt.
        if (draftStorageKey !== undefined) {
          writeComposerDraft(clientStorage, scope, scopeStore.getSnapshot(scope).draft);
        }
        prepared = { submittedText, skillDraft, promptToSend, attachmentsToSend };
      } catch (error) {
        // Preparation failures are submission failures. Settling here releases
        // the scope and restores the captured draft for a retry.
        settleInlineSend(inline.asked, scope, false);
        handle.settle({ accepted: false, message: errorMessage(error) });
        return;
      }

      const { submittedText, skillDraft, promptToSend, attachmentsToSend } = prepared;
      let result: SubmissionResult;
      try {
        if (answer) {
          answer(promptToSend, attachmentsToSend);
          result = { accepted: true };
        } else result = skillDraft
          ? await onSubmit(promptToSend, attachmentsToSend, delivery, skillDraft)
          : delivery
            ? await onSubmit(promptToSend, attachmentsToSend, delivery)
            : await onSubmit(promptToSend, attachmentsToSend);
      } catch (error) {
        result = { accepted: false, message: errorMessage(error) };
      }

      handle.settle(result);
      settleInlineSend(inline.asked, scope, result?.accepted === true);
      try {
        // Settling empties an accepted draft in the scope store. The persisted
        // copy is written per keystroke and has to follow it, or the next start
        // seeds the composer with a prompt that was already sent.
        if (draftStorageKey !== undefined) {
          writeComposerDraft(clientStorage, scope, scopeStore.getSnapshot(scope).draft);
        }
        if (result.accepted) {
          if (!answer) recordPrompt(submittedText);
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
    inlineContext,
    inlines,
    onSubmit,
    recordPrompt,
    scope,
    scopeStore,
    selectedSkill,
  ]);

  return { submit };
}
