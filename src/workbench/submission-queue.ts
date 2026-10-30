import type { UiPromptAttachment, UiSkillDraft } from "../shared/contracts";

export interface QueuedSubmissionItem {
  text: string;
  attachments: UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
  /** Planned: the host sends it at this time (epoch ms). */
  deliverAt?: number;
}

/** Where a message goes: steered, queued, a plain prompt with the modifier held, or planned for a time. */
export type SubmitDelivery = "followUp" | "steer" | "alternate" | { deliverAt: number };

export interface ShouldQueueSubmissionInput {
  isPendingNewThread: boolean;
  hasSnapshot: boolean;
  visibleStreaming: boolean;
  /** The thread waits for a limit's scheduled resume: a message sent now leaves with it. */
  awaitingResume?: boolean;
  delivery?: "followUp" | "steer";
}

/**
 * Determines whether a submitted message should be parked in the follow-up queue
 * rather than dispatched immediately (e.g. while the current thread is streaming a turn).
 */
export function shouldQueueSubmission(input: ShouldQueueSubmissionInput): boolean {
  return !input.isPendingNewThread && input.hasSnapshot && (input.visibleStreaming || input.awaitingResume === true) && input.delivery !== "steer";
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
