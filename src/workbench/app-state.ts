import type { HostSnapshot, NewThreadRequestId, ThreadIndexSnapshot, UiContextUsage, UiMessage, UiSession, UiSkillDraft, UiToolRun } from "../shared/contracts";
import { hostSnapshotFromThreadDetail, type HostActionResult, type ThreadDetail } from "../shared/host-protocol";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import type { ComposerScopeReference, DraftKey, PendingAttachment } from "./composer-scope-store";
import type { NewThreadDraft } from "./draft-store";
import { transcriptNavigationScopesEqual, type TranscriptNavigationScope, type TranscriptTurnStart } from "./transcript-navigation";

export function transcriptNavigationScopeKey(
  snapshot: Pick<HostSnapshot, "cwd" | "sessionId"> | undefined,
  pending?: NewThreadDraft,
): string {
  const project = pending?.projectPath ?? snapshot?.cwd ?? "";
  const thread = pending ? `draft:${pending.draftId}` : snapshot?.sessionId ?? "";
  return `project:${project}\u0000thread:${thread}`;
}

export function transcriptNavigationScope(
  snapshot: Pick<HostSnapshot, "cwd" | "sessionId"> | undefined,
  pending?: NewThreadDraft,
): TranscriptNavigationScope {
  return pending
    ? { kind: "draft", projectPath: pending.projectPath, draftId: pending.draftId }
    : { kind: "session", projectPath: snapshot?.cwd, sessionId: snapshot?.sessionId ?? "" };
}

export interface TranscriptSubmissionIdentity {
  turnId: string;
  scopeKey: string;
  scope: TranscriptNavigationScope;
  draftId?: string;
}

export function isCurrentTranscriptSubmission(
  current: TranscriptTurnStart | undefined,
  currentScopeKey: string,
  currentDraftId: string | undefined,
  captured: TranscriptSubmissionIdentity,
): boolean {
  return current?.turnId === captured.turnId
    && currentScopeKey === captured.scopeKey
    && transcriptNavigationScopesEqual(current.scope, captured.scope)
    && currentDraftId === captured.draftId;
}

export function optimisticThreadSnapshot(snapshot: HostSnapshot, target: UiSession, detail: ThreadDetail): HostSnapshot {
  return hostSnapshotFromThreadDetail({
    ...snapshot,
    sessionName: undefined,
    sessionTitle: target.title,
    projectLabel: target.projectLabel,
    supportsImageInput: false,
    ...(detail.backendKind ? { backendKind: detail.backendKind } : {}),
    ...(detail.threadId ? { threadId: detail.threadId } : {}),
    ...(detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : {}),
  }, { ...detail, isStreaming: false });
}

export const mockSnapshot: HostSnapshot = {
  cwd: "/workspace/tau",
  projectLabel: "main",
  sessionId: "prototype-preview",
  sessionName: "Split host snapshots & virtualize the thread list",
  sessionTitle: "Split host snapshots & virtualize the thread list",
  model: { provider: "anthropic", id: "preview", name: "sonnet-4.6" },
  models: [{ provider: "anthropic", id: "preview", name: "sonnet-4.6" }],
  thinkingLevel: "high",
  thinkingLevels: ["off", "low", "medium", "high"],
  messages: [
    { id: "welcome-user", role: "user", text: "Split the full host snapshots, stop calling SessionManager.listAll() on every switch, and virtualize the thread list for large sessions.", timestamp: Date.now() - 120000 },
    { id: "welcome-pi", role: "assistant", text: "Core keeps thread and session semantics; extensions only subscribe to individual thread shells. Press ⌘K to inspect the contribution registry.", timestamp: Date.now() - 110000 },
  ],
  isStreaming: false,
  activeTools: ["read", "bash", "edit", "write"],
  allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, description: `${name} tool` })),
  extensionCount: 2,
  supportsImageInput: true,
  contextUsage: { tokens: 68000, contextWindow: 200000, percent: 34 },
};

export const mockThreadIndex: ThreadIndexSnapshot = {
  projects: [
    { path: "/workspace/tau", name: "tau", lastOpenedAt: Date.now() },
    { path: "/workspace/pi", name: "pi-coding-agent", lastOpenedAt: Date.now() - 7200000 },
    { path: "/workspace/lab", name: "agent-lab", lastOpenedAt: Date.now() - 86400000 },
  ],
  sessions: [
    { id: "prototype-preview", path: "preview", title: "Split host snapshots & virtualize the thread list", modifiedAt: Date.now(), projectPath: "/workspace/tau", projectName: "tau", projectLabel: "main", messageCount: 12 },
    { id: "second", path: "second", title: "Renderer experiment", modifiedAt: Date.now() - 860000, projectPath: "/workspace/pi", projectName: "pi-coding-agent", projectLabel: "feat/desktop-host", messageCount: 7 },
    { id: "third", path: "third", title: "Package both extension domains", modifiedAt: Date.now() - 7200000, projectPath: "/workspace/lab", projectName: "agent-lab", projectLabel: "main", messageCount: 18 },
  ],
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function latestActivityAnchor(messages: readonly UiMessage[], currentAnchorId?: string): string | undefined {
  if (!currentAnchorId) return messages.at(-1)?.id;
  const currentIndex = messages.findIndex((message) => message.id === currentAnchorId);
  if (currentIndex < 0) return messages.at(-1)?.id;
  for (let index = messages.length - 1; index > currentIndex; index -= 1) {
    if (messages[index]?.role === "user") return messages[index].id;
  }
  return currentAnchorId;
}

export interface OptimisticUserMessage {
  scope: string;
  message: UiMessage;
}

export function skillPresentationForDraft(draft: UiSkillDraft): UiMessage["skill"] {
  return {
    name: draft.name,
    command: draft.command,
    copyText: draft.visibleText ? `${draft.command} ${draft.visibleText}` : draft.command,
  };
}

let fallbackClientMessageCounter = 0;

export function createClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);
  fallbackClientMessageCounter += 1;
  return `client-${Date.now()}-${fallbackClientMessageCounter}`;
}

