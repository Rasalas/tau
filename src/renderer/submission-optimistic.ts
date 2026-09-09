import type {
  ClientTurnIdentity,
  NewThreadRequestId,
  PreparedPrompt,
  UiMessage,
  UiPromptAttachment,
  UiSkillDraft,
} from "../shared/contracts";
import { createClientMessageId, skillPresentationForDraft } from "../workbench/app-state";
import type { ThreadViewStore } from "../workbench/thread-view-store";

export interface BuildOptimisticMessageInput {
  text: string;
  attachments?: readonly UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
  prepared?: PreparedPrompt;
  submittedAt?: number;
  sequence?: number;
  newThreadRequestId?: NewThreadRequestId;
}

export interface BuildOptimisticMessageResult {
  optimistic: UiMessage;
  clientTurn: ClientTurnIdentity;
  logicalTurnId: string;
  clientMessageId: string;
  optimisticText: string;
  visiblePrompt: string;
}

export function buildOptimisticMessage(input: BuildOptimisticMessageInput): BuildOptimisticMessageResult {
  const attachments = input.attachments ?? [];
  const text = input.text;
  const optimisticText = input.prepared?.visibleText
    ?? input.skillDraft?.visibleText
    ?? (text || `Attached ${attachments.map((attachment) => attachment.name).join(", ")}`);
  const visiblePrompt = input.prepared?.visibleText ?? input.skillDraft?.visibleText ?? text;
  const optimisticSkill = input.prepared
    ? input.prepared.skill
    : input.skillDraft ? skillPresentationForDraft(input.skillDraft) : undefined;
  const submittedAt = input.submittedAt ?? Date.now();
  const sequence = input.sequence ?? 0;
  const logicalTurnId = `turn-${submittedAt}-${sequence}`;
  const clientMessageId = createClientMessageId();

  const optimistic: UiMessage = {
    id: `local-${clientMessageId}`,
    clientTurnId: logicalTurnId,
    clientMessageId,
    role: "user",
    text: optimisticText,
    ...(optimisticSkill ? { skill: optimisticSkill } : {}),
    images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
    timestamp: submittedAt,
  };

  const clientTurn: ClientTurnIdentity = {
    clientTurnId: logicalTurnId,
    clientMessageId,
    ...(input.newThreadRequestId ? { newThreadRequestId: input.newThreadRequestId } : {}),
  };

  return {
    optimistic,
    clientTurn,
    logicalTurnId,
    clientMessageId,
    optimisticText,
    visiblePrompt,
  };
}

export function addOptimisticMessage(view: ThreadViewStore, scope: string, message: UiMessage): void {
  view.setOptimisticMessages((current) => [...current, { scope, message }]);
}

export function removeOptimisticMessage(view: ThreadViewStore, messageId: string): void {
  view.setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== messageId));
}

export function retargetOptimisticMessage(view: ThreadViewStore, messageId: string, nextScope: string): void {
  view.setOptimisticMessages((current) => current.map((entry) => (
    entry.message.id === messageId ? { ...entry, scope: nextScope } : entry
  )));
}

export function retargetOptimisticByClientMessageId(view: ThreadViewStore, clientMessageId: string, nextScope: string): void {
  view.setOptimisticMessages((current) => current.map((entry) => (
    entry.message.clientMessageId === clientMessageId ? { ...entry, scope: nextScope } : entry
  )));
}

export function removeOptimisticByClientMessageId(view: ThreadViewStore, clientMessageId: string): void {
  view.setOptimisticMessages((current) => current.filter((entry) => (
    entry.message.clientMessageId !== clientMessageId
  )));
}
