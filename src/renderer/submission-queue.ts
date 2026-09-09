import type { UiPromptAttachment, UiSkillDraft } from "../shared/contracts";

export interface QueuedSubmissionItem {
  text: string;
  attachments: UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
}

export interface ShouldQueueSubmissionInput {
  isPendingNewThread: boolean;
  hasSnapshot: boolean;
  visibleStreaming: boolean;
  delivery?: "followUp" | "steer";
}

/**
 * Determines whether a submitted message should be parked in the follow-up queue
 * rather than dispatched immediately (e.g. while the current thread is streaming a turn).
 */
export function shouldQueueSubmission(input: ShouldQueueSubmissionInput): boolean {
  return !input.isPendingNewThread && input.hasSnapshot && input.visibleStreaming && input.delivery !== "steer";
}

export function formatQueuedFollowUp(
  text: string,
  attachments: UiPromptAttachment[] = [],
  skillDraft?: UiSkillDraft,
): QueuedSubmissionItem {
  return {
    text,
    attachments,
    ...(skillDraft ? { skillDraft } : {}),
  };
}