export function reconcileOptimisticMessages(
  pending: readonly OptimisticUserMessage[],
  authoritative: readonly UiMessage[],
): OptimisticUserMessage[] {
  const confirmed = authoritative.filter((message) => message.role === "user");
  const used = new Set<number>();
  return pending.filter((entry) => {
    const index = confirmed.findIndex((message, at) => !used.has(at) && matchesTranscriptTurnMessage(message, {
      turnId: entry.message.clientTurnId ?? "",
      clientMessageId: entry.message.clientMessageId,
      messageId: entry.message.id,
      text: entry.message.text,
      timestamp: entry.message.timestamp,
    }));
    if (index < 0) return true;
    used.add(index);
    return false;
  });
}

export function isSameUserMessage(left: UiMessage, right: UiMessage): boolean {
  if (left.role !== "user" || right.role !== "user") return false;
  // The client identity outranks persistence ids: the same turn keeps it
  // across the optimistic row, the live event and the persisted entry.
  if (left.clientMessageId && right.clientMessageId) {
    if (left.clientTurnId && right.clientTurnId && left.clientTurnId !== right.clientTurnId) return false;
    return left.clientMessageId === right.clientMessageId;
  }
  if (left.sourceEntryId && right.sourceEntryId) return left.sourceEntryId === right.sourceEntryId;
  if (left.id === right.id) return true;
  return left.timestamp === right.timestamp
    && left.text === right.text
    && JSON.stringify(left.images ?? []) === JSON.stringify(right.images ?? []);
}

export function mergeTranscriptMessages(authoritative: readonly UiMessage[], optimistic: readonly UiMessage[]): UiMessage[] {
  if (optimistic.length === 0) return authoritative as UiMessage[];
  const merged = [...authoritative];
  for (const message of optimistic) {
    let low = 0;
    let high = merged.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (merged[middle].timestamp <= message.timestamp) low = middle + 1;
      else high = middle;
    }
    merged.splice(low, 0, message);
  }
  return merged;
}

export function backgroundNewThreadDetail(
  cached: ThreadDetail | undefined,
  sessionId: string,
  message: UiMessage,
): ThreadDetail {
  const messages = cached?.messages ?? [];
  return {
    ...cached,
    sessionId,
    messages: messages.some((entry) => isSameUserMessage(entry, message))
      ? messages
      : mergeTranscriptMessages(messages, [message]),
    isStreaming: true,
    activeTools: cached?.activeTools ?? [],
  };
}

export interface NewThreadSubmissionCompletion {
  pending: NewThreadDraft;
  sessionId: string;
  optimisticId: string;
  prompt: string;
  scope: DraftKey | undefined;
  requestId: NewThreadRequestId;
  result?: HostActionResult;
  recovery?: NewThreadSubmissionRecovery;
}

export interface NewThreadSubmissionRecovery {
  pending: NewThreadDraft;
  requestId: NewThreadRequestId;
  scopeRef: ComposerScopeReference;
  draft: string;
  attachments: PendingAttachment[];
  optimistic: UiMessage;
  ipcPending: boolean;
  sessionId?: string;
  /** The user left this draft after its runtime was allocated; delivery continues in that thread. */
  detached?: boolean;
  promoted?: boolean;
  withoutUserTurn?: boolean;
  notified?: boolean;
  failed?: string;
}

export function mergeNewThreadRecoveryDraft(recovered: string, current: string): string {
  if (!recovered) return current;
  if (!current || current === recovered) return recovered;
  if (current.includes(recovered)) return current;
  const separator = recovered.endsWith("\n") || current.startsWith("\n") ? "" : "\n\n";
  return `${recovered}${separator}${current}`;
}

export function mergeNewThreadRecoveryAttachments(
  recovered: readonly PendingAttachment[],
  current: readonly PendingAttachment[],
): PendingAttachment[] {
  const seen = new Set<string>();
  return [...recovered, ...current].filter((attachment) => {
    const key = `${attachment.name}\u0000${attachment.mimeType}\u0000${attachment.data}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The rows the conversation shows: confirmed history plus this scope's unconfirmed prompts. */
export function conversationMessagesFor(
  messages: readonly UiMessage[],
  optimistic: readonly OptimisticUserMessage[],
  activeDraftKey: string | undefined,
  pendingNewThread: boolean,
): UiMessage[] {
  const scoped = optimistic.filter((entry) => entry.scope === activeDraftKey);
  const unconfirmed = reconcileOptimisticMessages(scoped, messages).map((entry) => entry.message);
  return pendingNewThread ? unconfirmed : mergeTranscriptMessages(messages, unconfirmed);
}

/** Splits the host's reported context usage over transcript and tool output. */
export function contextBreakdownFor(
  usage: UiContextUsage | undefined,
  messageTokens: number,
  tools: readonly UiToolRun[],
): { messages: number; toolOutput: number; system: number } {
  if (!usage) return { messages: 0, toolOutput: 0, system: 0 };
  const toolTokens = tools.reduce((total, tool) => total + estimateTokens(tool.output ?? ""), 0);
  const accounted = Math.min(usage.tokens, messageTokens + toolTokens);
  const scale = messageTokens + toolTokens > 0 ? accounted / (messageTokens + toolTokens) : 0;
  return {
    messages: Math.round(messageTokens * scale),
    toolOutput: Math.round(toolTokens * scale),
    system: Math.max(0, usage.tokens - accounted),
  };
}
