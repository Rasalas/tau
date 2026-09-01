import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  loadSkills,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AccessLevel,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  UiQuestionnaireQuestion,
  ServiceTier,
  CommitResult,
  DiffLoadOptions,
  FileNode,
  HostBootstrap,
  HostEvent,
  ThreadHostEvent,
  HostSnapshot,
  PreparedThreadCapability,
  PushResult,
  ShellActionResult,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiEditor,
  UiFileDiff,
  UiMessage,
  UiMessageImage,
  UiModel,
  UiPromptAttachment,
  SubmissionResult,
  UiSkillDraft,
  UiSession,
  UiTaskProgressEntry,
  UiToolRun,
  UiTurnCheckpoint,
  UiTurnActivity,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceInfo,
  NewThreadRequestId,
  ThreadBackendKind,
  PreparedPrompt,
} from "../shared/contracts.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  checkpointsForMessages,
  detailFromSnapshot,
  messageHasCheckpointAnchor,
  normalizeTranscriptCursorBoundaries,
  taskHistoryForMessages,
  type HostActionResult,
  type HostUpdate,
  type NewThreadResult,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import { mergeTaskProgressHistory, taskProgressFromMessages, taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { OLDER_TRANSCRIPT_TURN_LIMIT, TranscriptPager, type TranscriptCursorPolicy } from "../shared/transcript-pager.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";
import { cachedResourceOptions, captureResourceDiscovery, type ResourceDiscoverySnapshot } from "./resource-discovery-cache.js";
import { createAccessExtension, type AccessDecision } from "./access-extension.js";
import { computerUseExtensionFactories } from "./computer-use-extension.js";
import { createServiceTierExtension, SERVICE_TIER_APIS } from "./service-tier-extension.js";
import { createExtensionUiContext } from "./extension-ui.js";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { freeTextOption } from "../shared/extension-prompt-options.js";
import { createQuestionnaireExtension } from "./questionnaire-extension.js";
import { GitCoordinator } from "./git-coordinator.js";
import { ProjectHistory } from "./project-history.js";
import * as workspaceGit from "./workspace-git.js";
import { ToolOutputBatcher } from "./tool-output-batcher.js";
import { promptImages } from "./prompt-attachments.js";
import { findPiBridge, PiBridgeClient, PiBridgeReconnectLoop } from "./pi-bridge-client.js";
import {
  transcriptPagingNegotiated,
  type PiBridgePreparedPrompt,
  type PiBridgeServerFrame,
  type PiBridgeSnapshot,
  type PiBridgeTranscriptPage,
  type PiBridgeTurnFilesPage,
} from "../shared/pi-bridge-protocol.js";
import { inferUnavailableTranscriptCompleteness, isTranscriptHistoryMetadataConsistent, parseTranscriptHistoryCompleteness, resolveTranscriptHistoryCompleteness, type TranscriptHistoryCompleteness } from "../shared/transcript-completeness.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import {
  bridgeCursorValue,
  decodeHostCursor,
  hostCursorAtBridgeValue,
  hostCursorAtLocalIndex,
  providerCursorValue,
} from "./transcript-cursor.js";

const localTranscriptCursorPolicy: TranscriptCursorPolicy<HostTranscriptCursor> = {
  cursorAtIndex: hostCursorAtLocalIndex,
  indexFromCursor: (cursor, maximum) => {
    const coordinate = decodeHostCursor(cursor);
    if (coordinate.kind !== "local" || coordinate.index > maximum) throw new Error("Invalid transcript cursor");
    return coordinate.index;
  },
};
import {
  branchMessagesWithClientMessageIds,
  clientMessageFingerprint,
  clientMessageCancelMarker,
  clientMessageIdForMessage,
  clientMessageMarker,
  matchClientMessageId,
  CLIENT_MESSAGE_CANCEL_MARKER,
  CLIENT_MESSAGE_MARKER,
  unclaimedClientMessageIds,
} from "../shared/client-message-correlation.js";
import {
  prepareSkillPrompt,
  skillInvocationCommand,
  skillMessagePresentation,
} from "./skill-invocation.js";
import { knownSkillNames, parseSkillEnvelope } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { assertClaudePermissionPolicySupported, assertRuntimeAdapter, createClaudeCodeRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, runtimePermissionPolicy, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { ClaudeRuntimeSessionStore, type ClaudeTitleSource } from "./claude-runtime-store.js";
import { ClaudeThreadRuntimeBackend, PiThreadRuntimeBackend, type ThreadRuntimeBackend } from "./thread-runtime-backend.js";
import { WorkspaceCheckpointLeaseManager } from "./workspace-checkpoint-lease.js";
import { assistantAnchorForBranch, assistantAnchorForMessage } from "./pi-turn-checkpoint-extension.js";
import {
  cloneTurnCheckpoint,
  checkpointsForBranch,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  TURN_RESTORE_BACKUP_CUSTOM_TYPE,
  TURN_RESTORE_TRANSACTION_CUSTOM_TYPE,
  turnRestoreBackupsFromEntries,
  turnRestoreTransactionsFromEntries,
  turnCheckpointsFromEntries,
  turnSnapshotRef,
} from "../shared/turn-checkpoint-codec.js";
import type { TurnRestoreTransaction } from "../shared/turn-checkpoint-types.js";
import {
  createWorkspaceKitCheckpointFeature,
  createWorkspaceKitCheckpointMaintenance,
  type WorkspaceKitCheckpointFeature,
  type WorkspaceKitCheckpointRuntime,
  type WorkspaceKitCheckpointMaintenance,
  type WorkspaceKitLiveCheckpointSession,
} from "./workspace-kit-checkpoints.js";
/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;
/** Virtual shell paths keep app-data-owned Claude sessions addressable without
 * pretending their transcript is a Pi JSONL file. */
const CLAUDE_SESSION_PATH_PREFIX = "tau-claude-session:";
/** Longest a shutdown waits for a run to stop before the runtime is dropped anyway. */
const SHUTDOWN_ABORT_MS = 3_000;
/** How long a typed answer waits for the extension's follow-up input prompt. */
const TYPED_ANSWER_TTL_MS = 10_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);

function claudeThreadPath(threadId: string): string {
  return `${CLAUDE_SESSION_PATH_PREFIX}${threadId}`;
}

function claudeThreadIdFromPath(path: string): string | undefined {
  return path.startsWith(CLAUDE_SESSION_PATH_PREFIX)
    ? path.slice(CLAUDE_SESSION_PATH_PREFIX.length) || undefined
    : undefined;
}

type Emit = (event: HostEvent) => void;
type RuntimeStartEvent = Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"];
interface PromptPreflightResult {
  accepted: boolean;
  error?: unknown;
}
type PromptPreflight = (result: PromptPreflightResult) => void;
type PromptPreflightState = "pending" | "accepted" | "rejected";

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; text?: string; thinking?: string };
      if (item.type === "text") return item.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extensionCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const name = text.slice(1).trim().split(/\s+/u, 1)[0];
  return name || undefined;
}

function isExtensionCommand(session: AgentSession, text: string): boolean {
  const name = extensionCommandName(text);
  if (!name) return false;
  return session.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has(name));
}

const MESSAGE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function imagesFromContent(content: unknown): UiMessageImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const image = part as { type?: string; mimeType?: string; data?: string };
    if (
      image.type !== "image"
      || !image.mimeType
      || !MESSAGE_IMAGE_MIME_TYPES.has(image.mimeType)
      || typeof image.data !== "string"
      || image.data.length === 0
    ) return [];
    return [{ mimeType: image.mimeType, data: image.data }];
  }).slice(0, 4);
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const value = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; thinking?: string };
      return item.type === "thinking" ? item.thinking ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
  return value || undefined;
}

export interface MessageMappingOptions {
  runtimeAdapter?: AgentRuntimeAdapter;
  skillCommands?: readonly UiComposerCommand[];
  checkpoints?: readonly UiTurnCheckpoint[];
}

export interface PiHostOptions {
  /** Legacy default adapter. Existing Pi sessions are still always opened by Pi. */
  runtimeAdapter?: AgentRuntimeAdapter;
  /** Explicit adapters available to per-thread backend selection. */
  runtimeAdapters?: Partial<Record<ThreadBackendKind, AgentRuntimeAdapter>>;
  /** Backend for a newly created thread when no existing session metadata applies. */
  defaultBackendKind?: ThreadBackendKind;
  /** Commands available to the non-Pi backend; Pi discovers its own resources. */
  runtimeCommands?: readonly UiComposerCommand[];
}

export function mapMessage(message: unknown, index: number, options: MessageMappingOptions = {}): UiMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as {
    role?: string;
    content?: unknown;
    timestamp?: number;
    customType?: string;
    tauEntryId?: string;
    clientMessageId?: string;
  };

  if (value.role === "user") {
    const text = textFromContent(value.content);
    const images = imagesFromContent(value.content);
    const presentation = options.runtimeAdapter && options.skillCommands
      ? skillMessagePresentation(text, options.runtimeAdapter, options.skillCommands)
      : undefined;
    const visibleText = presentation?.text ?? text;
    const clientMessageId = typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
      ? value.clientMessageId
      : undefined;
    return {
      // Live events do not carry a persisted entry id yet. The request id is
      // already stable at message_start, so use it to keep equal-timestamp
      // user turns distinct until the next authoritative snapshot.
      id: value.tauEntryId ?? (clientMessageId ? `user-${clientMessageId}` : `user-${value.timestamp ?? index}-${index}`),
      sourceEntryId: value.tauEntryId,
      ...(clientMessageId ? { clientMessageId } : {}),
      role: "user",
      text: visibleText || (images.length ? `[${images.length} image${images.length === 1 ? "" : "s"} attached]` : ""),
      ...(presentation ? { skill: presentation.skill } : {}),
      images,
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "assistant") {
    return {
      id: value.tauEntryId ?? `assistant-${value.timestamp ?? index}-${index}`,
      sourceEntryId: value.tauEntryId,
      role: "assistant",
      text: textFromContent(value.content),
      thinking: thinkingFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "custom" && value.customType) {
    return {
      id: value.tauEntryId ?? `notice-${value.timestamp ?? index}-${index}`,
      sourceEntryId: value.tauEntryId,
      role: "notice",
      text: textFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  return undefined;
}

function bridgeMessagesOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Pi returned an invalid transcript message offset.");
  }
  return value as number;
}

function bridgeTranscriptCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return providerCursorValue(value);
  } catch {
    throw new Error("Pi returned an invalid transcript page cursor.");
  }
}

/** Normalize the pre-v6 Pi-only state before it reaches the shared contract. */
function normalizeBridgeHistoryCompleteness(value: unknown): unknown {
  return value === "legacy-truncated" ? "unknown" : value;
}

export function historyCompletenessForBridgeSnapshot(
  snapshot: Pick<PiBridgeSnapshot, "capabilities" | "historyCompleteness" | "olderCursor">,
): TranscriptHistoryCompleteness {
  return inferUnavailableTranscriptCompleteness(
    transcriptPagingNegotiated(snapshot.capabilities),
    normalizeBridgeHistoryCompleteness(snapshot.historyCompleteness),
    snapshot.olderCursor !== undefined,
  );
}

/** Validate and map one bridge-owned raw page without exposing provider coordinates. */
export function mapBridgeMessages(value: unknown, messagesOffsetValue?: unknown, options: MessageMappingOptions = {}): UiMessage[] {
  if (!Array.isArray(value)) throw new Error("Pi returned an invalid transcript message list.");
  const rawMessageOffset = bridgeMessagesOffset(messagesOffsetValue);
  const messages = value.flatMap((raw, index) => {
    // When the bridge gives us a raw offset, use it for fallback IDs too. A
    // bridge record without tauEntryId must still deduplicate across pages.
    const mapped = mapMessage(raw, rawMessageOffset === undefined ? index : rawMessageOffset + index, options);
    return mapped && (mapped.text || mapped.skill || messageHasCheckpointAnchor(mapped, options.checkpoints)) ? [mapped] : [];
  });
  return messages;
}

type ValidatedBridgeTranscriptPage = Omit<PiBridgeTranscriptPage, "olderCursor"> & {
  olderCursor?: string;
};

function bridgeTranscriptPage(value: unknown, expectedSessionId: string): ValidatedBridgeTranscriptPage {
  if (!value || typeof value !== "object") throw new Error("Pi returned an invalid transcript page.");
  const page = value as Partial<PiBridgeTranscriptPage>;
  const sessionId = page.sessionId;
  const messages = page.messages;
  const hasMore = page.hasMore;
  if (sessionId !== expectedSessionId || !Array.isArray(messages) || typeof hasMore !== "boolean") {
    throw new Error("Pi returned an invalid transcript page.");
  }
  const messagesOffset = bridgeMessagesOffset(page.messagesOffset);
  const olderCursor = bridgeTranscriptCursor(page.olderCursor);
  const historyCompletenessValue = normalizeBridgeHistoryCompleteness(page.historyCompleteness);
  if (!isTranscriptHistoryMetadataConsistent({
    hasMore,
    hasCursor: olderCursor !== undefined,
    historyCompleteness: historyCompletenessValue,
    requireHasMore: true,
  })) throw new Error("Pi returned an invalid transcript page.");
  const historyCompleteness = historyCompletenessValue === undefined
    ? undefined
    : parseTranscriptHistoryCompleteness(historyCompletenessValue);
  if (historyCompletenessValue !== undefined && historyCompleteness === undefined) {
    throw new Error("Pi returned an invalid transcript history completeness.");
  }
  if (page.taskHistory !== undefined && !Array.isArray(page.taskHistory)) {
    throw new Error("Pi returned an invalid transcript activity history.");
  }
  const turnCheckpoints = Array.isArray(page.turnCheckpoints)
    ? page.turnCheckpoints.filter((checkpoint): checkpoint is UiTurnCheckpoint => Boolean(checkpoint && typeof checkpoint === "object"))
    : undefined;
  return {
    sessionId,
    messages,
    hasMore,
    ...(page.taskHistory !== undefined ? { taskHistory: page.taskHistory } : {}),
    ...(messagesOffset !== undefined ? { messagesOffset } : {}),
    ...(olderCursor !== undefined ? { olderCursor } : {}),
    ...(historyCompleteness !== undefined ? { historyCompleteness } : {}),
    ...(turnCheckpoints ? { turnCheckpoints } : {}),
  };
}

/** Validate and map one bridge-owned transcript page at the host seam. */
export function mapBridgeTranscriptPageValue(sessionId: string, value: unknown): TranscriptPage {
  const page = bridgeTranscriptPage(value, sessionId);
  const messages = mapBridgeMessages(page.messages, page.messagesOffset, { checkpoints: page.turnCheckpoints });
  const taskHistory = taskHistoryForMessages(page.taskHistory, messages);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const olderCursor = page.olderCursor === undefined
    ? undefined
    : hostCursorAtBridgeValue(page.olderCursor);
  const cursorBoundaries = normalizeTranscriptCursorBoundaries(
    undefined,
    firstUserMessage?.id,
    olderCursor,
  );
  return {
    sessionId,
    messages,
    transcriptWindow: "bounded",
    ...(taskHistory ? { taskHistory } : {}),
    ...(firstUserMessage ? { cursorBeforeMessageId: firstUserMessage.id } : {}),
    ...(olderCursor !== undefined ? { olderCursor } : {}),
    ...(cursorBoundaries ? { cursorBoundaries } : {}),
    historyCompleteness: resolveTranscriptHistoryCompleteness(page.historyCompleteness, page.hasMore),
    hasMore: page.hasMore,
    turnCheckpoints: checkpointsForMessages(page.turnCheckpoints, messages),
  };
}

/**
 * Finds the next row that the renderer would expose after an assistant entry.
 * Empty assistant messages are deliberately omitted until their checkpoint is
 * durable, so an explicit insertion point keeps a late anchor beside its own
 * turn even when a queued user message has already arrived.
 */
function nextVisibleMessageId(
  entries: readonly unknown[],
  sourceEntryId: string,
  checkpoints: readonly UiTurnCheckpoint[] = [],
): string | undefined {
  const sourceIndex = entries.findIndex((entry) => entry && typeof entry === "object"
    && (entry as { id?: unknown }).id === sourceEntryId);
  if (sourceIndex < 0) return undefined;
  for (let index = sourceIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const item = entry as { id?: unknown; message?: unknown };
    if (typeof item.id !== "string") continue;
    const message = mapMessage({
      ...(item.message && typeof item.message === "object" ? item.message : {}),
      tauEntryId: item.id,
    }, index);
    if (message && (Boolean(message.text) || messageHasCheckpointAnchor(message, checkpoints))) return message.id;
  }
  return undefined;
}

export function lastTurnActivityFromMessages(messages: unknown[]): UiTurnActivity | undefined {
  let turnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string } | undefined;
    if (message?.role === "user") {
      turnStart = index;
      break;
    }
  }
  if (turnStart < 0) return undefined;

  const tools: UiToolRun[] = [];
  const toolIndexes = new Map<string, number>();
  let anchorMessageId: string | undefined;
  let lastVisibleMessageId: string | undefined;

  for (let index = turnStart; index < messages.length; index += 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    const mapped = mapMessage(message, index);
    if (mapped && (mapped.role === "user" || mapped.text.trim())) lastVisibleMessageId = mapped.id;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (call.type !== "toolCall" || !call.id || !call.name) continue;
        anchorMessageId ??= lastVisibleMessageId;
        toolIndexes.set(call.id, tools.length);
        tools.push({
          id: call.id,
          name: call.name,
          args: call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {},
          status: "running",
          startedAt: message.timestamp ?? Date.now(),
        });
      }
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const toolIndex = toolIndexes.get(message.toolCallId);
      if (toolIndex === undefined) continue;
      const tool = tools[toolIndex];
      const output = textFromContent(message.content);
      tools[toolIndex] = {
        ...tool,
        name: message.toolName ?? tool.name,
        status: message.isError ? "error" : "done",
        output: output.length > 8_192 ? `${output.slice(0, 8_192)}\n[Restored output truncated]` : output,
        endedAt: message.timestamp ?? tool.startedAt,
      };
    }
  }

  return tools.length > 0 ? { tools, anchorMessageId } : undefined;
}

function mapModel(model: { provider: string; id: string; name?: string }): UiModel {
  return { provider: model.provider, id: model.id, name: model.name ?? model.id };
}

export function modelSupportsImageInput(model: { input?: readonly string[] } | undefined): boolean {
  return model?.input?.includes("image") === true;
}

function assertImageInputCapability(session: AgentSession, attachments: readonly UiPromptAttachment[]): void {
  if (attachments.length > 0 && !modelSupportsImageInput(session.model)) {
    throw new Error("The active model does not support image input.");
  }
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "Untitled thread";
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/u);
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trimEnd()}…` : sentence;
}

function visibleTitleText(value: string): string {
  // A raw skill wrapper has no trustworthy title text. Keep runtime internals
  // out of sidebar/title fallback rather than echoing its tag or local path.
  return /<skill\b/iu.test(value)
    ? "Skill invocation"
    : value;
}

function safeSessionTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return cleanThreadTitle(visibleTitleText(value)); }
  catch { return undefined; }
}

interface TitleMessage {
  role?: string;
  content?: unknown;
  skill?: { name?: unknown; command?: unknown };
}

function titleVisibleUserText(text: string, metadata: TitleMessage["skill"]): string {
  const envelope = parseSkillEnvelope(text);
  if (envelope && metadata
    && metadata.name === envelope.name
    && typeof metadata.command === "string"
    && metadata.command.replace(/^\/skill:/u, "").replace(/^\//u, "") === envelope.name) {
    return envelope.userMessage;
  }
  return visibleTitleText(text);
}

export function buildTitleConversation(
  runtimeMessages: readonly TitleMessage[],
  persistedMessages: readonly TitleMessage[] = [],
): string {
  function render(messages: readonly TitleMessage[]): string {
    return messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const text = textFromContent(message.content);
        return `${message.role}: ${message.role === "user" ? titleVisibleUserText(text, message.skill) : text}`;
      })
      .filter((line) => line.trim().length > line.indexOf(":") + 1)
      .slice(0, 4)
      .join("\n\n")
      .slice(0, 6000);
  }
  return render(runtimeMessages) || render(persistedMessages);
}

export function cleanThreadTitle(value: string): string {
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine
    .replace(/^\s*(?:#{1,6}|>|[-+*])\s+/u, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/(?:\*\*|__|~~|`)+/gu, "")
    .replace(/^(?:(?:the\s+)?(?:thread\s+)?title|titel)\s*(?:is|lautet)?\s*[:\-]\s*/iu, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(/[.!?:;]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!title) throw new Error("The title model returned an empty title.");
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
}

async function mapSessions(
  sessions: SessionInfo[],
  fallbackCwd: string,
  resolveBranch: (cwd: string) => Promise<string | undefined>,
  resolveProjectName: (cwd: string) => string = (cwd) => basename(cwd) || cwd,
): Promise<UiSession[]> {
  const recent = [...sessions]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 80);
  const projectPaths = [...new Set(recent.map((session) => session.cwd || fallbackCwd))];
  const branches = new Map(
    await Promise.all(projectPaths.map(async (path) => [path, await resolveBranch(path)] as const)),
  );
  return recent.map((session) => {
    const projectPath = session.cwd || fallbackCwd;
    return {
      id: session.id,
      path: session.path,
      title: cleanThreadTitle(safeSessionTitle(session.name) || firstSentence(visibleTitleText(session.firstMessage))),
      modifiedAt: session.modified.getTime(),
      projectPath,
      projectName: resolveProjectName(projectPath),
      branch: branches.get(projectPath),
      messageCount: session.messageCount,
      backendKind: "pi",
    };
  });
}

function sessionShellEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id && left.path === right.path && left.title === right.title &&
    left.modifiedAt === right.modifiedAt && left.projectPath === right.projectPath &&
    left.projectName === right.projectName && left.branch === right.branch &&
    left.messageCount === right.messageCount && left.backendKind === right.backendKind;
}

export function sessionIndexUpdates(previous: UiSession[], next: UiSession[]): HostUpdate[] {
  const previousById = new Map(previous.map((session) => [session.id, session] as const));
  const nextById = new Map(next.map((session) => [session.id, session] as const));
  const updates: HostUpdate[] = [];
  for (const shell of next) {
    const old = previousById.get(shell.id);
    if (!old || !sessionShellEqual(old, shell)) {
      updates.push({ version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, shell } });
    }
  }
  for (const shell of previous) {
    if (!nextById.has(shell.id)) {
      updates.push({ version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, removed: true } });
    }
  }
  return updates;
}

export interface ActiveThreadShellInput {
  id: string;
  path: string;
  explicitTitle?: string;
  derivedTitle: string;
  now: number;
  projectPath: string;
  projectName: string;
  branch?: string;
  messageCount: number;
  backendKind?: ThreadBackendKind;
}

export function reconcileActiveThreadShell(
  input: ActiveThreadShellInput,
  existing: UiSession | undefined,
  touch: boolean,
): UiSession {
  return {
    id: input.id,
    path: input.path,
    title: input.explicitTitle || (!touch ? existing?.title : undefined) || input.derivedTitle,
    modifiedAt: touch ? input.now : existing?.modifiedAt ?? input.now,
    projectPath: input.projectPath,
    projectName: input.projectName,
    branch: input.branch,
    messageCount: input.messageCount,
    ...(input.backendKind ? { backendKind: input.backendKind } : {}),
  };
}

export function mergeSessionIndexScan(
  scanned: UiSession[],
  current: UiSession[],
  scanStartedAt: number,
  keepIds: ReadonlySet<string> = new Set(),
): UiSession[] {
  // A thread that only lives in memory (a new one without its first message)
  // has no file for the scan to find; it must survive on its live state alone.
  const newer = new Map(current
    .filter((session) => session.modifiedAt >= scanStartedAt || keepIds.has(session.id))
    .map((session) => [session.id, session]));
  const merged = scanned.map((session) => newer.get(session.id) ?? session);
  const scannedIds = new Set(merged.map((session) => session.id));
  for (const session of newer.values()) {
    if (!scannedIds.has(session.id)) merged.push(session);
  }
  return merged;
}

export async function assertWorkspacePath(cwd: string, path: string): Promise<void> {
  return workspaceGit.assertWorkspacePath(cwd, path);
}

function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "powershell") return String(input.command ?? "shell command");
  const path = input.path;
  if (typeof path === "string") return path;
  return Object.keys(input).join(" · ") || toolName;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return textFromContent(content);
}

export const MAX_HOST_TOOL_OUTPUT_BYTES = 128 * 1024;
export function boundedToolOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_HOST_TOOL_OUTPUT_BYTES) return output;
  const tail = bytes.subarray(bytes.length - MAX_HOST_TOOL_OUTPUT_BYTES).toString("utf8");
  return `[Earlier tool output truncated by host; showing the latest ${MAX_HOST_TOOL_OUTPUT_BYTES} bytes.]\n${tail}`;
}

interface LiveAssistant {
  id: string;
  text: string;
  thinking: string;
  timestamp: number;
}

/**
 * A committed restore keeps its recovery thread discoverable without making
 * that thread the one resumed by `continueRecent` on the next launch.
 */
export async function prioritizeRestoreTargetSession(targetPath: string, backupPath: string): Promise<void> {
  const [target, backup] = await Promise.all([stat(targetPath), stat(backupPath)]);
  // Keep a visible gap because findMostRecentSession compares millisecond
  // timestamps while some filesystems expose coarser mtime resolution.
  const targetTime = Math.max(Date.now() + 2_000, target.mtimeMs + 1_000, backup.mtimeMs + 2_000);
  const backupTime = Math.max(0, targetTime - 1_000);
  await utimes(backupPath, new Date(backupTime), new Date(backupTime));
  await utimes(targetPath, new Date(targetTime), new Date(targetTime));
}

interface RestoreActivationTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** In-flight state of one thread's current turn, whichever process runs it. */
interface LiveTurnState {
  readonly tools: Map<string, UiToolRun>;
  checkpointRuntime?: WorkspaceKitCheckpointRuntime;
  currentAssistantId?: string;
  /** Assistant text still streaming, so a thread opened mid-turn shows it. */
  liveAssistant?: LiveAssistant;
}

type DeferredThreadRecord =
  | { kind: "event"; event: any; sessionId: string; cwd: string }
  | { kind: "error"; error: unknown }
  | { kind: "host"; event: ThreadHostEvent }
  | { kind: "title"; title: string };

/**
 * One Pi runtime bound to one session for the runtime's whole life. Threads
 * never share a runtime, so switching the workbench between them never aborts
 * or replaces anything — it only changes which one is on screen.
 */
class ThreadRuntime implements LiveTurnState {
  readonly tools = new Map<string, UiToolRun>();
  readonly pendingClientMessageIds: string[] = [];
  pendingClientMessageFingerprints = new Map<string, string>();
  /** Markers assigned at message_start but not finalized at message_end yet. */
  readonly inFlightClientMessageIds = new Set<string>();
  adapterMessages: UiMessage[] = [];
  adapterTitle?: string;
  adapterTitleSource?: ClaudeTitleSource;
  adapterStreaming = false;
  adapterPending = 0;
  adapterAbortGeneration = 0;
  adapterAbortControllers = new Set<AbortController>();
  adapterQueue: Promise<void> = Promise.resolve();
  currentAssistantId?: string;
  liveAssistant?: LiveAssistant;
  unsubscribe?: () => void;
  private deferredRecords?: DeferredThreadRecord[];

  constructor(
    readonly backend: ThreadRuntimeBackend,
    readonly runtime?: AgentSessionRuntime,
    readonly checkpointFeature?: WorkspaceKitCheckpointFeature,
  ) {}

  get checkpointRuntime(): WorkspaceKitCheckpointRuntime | undefined {
    return this.checkpointFeature?.runtime;
  }

  get runtimeAdapter(): AgentRuntimeAdapter { return this.backend.runtimeAdapter; }
  get threadId(): string { return this.backend.threadId; }
  /** @deprecated External v1 calls still use sessionId; internal code uses threadId. */
  get sessionId(): string { return this.threadId; }
  get cwd(): string { return this.backend.cwd; }
  get sessionFile(): string | undefined { return this.backend.sessionFile(); }

  resetLiveState(): void {
    this.tools.clear();
    this.pendingClientMessageIds.length = 0;
    this.pendingClientMessageFingerprints.clear();
    this.inFlightClientMessageIds.clear();
    this.adapterAbortControllers.clear();
    void this.checkpointRuntime?.settle();
    this.currentAssistantId = undefined;
    this.liveAssistant = undefined;
  }

  beginEventBarrier(): void {
    this.deferredRecords = [];
  }

  private defer(record: DeferredThreadRecord): boolean {
    if (!this.deferredRecords) return false;
    this.deferredRecords.push(record);
    return true;
  }

  deferEvent(event: any, sessionId: string, cwd: string): boolean {
    return this.defer({ kind: "event", event, sessionId, cwd });
  }

  deferError(error: unknown): boolean {
    return this.defer({ kind: "error", error });
  }

  deferHostEvent(event: ThreadHostEvent): boolean {
    // Questions must remain answerable while a prepared runtime is binding;
    // buffering their prompt would deadlock bind until the answer arrives.
    if (event.type === "extension-ui-prompt" || event.type === "extension-ui-resolved") return false;
    return this.defer({ kind: "host", event });
  }

  deferTitle(title: string): boolean {
    return this.defer({ kind: "title", title });
  }

  releaseEventBarrier(
    dispatch: (event: any, thread: ThreadRuntime, sessionId: string, cwd: string, error?: unknown) => void,
    dispatchHost: (event: ThreadHostEvent) => void,
    dispatchTitle: (title: string) => void,
  ): void {
    const records = this.deferredRecords;
    this.deferredRecords = undefined;
    for (const record of records ?? []) {
      if (record.kind === "event") dispatch(record.event, this, record.sessionId, record.cwd);
      else if (record.kind === "error") dispatch(undefined, this, this.sessionId, this.cwd, record.error);
      else if (record.kind === "host") dispatchHost(record.event);
      else dispatchTitle(record.title);
    }
  }

  cancelEventBarrier(): void {
    this.deferredRecords = undefined;
  }
}

function isThreadRuntime(thread: LiveTurnState | undefined): thread is ThreadRuntime {
  // The bridge has a deliberately smaller live-state carrier. Only an owned
  // Pi backend has a Session/AgentSessionRuntime whose events can be handled
  // here; external runtimes publish their own normalized messages.
  if (!thread || !("backend" in thread)) return false;
  const candidate = thread as ThreadRuntime;
  return candidate.backend.kind === "pi" && Boolean(candidate.runtime);
}

function threadBackendKind(thread: ThreadRuntime | LiveTurnState | undefined): ThreadBackendKind {
  if (thread && "backend" in thread && thread.backend) return thread.backend.kind;
  return thread && "runtimeAdapter" in thread && thread.runtimeAdapter.id === "claude-code" ? "claude-code" : "pi";
}

function isPiBackend(thread: ThreadRuntime | LiveTurnState | undefined): boolean {
  return threadBackendKind(thread) === "pi";
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right) && resolve(left!) === resolve(right!);
}

export class PiHost {
  private cwd: string;
  /** Adapters are selected once, then each thread permanently owns one backend. */
  private readonly runtimeAdapters: Record<ThreadBackendKind, AgentRuntimeAdapter>;
  private readonly defaultBackendKind: ThreadBackendKind;
  private readonly runtimeCommands: readonly UiComposerCommand[];
  private readonly claudeStore: ClaudeRuntimeSessionStore;
  private emit: Emit;
  private bridge?: PiBridgeClient;
  private bridgeSnapshot?: PiBridgeSnapshot;
  private readonly pendingBridgeNewSessions = new Map<NewThreadRequestId, {
    previousSessionId?: string;
    projectPath: string;
    bridgeEpoch: string;
    resolve: (snapshot: PiBridgeSnapshot) => void;
    reject: (error: unknown) => void;
    observed?: { sessionId: string; sessionFile: string; bridgeEpoch: string };
    acknowledging?: boolean;
  }>();
  /** Requests detached during a transport handoff still need Pi-side cleanup. */
  private readonly pendingBridgeNewSessionAborts = new Map<NewThreadRequestId, { projectPath: string; attempting?: boolean }>();
  /** Set while Tau deliberately takes a thread over from Pi, so it does not re-attach. */
  private suppressBridgeAttach = false;
  private readonly bridgeReconnectLoop = new PiBridgeReconnectLoop();
  private bridgeUnsubscribe?: () => void;
  private readonly agentDir = getAgentDir();
  private extensionCount = 0;
  private readonly lifecycleMetrics = new HostLifecycleInstrumentation();
  private readonly gitCoordinator = new GitCoordinator({ onSubprocess: () => this.lifecycleMetrics.countSubprocess() });
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly resourceDiscoveryCache = new RuntimeResourceCache<ResourceDiscoverySnapshot>({ maxEntries: 4, ttlMs: 5 * 60_000 });
  private readonly threads = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => (record.runtime.backend?.isIdle?.() ?? true)
      && !this.hasOpenUiPrompts(record.threadId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      && (record.runtime.checkpointRuntime?.pendingCount ?? 0) === 0
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && (record.runtime.backend.hasMessages() || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => this.disposeThread(record.runtime),
  });
  /** Runtimes being opened, keyed by session file, so a prewarm and a switch share one. */
  private readonly openingThreads = new Map<string, Promise<ThreadRuntime>>();
  /** A blank runtime for the current project, so a new thread is ready before it is asked for. */
  private spare?: { cwd: string; pending: Promise<ThreadRuntime | undefined>; cancel: () => void };
  private preparedThreadCapabilityGeneration = 0;
  /** Session managers whose runtime is being built in the background, outside any measurement. */
  private readonly backgroundManagers = new WeakSet<SessionManager>();
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];
  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private sessions: UiSession[] = [];
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private threadIndexRefresh?: Promise<ThreadIndexSnapshot>;
  private readonly detailStore = new ThreadDetailStore(5);
  private activeIndexPublish?: ReturnType<typeof setTimeout>;
  private indexRecoveryTimer?: ReturnType<typeof setInterval>;
  private projectBranch?: string;
  /** Last known branch per project. Git is never awaited on an interactive path. */
  private readonly knownBranches = new Map<string, string | undefined>();
  private readonly branchRefreshes = new Map<string, Promise<void>>();
  /** A linked worktree keeps the repository's project name instead of becoming a new project. */
  private readonly knownProjectNames = new Map<string, string>();
  private readonly pendingShellUpdates = new Map<string, UiSession>();
  private accessLevel: AccessLevel = "full";
  private serviceTier: ServiceTier = "standard";
  private pendingApprovals = new Map<string, { sessionId: string; settle: (decision: AccessDecision) => void }>();
  private pendingUiPrompts = new Map<string, { sessionId: string; settle: (answer: ExtensionUiAnswer) => void }>();
  /** Prompts still awaiting an answer, kept so a late subscriber still sees them. */
  private openUiPrompts = new Map<string, ExtensionUiPrompt>();
  /** Free text typed for a select, waiting to answer the extension's follow-up input. */
  private typedAnswers = new Map<string, { text: string; expiresAt: number }>();
  /** Set by the app shell so extensions can retitle the window. */
  onWindowTitle?: (title: string) => void;
  private approvalCounter = 0;
  private readonly toolOutputBatcher: ToolOutputBatcher;
  /** Filesystem leases coordinate every runtime that shares a checkout. */
  private readonly checkpointLeaseManager = new WorkspaceCheckpointLeaseManager();
  /** Workspace Kit owns checkpoint persistence and maintenance; host code only adapts it. */
  private readonly checkpointMaintenance: WorkspaceKitCheckpointMaintenance = createWorkspaceKitCheckpointMaintenance(this.checkpointLeaseManager);
  private readonly toolOwners = new Map<string, string>();
  /** Lifecycle instances are created with each Pi runtime and shared with its inline adapter. */
  private readonly checkpointFeatures = new WeakMap<object, WorkspaceKitCheckpointFeature>();
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const reason = sessionStartEvent?.reason ?? "initial";
    const scenario = reason === "initial" ? "bootstrap" : reason === "resume" ? "cold-switch" : "warm-switch";
    const ownsMeasurement = !this.lifecycleMetrics.isActive() && !this.backgroundManagers.has(sessionManager);
    if (ownsMeasurement) this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", scenario);
    const totalStartedAt = performance.now();

    const settingsStartedAt = performance.now();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    this.logRuntimePhase("settings", settingsStartedAt, reason, cwd);

    const modelsStartedAt = performance.now();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    this.logRuntimePhase("models", modelsStartedAt, reason, cwd);

    const resourcesStartedAt = performance.now();
    const resourceKey = this.resourceFingerprint(cwd, settingsManager);
    const cachedResources = this.resourceDiscoveryCache.get(resourceKey);
    const checkpointFeature = this.createWorkspaceKitCheckpointFeature(sessionManager, cwd);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...(cachedResources ? cachedResourceOptions(cachedResources) : {}),
        noExtensions: this.safeMode,
        // Inline factories load even in safe mode, so the access gate is never bypassed.
        extensionFactories: [
          { name: "tau-access", factory: this.accessExtension },
          { name: "tau-service-tier", factory: this.serviceTierExtension },
          { name: "tau-questionnaire", factory: this.questionnaireExtension },
          ...(this.safeMode ? [] : [{
            name: "tau-turn-checkpoints",
            factory: checkpointFeature.createPiExtension({
              nextTurnId: randomUUID,
              findAssistantAnchor: assistantAnchorForMessage,
            }),
          }]),
          ...(this.safeMode ? [] : computerUseExtensionFactories(settingsManager)),
        ],
      },
    });
    if (!cachedResources) this.resourceDiscoveryCache.set(resourceKey, captureResourceDiscovery(services.resourceLoader));
    this.logRuntimePhase(cachedResources ? "resources-cache-hit" : "resources", resourcesStartedAt, reason, cwd);

    const sessionStartedAt = performance.now();
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    this.logRuntimePhase("session", sessionStartedAt, reason, cwd);
    this.logRuntimePhase("total", totalStartedAt, reason, cwd);
    if (ownsMeasurement) this.lifecycleMetrics.end();

    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

  private readonly accessExtension = createAccessExtension({
    level: () => this.accessLevel,
    onBlocked: (toolName, reason) => this.log("access.blocked", `${toolName}: ${reason}`),
    requestApproval: (toolCallId, toolName, input, sessionId) => this.requestApproval(toolCallId, toolName, input, sessionId),
  });

  /** Questionnaires announced per thread, and how many of their questions were asked so far. */
  private readonly questionnaires = new Map<string, { questions: UiQuestionnaireQuestion[]; asked: number }>();

  private readonly questionnaireExtension = createQuestionnaireExtension({
    onQuestionnaire: (sessionId, questions) => this.questionnaires.set(sessionId, { questions, asked: 0 }),
    onCleared: (sessionId) => this.questionnaires.delete(sessionId),
  });

  /** Threads and models the priority tier was already reported for; every request applies it. */
  private readonly serviceTierReported = new Set<string>();

  private readonly serviceTierExtension = createServiceTierExtension({
    fastRequested: () => this.serviceTier === "fast",
    available: () => this.serviceTierAvailable(),
    onApplied: (scope) => {
      if (this.serviceTierReported.has(scope)) return;
      this.serviceTierReported.add(scope);
      this.log("service-tier.applied", `priority · ${scope.slice(0, 8)}${scope.slice(36)}`);
    },
  });

  constructor(
    cwd: string,
    emit: Emit,
    private readonly projectHistory: ProjectHistory,
    private readonly safeMode = false,
    private readonly automaticPrewarm = true,
    options: PiHostOptions = {},
  ) {
    this.cwd = cwd;
    const selectedAdapter = this.safeMode ? PI_AGENT_RUNTIME_ADAPTER : options.runtimeAdapter ?? PI_AGENT_RUNTIME_ADAPTER;
    const configured = assertRuntimeAdapter(selectedAdapter);
    const configuredAdapters = options.runtimeAdapters ?? {};
    const piAdapter = assertRuntimeAdapter(configuredAdapters.pi ?? PI_AGENT_RUNTIME_ADAPTER);
    const configuredClaude = configuredAdapters["claude-code"]
      ? assertRuntimeAdapter(configuredAdapters["claude-code"])
      : configured.id === "claude-code" ? configured : undefined;
    if (configuredClaude && configuredClaude.id !== "claude-code") throw new Error("Claude backend requires the Claude Code runtime adapter.");
    this.runtimeAdapters = {
      pi: piAdapter,
      "claude-code": configuredClaude ?? createClaudeCodeRuntimeAdapter(),
    };
    const claude = this.runtimeAdapters["claude-code"];
    this.claudeStore = claude.id === "claude-code" && claude.sessionStore
      ? claude.sessionStore
      : new ClaudeRuntimeSessionStore({ filePath: ClaudeRuntimeSessionStore.defaultPath(this.agentDir) });
    this.defaultBackendKind = this.safeMode ? "pi" : options.defaultBackendKind ?? configured.id;
    this.runtimeCommands = options.runtimeCommands ?? [];
    this.emit = (event) => {
      this.lifecycleMetrics.recordIpc(event);
      emit(event);
    };
    this.toolOutputBatcher = new ToolOutputBatcher((updates) => {
      for (const [id, output] of updates) {
        this.emit({ type: "tool-update", sessionId: this.toolOwners.get(id) ?? "", id, output });
      }
    });
  }

  private adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter {
    return this.runtimeAdapters[kind];
  }

  private createWorkspaceKitCheckpointFeature(
    sessionManager: SessionManager,
    cwd: string,
  ): WorkspaceKitCheckpointFeature {
    const sessionId = sessionManager.getSessionId();
    const feature = createWorkspaceKitCheckpointFeature({
      contextForTurn: () => ({ cwd, sessionId }),
      branchForWorkspace: (workspace) => this.knownBranches.get(workspace),
      leaseManager: this.checkpointLeaseManager,
      maintenance: this.checkpointMaintenance,
      appendCheckpoint: async (stored) => {
        const branch = sessionManager.getBranch();
        if (turnCheckpointsFromEntries(branch, sessionId).some((entry) => entry.id === stored.id)) return;
        // Keep the lease until SessionManager has synchronously appended the
        // custom entry. A write error is intentionally propagated so the
        // lifecycle removes the provisional refs instead of releasing a
        // checkpoint that only exists in memory.
        sessionManager.appendCustomEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
        // Persistence has completed at this point. Rendering is best effort:
        // a broken subscriber or socket must never make the lifecycle delete a
        // valid checkpoint's immutable refs.
        try { this.emit({ type: "turn-checkpoint", sessionId, checkpoint: cloneTurnCheckpoint(stored) }); } catch { /* UI delivery is best effort */ }
        try { this.log("turn.checkpoint.saved", `${stored.fileCount} ${stored.fileCount === 1 ? "file" : "files"}`); } catch { /* diagnostics are best effort */ }
      },
      onError: (error, capture) => this.log("turn.checkpoint.failed", `${capture.id}: ${this.errorMessage(error)}`),
      onStatus: (status, capture) => this.emit({ type: "turn-checkpoint-status", sessionId, turnId: capture.id, status }),
    });
    this.checkpointFeatures.set(sessionManager, feature);
    return feature;
  }

  // ---------------------------------------------------------------------------
  // Active thread accessors. Most of the host reads "the runtime": it is the one
  // the workbench shows, or nothing while Pi's own TUI owns the visible thread.
  // ---------------------------------------------------------------------------

  private get active(): ThreadRuntime | undefined {
    return this.threads.active?.runtime;
  }

  private requireActive(): ThreadRuntime {
    const thread = this.active;
    if (!thread) throw new Error("Pi runtime is not ready");
    return thread;
  }

  private threadFor(threadId: string | undefined): ThreadRuntime | undefined {
    if (!threadId) return this.active;
    return this.threads.get(threadId)?.runtime;
  }

  private requireThread(threadId: string | undefined): ThreadRuntime {
    const thread = this.threadFor(threadId);
    if (!thread) {
      throw new Error(threadId && threadId !== this.active?.threadId
        ? "That thread is not open any more. Open it again to continue."
        : "Pi runtime is not ready");
    }
    return thread;
  }

  /** Whether a command for a Tau thread id belongs to the thread Pi's TUI owns. */
  private bridgeOwns(threadId: string | undefined): boolean {
    return this.adapterFor("pi").id === "pi" && Boolean(this.bridge) && (!threadId || threadId === this.bridgeSnapshot?.sessionId);
  }

  private liveThreadForPath(path: string | undefined): ThreadRuntime | undefined {
    if (!path) return undefined;
    const storedThreadId = claudeThreadIdFromPath(path);
    if (storedThreadId) return this.threads.get(storedThreadId)?.runtime;
    const indexed = this.sessions.find((session) => session.path === path);
    if (indexed?.backendKind === "claude-code") return this.threads.get(indexed.id)?.runtime;
    return this.threads.list().find((record) => samePath(record.runtime.backend.sessionFile(), path))?.runtime;
  }

  private liveThreadIds(): Set<string> {
    return new Set(this.threads.list().map((record) => record.threadId));
  }

  private claudeSessionStore(): ClaudeRuntimeSessionStore | undefined {
    return this.claudeStore;
  }

  private async initialSessionManager(cwd: string): Promise<SessionManager> {
    return SessionManager.continueRecent(cwd);
  }

  private async openInitialThread(cwd: string): Promise<ThreadRuntime> {
    if (this.defaultBackendKind === "claude-code") {
      const latest = (await this.claudeStore.list(cwd))[0];
      return this.openClaudeThread(latest?.tauThreadId ?? randomUUID(), cwd, { resume: Boolean(latest) });
    }
    return this.openThread(await this.initialSessionManager(cwd), undefined);
  }

  async start(): Promise<HostBootstrap> {
    return this.runLifecycle(async () => {
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        await this.rememberProject(this.cwd);
        const safeModeOwner = this.safeMode ? await findPiBridge(this.cwd) : undefined;
        if (safeModeOwner && processIsAlive(safeModeOwner.pid)) {
          throw new Error("Pi already owns this session. Close Pi before opening the project in Tau safe mode.");
        }
        const bridgeAttached = this.defaultBackendKind === "pi" && await this.attachAvailableBridge(this.cwd);
        if (!bridgeAttached) {
          // A restore journal is written before any workspace mutation. Replay
          // its safe backup target before opening a session so a crash cannot
          // expose a half-restored checkout as a normal active thread.
          await this.recoverPendingRestoreTransactions();
          const thread = await this.openInitialThread(this.cwd);
          await this.activateThread(thread, false);
        }
        this.branchFor(this.cwd);
        const indexStartedAt = performance.now();
        this.log("bootstrap.first-content");
        // The global index is independent of the active detail. Publish it when
        // ready rather than making first content wait for every session file.
        void this.refreshThreadIndex(true).then(() => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.startIndexRecovery();
          this.scheduleRuntimePrewarm();
        }).catch((error) => this.fail(error));
        const result = await this.bootstrap();
        this.lifecycleMetrics.end();
        return result;
      } catch (error) {
        this.lifecycleMetrics.end();
        throw error;
      }
    });
  }

  async bootstrap(): Promise<HostBootstrap> {
    const host = { ...this.snapshotSync(await this.ensureModels()), branch: this.projectBranch };
    const detail = this.detailForSnapshot(host);
    const result: HostBootstrap = {
      threadIndex: this.threadIndexSnapshot(),
      version: HOST_PROTOCOL_VERSION,
      detail,
      catalog: catalogFromSnapshot(host),
      project: { cwd: host.cwd, branch: host.branch },
    };
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  /** Focused active detail endpoint; it never includes catalogs or project metadata. */
  async getThreadDetail(cursor?: HostTranscriptCursor): Promise<TranscriptPage | ThreadDetail> {
    const snapshot = await this.snapshot();
    const result = cursor !== undefined
      ? (() => {
        const page = this.transcriptPage(snapshot.sessionId, snapshot.messages, snapshot.taskHistory, cursor);
        return { ...page, turnCheckpoints: checkpointsForMessages(snapshot.turnCheckpoints, page.messages) };
      })()
      : this.detailForSnapshot(snapshot);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  async loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    let result: TranscriptPage;
    if (this.bridgeOwns(sessionId) && transcriptPagingNegotiated(this.bridgeSnapshot?.capabilities)) {
      const raw = cursor === undefined
        ? await this.bridgeCommand({ command: "transcript_page" }) as unknown
        : await this.bridgeCommand({ command: "transcript_page", cursor: bridgeCursorValue(cursor) }) as unknown;
      result = mapBridgeTranscriptPageValue(sessionId, raw);
    } else if (this.bridgeOwns(sessionId)) {
      // Older Pi bridge extensions expose a bounded snapshot but no paging
      // command. Keep that compatibility path local to the retained window.
      const snapshot = this.bridgeHostSnapshot();
      result = this.transcriptPage(sessionId, snapshot.messages, snapshot.taskHistory, cursor);
    } else {
      const thread = this.requireThread(sessionId);
      const rawMessages = this.branchMessagesWithEntryIds(thread);
      result = this.transcriptPage(
        sessionId,
        this.messageSnapshot(thread),
        taskProgressHistoryFromMessages(rawMessages),
        cursor,
      );
    }
    const page = {
      ...result,
      turnCheckpoints: checkpointsForMessages(
        this.bridgeOwns(sessionId) ? this.bridgeHostSnapshot().turnCheckpoints : this.turnCheckpoints(this.requireThread(sessionId)),
        result.messages,
      ),
    };
    this.lifecycleMetrics.recordIpc(page);
    return page;
  }

  private transcriptPage(
    sessionId: string,
    messages: readonly UiMessage[],
    taskHistory: readonly UiTaskProgressEntry[] | undefined,
    cursor?: HostTranscriptCursor,
  ): TranscriptPage {
    const page = TranscriptPager.pageFor(
      sessionId,
      messages,
      OLDER_TRANSCRIPT_TURN_LIMIT,
      cursor,
      localTranscriptCursorPolicy,
    );
    const visibleHistory = taskHistoryForMessages(taskHistory, page.messages);
    const firstUserMessage = page.messages.find((message) => message.role === "user");
    const cursorBoundaries = normalizeTranscriptCursorBoundaries(
      page.cursorBoundaries,
      firstUserMessage?.id,
      page.olderCursor,
    );
    return {
      ...page,
      ...(firstUserMessage ? { cursorBeforeMessageId: firstUserMessage.id } : {}),
      ...(cursorBoundaries ? { cursorBoundaries } : {}),
      ...(visibleHistory ? { taskHistory: visibleHistory } : {}),
    };
  }

  getLifecycleMeasurements() { return this.lifecycleMetrics.getMeasurements(); }
  getBackgroundLifecycleMeasurements() { return this.backgroundLifecycle.map((item) => ({ ...item })); }

  private detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail {
    // A fresh runtime snapshot is authoritative; only the renderer uses the
    // cached record for optimistic selection between host confirmations.
    const detail = detailFromSnapshot(snapshot, undefined, localTranscriptCursorPolicy);
    this.detailStore.set(detail);
    return requestId ? { ...detail, requestId } : detail;
  }

  private actionResult(updates: HostUpdate[]): HostActionResult {
    const result = { version: HOST_PROTOCOL_VERSION, updates } satisfies HostActionResult;
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  private newThreadResult(updates: HostUpdate[], submission: SubmissionResult, requestId?: NewThreadRequestId): NewThreadResult {
    return { ...this.actionResult(updates), submission, ...(requestId ? { requestId } : {}) };
  }

  /** Complete a correlated Pi handoff through one identity/publication path. */
  private completeBridgeNewSession(snapshot: PiBridgeSnapshot, requestId: NewThreadRequestId): NewThreadResult {
    this.bridgeSnapshot = snapshot;
    if (this.bridge) {
      this.bridge.descriptor.sessionId = snapshot.sessionId;
      this.bridge.descriptor.sessionFile = snapshot.sessionFile;
    }
    this.cwd = snapshot.cwd;
    const next = this.bridgeHostSnapshot();
    const firstUserMessage = snapshot.messages.find((message) => (
      message && typeof message === "object" && (message as { role?: string }).role === "user"
    )) as { content?: unknown } | undefined;
    const shell: UiSession = {
      id: snapshot.sessionId,
      path: snapshot.sessionFile,
      title: cleanThreadTitle(snapshot.sessionName || firstSentence(textFromContent(firstUserMessage?.content))),
      modifiedAt: Date.now(),
      projectPath: snapshot.cwd,
      projectName: this.projectNameFor(snapshot.cwd),
      branch: this.branchFor(snapshot.cwd),
      messageCount: next.messages.length,
    };
    this.sessions = [shell, ...this.sessions.filter((entry) => entry.id !== shell.id)];
    return this.newThreadResult([
      { version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, shell } },
      ...this.lifecycleUpdates(next),
    ], { accepted: true }, requestId);
  }

  private lifecycleUpdates(snapshot: HostSnapshot): HostUpdate[] {
    const shell = this.sessions.find((thread) => thread.id === snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: snapshot.cwd, branch: snapshot.branch } },
    ];
  }

  private async activeUpdates(): Promise<HostActionResult> {
    return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
  }

  async setWorkspace(cwd: string): Promise<HostActionResult> {
    return this.runLifecycle(() => this.setWorkspaceNow(cwd));
  }

  private async setWorkspaceNow(cwd: string): Promise<HostActionResult> {
    // Per-thread checkpoint preparation is owned by Pi's awaited event hook;
    // workspace switching never waits on another thread's history work.
    await this.rememberProject(cwd);
    if (cwd === this.cwd && (this.bridge || this.active)) {
      await this.recoverPendingRestoreTransactions(cwd);
      return this.activeUpdates();
    }
    if (this.defaultBackendKind === "pi" && await this.attachAvailableBridge(cwd)) {
      await this.rememberProject(this.cwd);
      await this.refreshActiveThreadIndex(false);
      return this.activeUpdates();
    }
    this.detachBridge();
    await this.recoverPendingRestoreTransactions(cwd);
    const startedAt = performance.now();
    const thread = this.defaultBackendKind === "claude-code"
      ? await this.openInitialThread(cwd)
      : await (async () => {
        const manager = await this.initialSessionManager(cwd);
        return this.liveThreadForPath(manager.getSessionFile())
          ?? await this.openThread(manager, { type: "session_start", reason: "resume", previousSessionFile: this.active?.sessionFile });
      })();
    await this.activateThread(thread, false);
    this.logReplacement("workspace", startedAt);
    return this.activeUpdates();
  }

  async removeProject(path: string): Promise<HostActionResult> {
    await this.projectHistory.remove(path);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-index",
      index: this.threadIndexSnapshot(),
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  /**
   * A bridge peer that stops answering must not strand ordinary commands. New
   * thread creation keeps its request owner until Pi either reports the matching
   * session or explicitly rejects it, so a delayed report cannot create a duplicate
   * local thread.
   */
  private async bridgeCommand(command: Parameters<PiBridgeClient["command"]>[0], retainOnDisconnect = false): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge) throw new Error("Pi bridge is not connected.");
    try {
      return await bridge.command(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out|not connected|closed|disconnected/iu.test(message)) throw error;
      this.log("bridge.unresponsive", command.command);
      if (retainOnDisconnect) return undefined;
      this.detachBridge();
      throw new Error("Pi stopped responding, so Tau detached from it and now runs this thread itself.");
    }
  }

  /**
   * Closes tool calls left dangling by a turn that never finished, so the thread
   * can be used again. Without a result the provider rejects the next request.
   */
  async recoverThread(): Promise<HostActionResult> {
    // While Pi owns the thread its session file has another writer. Only take it
    // over when Pi has actually stopped answering; otherwise repair belongs there.
    if (this.bridge) {
      const sessionFile = this.bridge.descriptor.sessionFile;
      let responsive = true;
      try {
        await this.bridge.command({ command: "ping" }, 2_000);
      } catch {
        responsive = false;
      }
      // Only a run that is genuinely in flight is worth protecting: repairing
      // under Pi's feet mid-turn would race its writer. An idle or absent peer
      // is not using the session, so Tau takes it over to close the call.
      if (responsive && this.bridgeSnapshot?.isStreaming) {
        throw new Error("Pi is running this thread right now. Stop the run in Pi, then try again.");
      }
      this.log(responsive ? "bridge.takeover" : "bridge.unresponsive", "recover_thread");
      this.detachBridge();
      this.suppressBridgeAttach = true;
      try {
        await this.switchSession(sessionFile);
      } finally {
        this.suppressBridgeAttach = false;
      }
    }

    const thread = this.requireActive();
    return this.threads.run(thread.threadId, async () => {
      if (!isPiBackend(thread)) {
        if (thread.adapterPending > 0 || thread.backend.isStreaming()) await this.abortThread(thread);
        thread.adapterMessages = await thread.backend.transcript();
        const snapshot = await this.snapshot();
        const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
        this.emitUpdate(update);
        return this.actionResult([update]);
      }
      // A run that is still in flight owns its tool calls; closing them from
      // outside would race the runtime. Stop it first, then repair.
      if (!thread.backend.isIdle() || thread.adapterPending > 0) await this.abortThread(thread);
      // Zero dangling calls is a success: the session is already consistent and
      // the caller only has stale activity to clear.
      const dangling = findDanglingToolCalls(thread.backend.branchEntries()
        .flatMap((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message"
          ? [(entry as { message?: unknown }).message]
          : []));
      for (const { toolCallId, toolName } of dangling) {
        thread.backend.appendMessage({
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: "Interrupted: Tau closed this tool call so the thread could continue." }],
          isError: true,
          timestamp: Date.now(),
        });
      }
      thread.tools.clear();
      this.log("thread.recovered", dangling.length === 0
        ? "session already consistent"
        : `${dangling.length} tool ${dangling.length === 1 ? "call" : "calls"}`);
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return this.actionResult([update]);
    });
  }

  async newSession(
    initialPrompt?: string,
    attachments: UiPromptAttachment[] = [],
    cwd?: string,
    clientMessageIdOrRequestId?: string,
    prepared?: PreparedPrompt,
  ): Promise<HostActionResult> {
    const requestId = clientMessageIdOrRequestId?.startsWith("new-thread-")
      ? clientMessageIdOrRequestId as NewThreadRequestId
      : undefined;
    const clientMessageId = requestId ? undefined : clientMessageIdOrRequestId;
    const backendKind = prepared?.backendKind ?? this.defaultBackendKind;
    if (prepared && backendKind !== "pi" && backendKind !== "claude-code") {
      throw new Error("Prepared prompt names an unsupported runtime backend.");
    }
    if (backendKind === "pi" && this.bridge && (!cwd || cwd === this.cwd)) {
      const bridgeRequestId = requestId ?? createNewThreadRequestId(randomUUID());
      if (attachments.length > 0) {
        return this.newThreadResult([], { accepted: false, message: "Image attachments are not supported while Tau is attached to Pi." }, bridgeRequestId);
      }
      if (prepared) this.assertBridgePreparedPrompt(initialPrompt ?? "", prepared);
      let resolveBridgeSession: ((snapshot: PiBridgeSnapshot) => void) | undefined;
      let rejectBridgeSession: ((error: unknown) => void) | undefined;
      const bridgeSession = new Promise<PiBridgeSnapshot>((resolve, reject) => {
        resolveBridgeSession = resolve;
        rejectBridgeSession = reject;
      });
      void bridgeSession.catch(() => undefined);
      this.pendingBridgeNewSessions.set(bridgeRequestId, {
        previousSessionId: this.bridgeSnapshot?.sessionId,
        projectPath: this.cwd,
        bridgeEpoch: this.bridge?.descriptor.epoch ?? "",
        resolve: resolveBridgeSession!,
        reject: rejectBridgeSession!,
      });
      try {
        const response = await this.bridgeCommand({
          command: "new_session",
          initialPrompt,
          requestId: bridgeRequestId,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}),
        }, true);
        const responseRequestId = response && typeof response === "object" && "requestId" in response
          ? response.requestId
          : undefined;
        if (response && responseRequestId !== bridgeRequestId) {
          throw new Error("The Pi bridge did not acknowledge this new-thread request.");
        }
        const bridgeSnapshot = response && typeof response === "object" && "snapshot" in response
          ? response.snapshot as PiBridgeSnapshot
          : undefined;
        if (bridgeSnapshot?.sessionId && bridgeSnapshot.cwd) {
          const pending = this.pendingBridgeNewSessions.get(bridgeRequestId);
          if (bridgeSnapshot.newSessionRequestId !== bridgeRequestId
            || bridgeSnapshot.cwd !== this.cwd
            || !pending
            || pending.projectPath !== bridgeSnapshot.cwd
            || pending.bridgeEpoch !== this.bridge?.descriptor.epoch) {
            throw new Error("Pi returned an uncorrelated new-thread snapshot.");
          }
          pending.observed = {
            sessionId: bridgeSnapshot.sessionId,
            sessionFile: bridgeSnapshot.sessionFile,
            bridgeEpoch: this.bridge?.descriptor.epoch ?? "",
          };
          void this.acknowledgeBridgeNewSession(bridgeRequestId, this.bridge?.descriptor.epoch);
          return this.completeBridgeNewSession(bridgeSnapshot, bridgeRequestId);
        }
        // A bridge without snapshots cannot prove a handoff, but should not
        // strand legacy callers that only expect command acceptance.
        if (!response && !this.bridgeSnapshot) {
          this.pendingBridgeNewSessions.delete(bridgeRequestId);
          return this.newThreadResult([], { accepted: true }, bridgeRequestId);
        }
        return this.completeBridgeNewSession(await bridgeSession, bridgeRequestId);
      } catch (error) {
        this.pendingBridgeNewSessions.delete(bridgeRequestId);
        const reason = error instanceof Error ? error.message : String(error);
        this.log("bridge.new_session.rejected", reason);
        return this.newThreadResult([], { accepted: false, message: reason }, bridgeRequestId);
      }
    }
    // A prepared prompt from the currently visible thread may be carried into
    // a new-thread request. It is deliberately re-prepared after the new
    // backend is created; only an owner-less preflight can be validated here.
    if (prepared && prepared.tauThreadId === undefined && prepared.sessionId === undefined) {
      const adapter = this.adapterFor(backendKind);
      const commands = backendKind === "claude-code"
        ? this.claudeComposerCommands(cwd ?? this.cwd)
        : this.runtimeCommands;
      validatePreparedPrompt(initialPrompt ?? "", prepared, {
        backendKind,
        runtimeCapabilities: adapter.capabilities,
        commands,
      });
    }
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      const targetCwd = cwd ?? this.cwd;
      this.detachBridge();
      const spare = backendKind === "pi" ? await this.takePreparedThread(targetCwd) : undefined;
      const thread = spare
        ?? (backendKind === "claude-code"
          ? await this.openClaudeThread(randomUUID(), targetCwd, { resume: false })
          : await this.openThread(
            SessionManager.create(targetCwd),
            { type: "session_start", reason: "new", previousSessionFile: this.active?.sessionFile },
            { adopt: false, prepared: true },
          ));
      let lifecycle: "prepared" | "adopting" | "adopted" | "promoted" = "prepared";
      try {
        if (isPiBackend(thread) && thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
        else if (!isPiBackend(thread) && attachments.length > 0) {
          throw new Error("Image attachments are not supported by the selected runtime adapter.");
        }
        // Decode and validate attachment data before promoting a prepared
        // runtime, so malformed input cannot leave an adopted blank thread.
        if (attachments.length > 0) promptImages(attachments);
        lifecycle = "adopting";
        await this.adoptThread(thread);
        lifecycle = "adopted";
        await this.activateThread(thread, true);
        lifecycle = "promoted";
        if (isPiBackend(thread)) {
          // Shell/index publication precedes releasing buffered runtime events;
          // extension questions remain answerable after release.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          thread.releaseEventBarrier((event, runtime, sessionId, eventCwd, error) => {
            if (error) this.fail(error, sessionId);
            else this.handleSessionEvent(event, runtime, sessionId, eventCwd);
          }, (event) => this.emit(event), (title) => this.onWindowTitle?.(title));
        }
        if (initialPrompt?.trim()) {
          const presentation = prepared?.skill ?? skillMessagePresentation(initialPrompt, thread.runtimeAdapter, this.composerCommands(thread));
          const visiblePrompt = prepared?.visibleText ?? (presentation && "text" in presentation ? presentation.text : visibleTitleText(initialPrompt));
          this.retitleShell(thread.threadId, firstSentence(visiblePrompt));
        }
        if (initialPrompt || attachments.length > 0) {
          const preparedThreadId = prepared?.tauThreadId ?? prepared?.sessionId;
          const deliveryPrepared = preparedThreadId && preparedThreadId !== thread.threadId
            ? await thread.backend.preparePrompt(initialPrompt ?? "", prepared?.skill
              ? { source: "skill", name: prepared.skill.name, visibleText: prepared.visibleText, command: prepared.skill.command }
              : undefined)
            : prepared;
          void this.prompt(initialPrompt ?? "", attachments, thread.threadId, clientMessageId, deliveryPrepared)
            .catch((error) => this.fail(error, thread.threadId));
        }
      } catch (error) {
        // A pure validation failure leaves an untouched spare available. Once
        // adoption or activation has started, discard the candidate on failure
        // (except a prompt rejection after promotion: the visible blank thread
        // remains active and the scoped renderer draft remains untouched).
        if (lifecycle === "prepared") {
          if (isPiBackend(thread)) this.retainPreparedThread(thread);
          else await this.disposeThread(thread);
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        } else if (lifecycle !== "promoted") {
          if (this.threads.has(thread.threadId)) await this.threads.release(thread.threadId);
          else await this.disposeThread(thread);
          this.scheduleSpareThread(targetCwd, true);
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        }
        thread.cancelEventBarrier();
        const active = await this.activeUpdates();
        return { ...active, submission: { accepted: false, message: this.errorMessage(error) }, ...(requestId ? { requestId } : {}) };
      }
      this.logReplacement(spare ? "new-spare" : "new", startedAt);
      if (backendKind === "pi") this.scheduleSpareThread(targetCwd);
      const active = await this.activeUpdates();
      return { ...active, submission: { accepted: true }, ...(requestId ? { requestId } : {}) };
    });
  }

  async getPreparedThreadCapability(cwd?: string): Promise<PreparedThreadCapability> {
    return this.runLifecycle(async () => {
      const targetCwd = cwd ?? this.cwd;
      const generation = ++this.preparedThreadCapabilityGeneration;
      if (this.bridge && (!cwd || cwd === this.cwd)) {
        return { cwd: targetCwd, generation, supportsImageInput: false };
      }
      if (!this.spare || this.spare.cwd !== targetCwd) this.scheduleSpareThread(targetCwd, true);
      const spare = this.spare?.cwd === targetCwd ? this.spare : undefined;
      const prepared = spare ? await spare.pending : undefined;
      return {
        cwd: targetCwd,
        generation,
        supportsImageInput: modelSupportsImageInput(prepared?.runtime?.session.model),
      };
    });
  }

  async forkThread(entryId: string, expectedSessionId?: string): Promise<HostActionResult> {
    if (this.bridge) {
      if (expectedSessionId && this.bridgeSnapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      await this.bridge.command({ command: "fork", entryId });
      return this.actionResult([]);
    }
    return this.runLifecycle(async () => {
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      if (!isPiBackend(thread)) throw new Error("Claude Code threads cannot be forked by the Pi session manager.");
      if (thread.backend.isStreaming()) throw new Error("Wait for the active run before forking this thread.");
      const sourceFile = thread.sessionFile;
      if (!sourceFile || !existsSync(sourceFile)) {
        throw new Error("This thread has not been saved yet. Wait for the first assistant response before forking it.");
      }
      const startedAt = performance.now();
      // Pi reports idle as soon as the agent boundary settles, while the
      // checkpoint lifecycle deliberately persists in the background. Flush
      // that per-thread journal before reading the source branch so a fork
      // cannot miss the just-completed checkpoint.
      await thread.checkpointRuntime?.close();
      // The fork is a new session file, so it gets a runtime of its own; the
      // source thread keeps running untouched.
      const sourceManager = SessionManager.open(sourceFile);
      const sourceCheckpoints = turnCheckpointsFromEntries(sourceManager.getBranch(), thread.sessionId);
      const forkedPath = sourceManager.createBranchedSession(entryId);
      if (!forkedPath) throw new Error("Failed to create the forked thread.");
      const forkedManager = SessionManager.open(forkedPath);
      const inheritedCheckpoints = checkpointsForBranch(forkedManager.getBranch(), sourceCheckpoints);
      if (inheritedCheckpoints.length > 0) {
        // Workspace Kit owns the lease across immutable ref cloning and the
        // append-only re-home journal; the host supplies only SessionManager's
        // durable custom-entry seam.
        await this.checkpointMaintenance.rehomeFork({
          cwd: thread.cwd,
          sourceSessionId: thread.sessionId,
          targetSessionId: forkedManager.getSessionId(),
          checkpoints: inheritedCheckpoints,
          appendEntry: (customType, data) => { forkedManager.appendCustomEntry(customType, data); },
          committedCheckpoints: () => turnCheckpointsFromEntries(
            forkedManager.getBranch(),
            forkedManager.getSessionId(),
          ),
        });
      }
      const forked = await this.openThread(
        forkedManager,
        { type: "session_start", reason: "fork", previousSessionFile: sourceFile },
      );
      await this.activateThread(forked, true);
      this.logReplacement("fork", startedAt);
      return this.activeUpdates();
    });
  }

  /**
   * Restores a completed local Pi turn through a new active branch. The source
   * session is never truncated: a separately named backup preserves its
   * current branch and workspace snapshot before the target workspace is
   * changed. Fork therefore remains the non-destructive explicit alternative.
   */
  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<HostActionResult> {
    if (this.bridge) {
      throw new Error("Restore is unavailable while Pi owns this thread. Use Fork to keep the current workspace unchanged.");
    }
    return this.runLifecycle(async () => {
      await this.recoverPendingRestoreTransactions(this.cwd);
      const { sourceThread, sourceFile, sourceCheckpoints, checkpoint } = await this.verifiedRestoreCheckpoint(sessionId, checkpointId);

      // Build and open the candidate target before taking the destructive
      // workspace step. It is not adopted until the workspace transaction has
      // succeeded, so a runtime-construction failure leaves the source active.
      const targetSourceManager = SessionManager.open(sourceFile);
      const targetPath = targetSourceManager.createBranchedSession(checkpoint.anchorMessageId);
      if (!targetPath) throw new Error("Failed to create the restored thread.");
      const targetManager = SessionManager.open(targetPath);
      const targetThreadId = targetManager.getSessionId();
      let targetRuntime: ThreadRuntime | undefined;
      let backupPath: string | undefined;
      let backupSessionId: string | undefined;
      let backupTurnId: string | undefined;
      let backupManager: SessionManager | undefined;
      let restoreTransaction: TurnRestoreTransaction | undefined;
      let backupDurable = false;
      let restoreAttempted = false;
      let restoreCommitted = false;
      const startedAt = performance.now();
      let lease: Awaited<ReturnType<WorkspaceCheckpointLeaseManager["acquire"]>> | undefined;
      const cleanupTarget = async (): Promise<void> => {
        if (targetRuntime) {
          if (this.threads.get(targetRuntime.threadId)?.runtime === targetRuntime) {
            await this.threads.release(targetRuntime.threadId).catch(() => undefined);
          } else {
            await this.disposeThread(targetRuntime).catch(() => undefined);
          }
          targetRuntime = undefined;
        }
        await workspaceGit.cleanupTurnCheckpointSessionRefs(sourceThread.cwd, targetThreadId).catch(() => undefined);
        await rm(targetPath, { force: true }).catch(() => undefined);
      };
      const cleanupUncommittedBackup = async (): Promise<void> => {
        if (!backupSessionId || backupDurable) return;
        await workspaceGit.cleanupTurnCheckpointSessionRefs(sourceThread.cwd, backupSessionId).catch(() => undefined);
        if (backupPath) await rm(backupPath, { force: true }).catch(() => undefined);
      };

      try {
        targetRuntime = await this.openThread(
          targetManager,
          { type: "session_start", reason: "resume", previousSessionFile: sourceFile },
          { adopt: false, prepared: true },
        );
        lease = await this.checkpointLeaseManager.acquire(sourceThread.cwd, {
          sessionId: sourceThread.sessionId,
          turnId: `restore-${randomUUID()}`,
        });

        // Create the backup from the source branch's current leaf. This is the
        // first durable artifact and is complete before any workspace restore.
        const backupSourceManager = SessionManager.open(sourceFile);
        const sourceLeaf = backupSourceManager.getLeafId();
        if (!sourceLeaf) throw new Error("This thread has no current conversation branch to back up.");
        backupPath = backupSourceManager.createBranchedSession(sourceLeaf);
        if (!backupPath) throw new Error("Failed to create the restore backup thread.");
        const durableBackupManager = SessionManager.open(backupPath);
        backupManager = durableBackupManager;
        backupSessionId = durableBackupManager.getSessionId();
        backupTurnId = `restore-backup-${randomUUID()}`;
        await this.checkpointMaintenance.rehomeFork({
          cwd: sourceThread.cwd,
          sourceSessionId: sourceThread.sessionId,
          targetSessionId: backupSessionId,
          checkpoints: sourceCheckpoints,
          lease,
          appendEntry: (customType, data) => { durableBackupManager.appendCustomEntry(customType, data); },
          committedCheckpoints: () => turnCheckpointsFromEntries(durableBackupManager.getBranch(), backupSessionId!),
        });
        const backupBefore = await workspaceGit.createTurnWorkspaceSnapshot(
          sourceThread.cwd,
          backupSessionId,
          backupTurnId,
          "before",
        );
        const backupAfter = await workspaceGit.createTurnWorkspaceSnapshot(
          sourceThread.cwd,
          backupSessionId,
          backupTurnId,
          "after",
        );
        if (backupBefore.complete === false || backupAfter.complete === false) {
          throw new Error("The current workspace is only partially captured, so Tau cannot create a recoverable restore backup.");
        }
        await backupManager.appendSessionInfo(`Backup before restore to turn ${checkpoint.turnId.slice(0, 12)}`);
        backupManager.appendCustomEntry(TURN_RESTORE_BACKUP_CUSTOM_TYPE, {
          version: 1,
          backupId: randomUUID(),
          sessionId: backupSessionId,
          turnId: backupTurnId,
          sourceSessionId: sourceThread.sessionId,
          sourceCheckpointId: checkpoint.id,
          cwd: sourceThread.cwd,
          beforeSnapshotId: backupBefore.id,
          afterSnapshotId: backupAfter.id,
          createdAt: Date.now(),
        });
        backupDurable = true;

        const targetCheckpoints = checkpointsForBranch(targetManager.getBranch(), sourceCheckpoints);
        await this.checkpointMaintenance.rehomeFork({
          cwd: sourceThread.cwd,
          sourceSessionId: sourceThread.sessionId,
          targetSessionId: targetThreadId,
          checkpoints: targetCheckpoints,
          lease,
          appendEntry: (customType, data) => { targetManager.appendCustomEntry(customType, data); },
          committedCheckpoints: () => turnCheckpointsFromEntries(targetManager.getBranch(), targetThreadId),
        });

        const transactionId = randomUUID();
        restoreTransaction = {
          version: 1,
          kind: "checkpoint-restore",
          transactionId,
          state: "prepared",
          sessionId: backupSessionId,
          backupSessionId,
          backupTurnId,
          sourceSessionId: sourceThread.sessionId,
          sourceTurnId: checkpoint.turnId,
          sourceCheckpointId: checkpoint.id,
          targetSessionId: targetThreadId,
          cwd: sourceThread.cwd,
          targetAfterSnapshotId: checkpoint.afterSnapshotId,
          backupAfterSnapshotId: backupAfter.id,
          createdAt: Date.now(),
        };
        // This append is the durable intent point. A crash after it can be
        // repaired on startup by replaying the complete backup pair.
        backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);

        restoreAttempted = true;
        await workspaceGit.restoreWorkspaceSnapshot(
          sourceThread.cwd,
          checkpoint.afterSnapshotId,
          {
            target: { sessionId: sourceThread.sessionId, turnId: checkpoint.turnId },
            rollback: { sessionId: backupSessionId, turnId: backupTurnId },
            onPhase: (phase) => {
              if (!restoreTransaction || !backupManager) return;
              const state = phase === "apply-started"
                ? "applying"
                : phase === "cleaned"
                  ? "cleaned"
                  : phase === "applied"
                    ? "workspace-applied"
                    : "rolling-back";
              restoreTransaction = { ...restoreTransaction, state };
              backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);
            },
          },
        );
        this.gitCoordinator.invalidate(sourceThread.cwd);
        restoreTransaction = { ...restoreTransaction, state: "workspace-applied" };
        backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);

        await this.adoptThread(targetRuntime);
        await this.activateThread(targetRuntime, true);
        // Keep the successfully restored branch as the most recent durable
        // session. Restore backups remain indexed and discoverable, but a
        // restart must resume the restored checkpoint rather than reopening
        // the backup solely because its transaction journal was written last.
        targetManager.appendSessionInfo(`Restored to turn ${checkpoint.turnId.slice(0, 12)}`);
        restoreTransaction = { ...restoreTransaction, state: "committed" };
        backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);
        restoreCommitted = true;
        await prioritizeRestoreTargetSession(targetPath, backupPath).catch((error) => {
          // The content commit is already durable. A failed timestamp update
          // must not roll it back; index recovery can still discover both
          // sessions and the target remains the active runtime in this host.
          this.log("restore.target-mtime.failed", this.errorMessage(error));
        });
        targetRuntime.releaseEventBarrier((event, runtime, eventSessionId, eventCwd, error) => {
          if (error) this.fail(error, eventSessionId);
          else this.handleSessionEvent(event, runtime, eventSessionId, eventCwd);
        }, (event) => this.emit(event), (title) => this.onWindowTitle?.(title));
        this.logReplacement("restore", startedAt);
        targetRuntime = undefined;
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        let recovered = false;
        if (!restoreCommitted && restoreAttempted && backupSessionId && backupTurnId) {
          try {
            await workspaceGit.restoreWorkspaceSnapshot(
              sourceThread.cwd,
              turnSnapshotRef(backupSessionId, backupTurnId, "after"),
              {
                target: { sessionId: backupSessionId, turnId: backupTurnId },
                rollback: { sessionId: sourceThread.sessionId, turnId: checkpoint.turnId },
              },
            );
            this.gitCoordinator.invalidate(sourceThread.cwd);
            recovered = true;
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        if (targetRuntime && this.threads.active?.runtime === targetRuntime) {
          this.threads.setActive(sourceThread.threadId);
          this.cwd = sourceThread.cwd;
          this.extensionCount = sourceThread.backend.extensionCount();
        }
        await cleanupTarget();
        if (recovered && restoreTransaction && backupManager) {
          try {
            backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, {
              ...restoreTransaction,
              state: "recovered",
            });
          } catch (journalError) {
            recoveryErrors.push(journalError);
          }
        }
        await cleanupUncommittedBackup();
        const message = this.errorMessage(error);
        if (recoveryErrors.length > 0) {
          throw new AggregateError([error, ...recoveryErrors], `Restore failed and workspace rollback needs attention: ${message}`);
        }
        throw new Error(`Restore failed; the original thread and workspace were kept unchanged. ${message}`);
      } finally {
        await lease?.release();
      }

      // The backup must remain indexed as its own thread after the successful
      // transaction. Refreshing after releasing the writer lease prevents a
      // nested acquisition in the startup/pruning sweep.
      const index = await this.refreshThreadIndex(false).catch(() => this.threadIndexSnapshot());
      const active = await this.snapshot();
      return this.actionResult([
        { version: HOST_PROTOCOL_VERSION, type: "thread-index", index },
        ...this.lifecycleUpdates(active),
      ]);
    });
  }

  async exportThreadMarkdown(expectedSessionId?: string): Promise<string> {
    if (this.bridge) {
      if (expectedSessionId && this.bridgeSnapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be copied.");
      }
      const result = await this.bridge.command({ command: "export_markdown" }) as {
        title?: unknown;
        cwd?: unknown;
        sessionId?: unknown;
        messages?: unknown;
      };
      if (!Array.isArray(result.messages)) throw new Error("Pi did not return a normalized chat transcript.");
      const messages = result.messages as Array<{ role?: string; content?: unknown }>;
      const explicitTitle = typeof result.title === "string"
        ? safeSessionTitle(result.title)
        : safeSessionTitle(this.bridgeSnapshot?.sessionName);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return formatChatTranscript({
        title: explicitTitle || firstSentence(visibleTitleText(textFromContent(firstUserMessage?.content))),
        cwd: typeof result.cwd === "string" ? result.cwd : this.bridgeSnapshot?.cwd ?? this.cwd,
        threadId: typeof result.sessionId === "string" ? result.sessionId : this.bridgeSnapshot?.sessionId ?? "",
        // The Pi bridge owns normalization against its live command registry.
        // Re-parsing here could reinterpret a legitimate visible `$skill ...`
        // instruction after the wrapper has already been removed.
        messages,
      });
    }
    const thread = this.requireThread(expectedSessionId);
    if (!isPiBackend(thread)) {
      const visibleMessages = await thread.backend.transcript();
      return formatChatTranscript({
        title: safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
        cwd: thread.cwd,
        threadId: thread.threadId,
        messages: visibleMessages.map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] })),
      });
    }
    // The backend owns transcript normalization. Export consumes its visible
    // projection so runtime wrappers, provider syntax, and injected bodies do
    // not leak into copied chat history.
    const visibleMessages = await thread.backend.transcript();
    const messages = visibleMessages.map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
    }));
    return formatChatTranscript({
      title: safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(textFromContent(messages.find((message) => message.role === "user")?.content))),
      cwd: thread.cwd,
      threadId: thread.threadId,
      messages,
    });
  }

  private async sendThroughRuntimeAdapter(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    thread.adapterPending ??= 0;
    thread.adapterAbortGeneration ??= 0;
    const generation = thread.adapterAbortGeneration;
    const wasPending = thread.adapterPending > 0;
    thread.adapterPending += 1;
    thread.adapterStreaming = true;
    if (!wasPending) this.emit({ type: "agent-status", sessionId: thread.threadId, running: true });
    const operation = thread.adapterQueue.then(() => {
      if (generation !== thread.adapterAbortGeneration) {
        if (clientMessageId) {
          this.emit({
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
      return this.sendThroughRuntimeAdapterNow(thread, text, attachments, delivery, clientMessageId, prepared);
    });
    const settled = operation.finally(() => {
      thread.adapterPending = Math.max(0, thread.adapterPending - 1);
      if (thread.adapterPending === 0) {
        thread.adapterStreaming = false;
        this.emit({ type: "agent-status", sessionId: thread.threadId, running: false });
      }
    });
    thread.adapterQueue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async sendThroughRuntimeAdapterNow(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const commands = this.composerCommands(thread);
    if (prepared) this.assertPreparedPrompt(thread, text, prepared, commands);
    const abortController = new AbortController();
    thread.adapterAbortControllers ??= new Set<AbortController>();
    thread.adapterAbortControllers.add(abortController);
    try {
      if (attachments.length > 0) throw new Error("Image attachments are not supported by the selected runtime adapter.");
      if (!isPiBackend(thread)) {
        await thread.backend.prompt({ text, delivery, ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared } : {}), signal: abortController.signal });
        thread.adapterMessages = await thread.backend.transcript();
        const backendDetail = await thread.backend.detail();
        thread.adapterTitle = backendDetail.title;
        thread.adapterTitleSource = backendDetail.titleSource;
        await this.refreshThreadShell(thread, true);
        return;
      }
      throw new Error("Pi prompts must use the Pi session backend.");
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (clientMessageId) {
        this.emit({
          type: "user-message-failed",
          sessionId: thread.threadId,
          clientMessageId,
          message: aborted ? "The selected runtime request was aborted." : "The selected runtime rejected the message.",
        });
      }
      if (!aborted) this.fail(error);
      throw error;
    } finally {
      thread.adapterAbortControllers.delete(abortController);
    }
  }

  /**
   * Prepared prompt data is an opaque host result, but IPC callers can still
   * replay or forge it. Bind it to the exact visible input and runtime owner
   * before allowing the backend to execute the runtime spelling.
   */
  private assertPreparedPrompt(
    thread: ThreadRuntime,
    text: string,
    prepared: PreparedPrompt,
    commands: readonly UiComposerCommand[],
  ): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      threadBackendKind(thread),
      thread.threadId,
      thread.backend.providerSessionId,
      thread.runtimeAdapter,
      commands,
    );
  }

  private assertPreparedPromptData(
    text: string,
    prepared: PreparedPrompt,
    backendKind: ThreadBackendKind,
    threadId: string | undefined,
    providerSessionId: string | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
  ): void {
    validatePreparedPrompt(text, prepared, {
      backendKind,
      threadId,
      providerSessionId,
      runtimeCapabilities: adapter.capabilities,
      commands,
    });
  }

  /** Resolves a prompt before the renderer creates its optimistic message. */
  async preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    if (this.bridgeOwns(sessionId)) {
      const result = await this.bridgeCommand({ command: "prepare_prompt", text, ...(skill ? { skill } : {}) });
      if (!result || typeof result !== "object") throw new Error("Pi bridge returned an invalid prepared prompt.");
      const prepared = result as Partial<PiBridgePreparedPrompt>;
      if (typeof prepared.visibleText !== "string" || typeof prepared.runtimeText !== "string" || typeof prepared.sourceFingerprint !== "string") {
        throw new Error("Pi bridge returned an invalid prepared prompt.");
      }
      const preparedResult: PreparedPrompt = {
        tauThreadId: this.bridgeSnapshot?.sessionId,
        providerSessionId: this.bridgeSnapshot?.sessionId,
        sessionId: this.bridgeSnapshot?.sessionId,
        backendKind: "pi",
        runtimeCapabilities: prepared.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
        visibleText: prepared.visibleText,
        runtimeText: prepared.runtimeText,
        ...(prepared.skill ? { skill: prepared.skill } : {}),
        sourceFingerprint: prepared.sourceFingerprint,
      };
      validatePreparedPrompt(text, preparedResult, {
        backendKind: "pi",
        threadId: this.bridgeSnapshot?.sessionId,
        providerSessionId: this.bridgeSnapshot?.sessionId,
        runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
        commands: this.bridgeSnapshot?.composerCommands ?? [],
      });
      return preparedResult;
    }
    const target = sessionId
      ? this.requireThread(sessionId)
      : (this.active && threadBackendKind(this.active) === this.defaultBackendKind ? this.active : undefined);
    if (target?.backend) return target.backend.preparePrompt(text, skill);
    if (target) {
      return this.preparePromptForAdapter(
        text,
        skill,
        target.runtimeAdapter,
        this.composerCommands(target),
        target.sessionId,
        threadBackendKind(target),
      );
    }
    const adapter = this.adapterFor(this.defaultBackendKind);
    const commands = adapter.id === "claude-code"
      ? this.claudeComposerCommands(this.cwd)
      : this.runtimeCommands;
    return this.preparePromptForAdapter(text, skill, adapter, commands, undefined, this.defaultBackendKind);
  }

  private preparePromptForAdapter(
    text: string,
    skill: UiSkillDraft | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
    threadId: string | undefined,
    backendKind: ThreadBackendKind,
  ): PreparedPrompt {
    if (adapter.id === "claude-code") assertClaudePermissionPolicySupported(runtimePermissionPolicy(this.accessLevel));
    const effectiveCommands = commands;
    const prepared = prepareSkillPrompt(text, adapter, effectiveCommands, skill);
    const skillNames = [...knownSkillNames(effectiveCommands)];
    const result: PreparedPrompt = {
      ...(threadId ? { tauThreadId: threadId } : {}),
      ...(threadId && adapter.id === "pi" ? { providerSessionId: threadId } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      backendKind,
      runtimeCapabilities: adapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, skillNames),
    };
    validatePreparedPrompt(text, result, {
      backendKind,
      threadId,
      providerSessionId: threadId && adapter.id === "pi" ? threadId : undefined,
      runtimeCapabilities: adapter.capabilities,
      commands: effectiveCommands,
    });
    return result;
  }

  private piBridgePreparedPrompt(prepared: PreparedPrompt): PiBridgePreparedPrompt {
    if (prepared.backendKind !== "pi") throw new Error("Prepared prompt belongs to another runtime.");
    return {
      visibleText: prepared.visibleText,
      runtimeText: prepared.runtimeText,
      runtimeCapabilities: prepared.runtimeCapabilities,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: prepared.sourceFingerprint,
    };
  }

  private assertBridgePreparedPrompt(text: string, prepared: PreparedPrompt, sessionId?: string): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      "pi",
      sessionId,
      sessionId,
      PI_AGENT_RUNTIME_ADAPTER,
      this.composerCommandsForAdapter(this.bridgeSnapshot?.composerCommands ?? [], PI_AGENT_RUNTIME_ADAPTER),
    );
  }

  async switchSession(path: string): Promise<HostActionResult> {
    // The index carries the lifecycle owner. The virtual Claude path remains
    // a compatibility fallback for older indexes, but a real entry wins so a
    // future backend can use a non-file path without being mistaken for Pi.
    const indexedSession = this.sessions.find((session) => session.path === path);
    const backendKind = indexedSession?.backendKind
      ?? (claudeThreadIdFromPath(path) ? "claude-code" : undefined);
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.bridge ? undefined : this.liveThreadForPath(path);
    if (live) {
      const startedAt = performance.now();
      await this.recoverPendingRestoreTransactions(this.cwd);
      await this.activateThread(live, false);
      this.logReplacement("live-switch", startedAt);
      return this.activeUpdates();
    }
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      if (backendKind !== "claude-code" && this.defaultBackendKind === "pi" && await this.attachAvailableBridge(dirname(path), path)) {
        this.cwd = this.bridgeSnapshot!.cwd;
        await this.rememberProject(this.cwd);
        await this.refreshActiveThreadIndex(false);
        return this.activeUpdates();
      }
      this.detachBridge();
      await this.recoverPendingRestoreTransactions(this.cwd);
      const alreadyLive = this.liveThreadForPath(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", alreadyLive ? "warm-switch" : "cold-switch");
      try {
        const thread = alreadyLive ?? await this.openThreadForPath(path, "resume", false, backendKind);
        await this.activateThread(thread, false);
        this.logReplacement("resume", startedAt);
        return this.activeUpdates();
      } finally {
        this.lifecycleMetrics.end();
      }
    });
  }

  /** Opens a thread's runtime ahead of time so switching to it is immediate. */
  async prewarmSession(path: string): Promise<void> {
    if (this.bridge || this.safeMode || this.liveThreadForPath(path)) return;
    const backendKind = this.sessions.find((session) => session.path === path)?.backendKind
      ?? (claudeThreadIdFromPath(path) ? "claude-code" : undefined);
    const startedAt = performance.now();
    try {
      await this.openThreadForPath(path, "resume", true, backendKind);
      this.log("runtime.prewarm.ready", basename(path));
    } catch (error) {
      this.log("runtime.prewarm.failed", this.errorMessage(error));
    } finally {
      this.recordBackgroundLifecycle("prewarm", startedAt);
    }
  }

  async prompt(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrPreflight?: string | PromptPreflight,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const onPreflightResult = typeof clientMessageIdOrPreflight === "function" ? clientMessageIdOrPreflight : undefined;
    const clientMessageId = typeof clientMessageIdOrPreflight === "string" ? clientMessageIdOrPreflight : undefined;
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) {
        const error = new Error("Image attachments are not supported while Tau is attached to Pi.");
        onPreflightResult?.({ accepted: false, error });
        throw error;
      }
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      // Pi's bridge extension is the runtime owner and performs this
      // normalization against its current command registry exactly once.
      try {
        await this.bridge!.command({
          command: "prompt",
          text,
          ...(clientMessageId ? { clientTurnId: clientMessageId, clientMessageId } : {}),
          ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}),
        });
      } catch (error) {
        onPreflightResult?.({ accepted: false, error });
        throw error;
      }
      onPreflightResult?.({ accepted: true });
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    const thread = this.requireThread(sessionId);
    if (!isPiBackend(thread)) {
      await this.sendThroughRuntimeAdapter(thread, text, attachments, "prompt", clientMessageId, prepared);
      onPreflightResult?.({ accepted: true });
      return;
    }
    if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
    // Resolve the runtime spelling once at the backend boundary. The same
    // prepared object is then used for marker correlation and delivery, so a
    // resource-registry change cannot cause host and backend to normalize
    // different dialects for one turn.
    const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
    this.assertPreparedPrompt(thread, text, resolvedPrepared, this.composerCommands(thread));
    const prompt = resolvedPrepared.runtimeText;
    const isExtensionCommand = this.isExtensionCommand(thread, prompt);
    const checkpointRuntime = thread.checkpointRuntime;
    const preparedTurnId = isExtensionCommand ? undefined : randomUUID();
    const wasStreaming = thread.backend.isStreaming();
    if (preparedTurnId) {
      checkpointRuntime?.acceptUserTurn(preparedTurnId, { deferBefore: wasStreaming });
      // Idle prompts prepare before Pi starts. Queued prompts are prepared by
      // the shared `input` adapter at their actual delivery boundary, after
      // earlier tool work has settled.
      if (!wasStreaming) await checkpointRuntime?.prepare(preparedTurnId);
    }
    let markerActive = false;
    let preflightState: PromptPreflightState = "pending";
    let resolvePreflight!: () => void;
    let rejectPreflight!: (error: unknown) => void;
    const preflight = new Promise<void>((resolve, reject) => {
      resolvePreflight = resolve;
      rejectPreflight = reject;
    });
    const failUnpersistedMarker = () => {
      if (!markerActive) return;
      this.failClientMessageIfUnpersisted(thread, clientMessageId);
      markerActive = false;
    };
    const reportPreflight = (result: PromptPreflightResult) => {
      if (preflightState !== "pending") return;
      preflightState = result.accepted ? "accepted" : "rejected";
      onPreflightResult?.(result);
      if (result.accepted) resolvePreflight();
      else {
        failUnpersistedMarker();
        if (preparedTurnId) void checkpointRuntime?.reject(preparedTurnId);
        rejectPreflight(result.error ?? new Error("The prompt was rejected before it started."));
      }
    };
    const images = promptImages(attachments);
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${images.length ? ` · ${images.length} image(s)` : ""}`);
    try {
      markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      const run = thread.backend.prompt({
        text,
        delivery: "prompt",
        ...(clientMessageId ? { clientMessageId } : {}),
        prepared: resolvedPrepared,
        images,
        promptOptions: {
          images,
          streamingBehavior: wasStreaming ? "followUp" : undefined,
          preflightResult: (success) => reportPreflight({ accepted: success }),
        },
      });
      void run.then(async () => {
        if (preflightState === "pending") reportPreflight({ accepted: true });
        if (preparedTurnId && !wasStreaming && !checkpointRuntime?.get(preparedTurnId)?.started) {
          await checkpointRuntime?.reject(preparedTurnId);
        }
        if (this.threads.get(thread.threadId)?.runtime === thread) await this.refreshThreadShell(thread, true);
      }).catch((error) => {
        if (preflightState === "pending") reportPreflight({ accepted: false, error });
        else if (preflightState === "accepted") {
          if (preparedTurnId && !checkpointRuntime?.get(preparedTurnId)?.started) {
            void checkpointRuntime?.reject(preparedTurnId);
          }
          if (!thread.deferError(error)) this.fail(error, thread.threadId);
        }
      });
    } catch (error) {
      if (this.threads.get(thread.threadId)?.runtime !== thread) return;
      if (preparedTurnId) await checkpointRuntime?.reject(preparedTurnId);
      reportPreflight({ accepted: false, error });
    }
    await preflight;
    // Extension commands can be handled without creating a user message or an
    // agent run. Do not leave their marker to label the next turn.
    if ((!wasStreaming || isExtensionCommand) && markerActive && (preflightState as PromptPreflightState) !== "accepted") failUnpersistedMarker();
    this.log("prompt.accepted", `${text.slice(0, 80)}${attachments.length ? ` · ${attachments.length} image(s)` : ""}`);
  }

  async runShellAction(command: string, includeInContext = false, expectedCwd?: string): Promise<ShellActionResult> {
    if (this.bridge) throw new Error("Run project actions in Pi while Tau is attached to its runtime.");
    const shellCommand = command.trim();
    if (!shellCommand) throw new Error("An action command is required.");
    const thread = await this.runLifecycle(async () => {
      if (expectedCwd && this.cwd !== expectedCwd) {
        throw new Error("The selected project did not finish loading. Run the action again.");
      }
      return this.requireActive();
    });
    if (!isPiBackend(thread)) throw new Error("Project actions are unavailable for Claude Code threads; run them through the Claude runtime.");
    if (thread.backend.isBashRunning()) throw new Error("Another project action is already running.");
    const result = await thread.backend.executeBash(shellCommand, includeInContext);
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.refreshThreadShell(thread, true);
    this.log("action.shell", `${result.exitCode ?? "cancelled"} · ${shellCommand}`);
    return {
      output: boundedToolOutput(result.output),
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  }

  async steer(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      await this.bridge!.command({
        command: "prompt",
        text,
        deliverAs: "steer",
        ...(clientMessageId ? { clientTurnId: clientMessageId, clientMessageId } : {}),
        ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}),
      });
      return;
    }
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.requireThread(sessionId);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "steer", clientMessageId, prepared);
        return;
      }
      if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.assertPreparedPrompt(thread, text, resolvedPrepared, this.composerCommands(thread));
      const checkpointRuntime = thread.checkpointRuntime;
      if (!this.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        checkpointRuntime?.acceptUserTurn(preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery: "steer", ...(clientMessageId ? { clientMessageId } : {}), prepared: resolvedPrepared, images: promptImages(attachments) });
      } catch (error) {
        if (markerActive) {
          this.failClientMessageIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        await checkpointRuntime?.reject(preparedTurnId);
        throw error;
      }
    } catch (error) {
      await thread?.checkpointRuntime?.reject(preparedTurnId);
      this.fail(error);
      throw error;
    }
  }

  async followUp(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      await this.bridge!.command({
        command: "prompt",
        text,
        deliverAs: "followUp",
        ...(clientMessageId ? { clientTurnId: clientMessageId, clientMessageId } : {}),
        ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}),
      });
      return;
    }
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.requireThread(sessionId);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "followUp", clientMessageId, prepared);
        return;
      }
      if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.assertPreparedPrompt(thread, text, resolvedPrepared, this.composerCommands(thread));
      const checkpointRuntime = thread.checkpointRuntime;
      if (!this.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        checkpointRuntime?.acceptUserTurn(preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery: "followUp", ...(clientMessageId ? { clientMessageId } : {}), prepared: resolvedPrepared, images: promptImages(attachments) });
      } catch (error) {
        if (markerActive) {
          this.failClientMessageIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        await checkpointRuntime?.reject(preparedTurnId);
        throw error;
      }
    } catch (error) {
      this.fail(error, sessionId);
      await thread?.checkpointRuntime?.reject(preparedTurnId);
      throw error;
    }
  }

  async abort(sessionId?: string): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      this.cancelPendingBridgeNewSession(sessionId);
      await this.bridge!.command({ command: "abort" });
      return;
    }
    const thread = this.threadFor(sessionId);
    if (!thread) return;
    await this.abortThread(thread);
  }

  private cancelPendingBridgeNewSession(sessionId?: string): void {
    const currentSessionId = this.bridgeSnapshot?.sessionId;
    for (const [requestId, pending] of this.pendingBridgeNewSessions) {
      if (sessionId && currentSessionId !== sessionId) continue;
      this.pendingBridgeNewSessions.delete(requestId);
      pending.reject(new Error("The new-thread request was aborted."));
      const bridge = this.bridge;
      if (bridge) this.abortBridgeNewSession(bridge, requestId, pending);
      break;
    }
  }

  /**
   * Stops one thread's run. Its open questions and approvals are settled first:
   * Pi's abort waits for the run to go idle, and a tool blocked on an unanswered
   * question would otherwise hold that wait open indefinitely.
   */
  private async abortThread(thread: ThreadRuntime): Promise<void> {
    this.settleApprovalsFor(thread.threadId, { allowed: false, reason: "Blocked by Tau: the run was stopped." });
    this.cancelUiPromptsFor(thread.threadId);
    if (!isPiBackend(thread)) {
      thread.adapterAbortGeneration ??= 0;
      thread.adapterAbortGeneration += 1;
      for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
      await thread.backend.abort();
      return;
    }
    await thread.backend.abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "set_model", provider, id });
      await this.refreshBridgeSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    await thread.backend.setModel(provider, id);
    this.log("model.changed", `${provider}/${id}`);
    return this.catalogResult();
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "set_thinking", level });
      await this.refreshBridgeSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    await thread.backend.setThinkingLevel(level);
    this.log("thinking.changed", level);
    return this.catalogResult();
  }

  private async catalogResult(): Promise<HostActionResult> {
    const snapshot = await this.snapshot();
    const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: catalogFromSnapshot(snapshot) };
    this.emitUpdate(catalog);
    return this.actionResult([catalog]);
  }

  async renameThread(rawTitle: string, expectedSessionId?: string): Promise<HostActionResult> {
    const title = rawTitle.trim();
    if (!title) throw new Error("Thread titles cannot be empty.");
    if (title.length > 120) throw new Error("Thread titles must be 120 characters or fewer.");
    let sessionId: string;
    let displayedTitle = title;
    if (this.bridge) {
      sessionId = this.bridgeSnapshot?.sessionId ?? "";
      if (expectedSessionId && sessionId !== expectedSessionId) {
        throw new Error("The selected thread did not finish loading. Try renaming it again.");
      }
      await this.bridge.command({ command: "set_session_name", name: title });
      await this.refreshBridgeSnapshot();
    } else {
      const thread = this.requireThread(expectedSessionId);
      sessionId = thread.threadId;
      await thread.backend.setTitle(title, "renamed");
      const detail = await thread.backend.detail();
      thread.adapterTitle = detail.title;
      thread.adapterTitleSource = detail.titleSource;
      displayedTitle = detail.title ?? title;
    }
    const now = Date.now();
    this.sessions = this.sessions.map((thread) =>
      thread.id === sessionId ? { ...thread, title: displayedTitle, modifiedAt: now } : thread,
    );
    const shell = this.sessions.find((thread) => thread.id === sessionId);
    if (!shell) throw new Error("The active thread is missing from the session index.");
    this.log("title.renamed", displayedTitle);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId, shell },
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async generateThreadTitle(provider: string, modelId: string, force = false, expectedSessionId?: string): Promise<HostActionResult> {
    if (this.bridge) {
      if (!force) return { version: HOST_PROTOCOL_VERSION, updates: [] };
      throw new Error("Generate the thread title in Pi while Tau is attached to its runtime.");
    }
    const thread = this.requireThread(expectedSessionId);
    if (thread.backend.kind !== "pi") throw new Error("Claude Code thread titles are generated by the Claude backend and cannot use Pi's model runtime.");
    if (thread.backend.isStreaming()) {
      if (force) throw new Error("Wait for the active agent run before generating a title.");
      await thread.backend.waitForIdle();
      if (this.threads.get(thread.threadId)?.runtime !== thread) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    }
    if (thread.backend.sessionName() && !force) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    const visibleMessages = await thread.backend.transcript();
    const conversation = buildTitleConversation(
      visibleMessages.map((message) => ({ role: message.role, content: message.text })),
    );
    if (!conversation) throw new Error("The thread has no conversation to title yet.");

    this.log("title.started", `${provider}/${modelId}`);
    const title = cleanThreadTitle(await thread.backend.completeTitle(provider, modelId, conversation));
    if (this.threads.get(thread.threadId)?.runtime !== thread) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    await thread.backend.setTitle(title, "generated");
    thread.adapterTitle = title;
    thread.adapterTitleSource = "generated";
    this.sessions = this.sessions.map((entry) =>
      entry.id === thread.threadId ? { ...entry, title, modifiedAt: Date.now() } : entry,
    );
    this.log("title.generated", title);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId: thread.threadId, shell: this.sessions.find((entry) => entry.id === thread.threadId) },
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  setAccessLevel(level: AccessLevel): { applied: boolean; reason?: string } {
    if (this.bridge) {
      return { applied: false, reason: "Access controls stay with Pi while it owns this runtime." };
    }
    if (level === "ask" && this.active?.backend.kind === "claude-code") {
      return {
        applied: false,
        reason: "Claude Code manual approvals are unsupported in non-interactive --print mode; choose read-only or full access before launching Claude.",
      };
    }
    if (level === this.accessLevel) return { applied: true };
    this.accessLevel = level;
    this.log("access.level", level);
    // Anything already waiting was queued under the previous rules; let it through
    // only if the new level does not require asking.
    if (level === "full") this.settleAllApprovals({ allowed: true });
    if (level === "read-only") {
      this.settleAllApprovals({ allowed: false, reason: "Blocked by Tau: switched to read-only." });
    }
    return { applied: true };
  }

  resolveToolApproval(id: string, allowed: boolean): void {
    this.pendingApprovals.get(id)?.settle({
      allowed,
      reason: allowed ? undefined : "Blocked by Tau: you declined this tool call.",
    });
    this.pendingApprovals.delete(id);
  }

  async setServiceTier(tier: ServiceTier): Promise<HostActionResult> {
    this.serviceTier = tier;
    this.serviceTierReported.clear();
    this.log("service-tier.changed", tier);
    return this.catalogResult();
  }

  /** The active model's API decides whether a priority tier can be asked for at all. */
  private serviceTierAvailable(): boolean {
    const api = this.active?.backend.modelApi();
    return Boolean(api && SERVICE_TIER_APIS.has(api));
  }

  async reloadRuntime(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.bridge) {
        await this.bridge.command({ command: "reload" });
        this.log("runtime.reload.requested", "Pi owner");
        return;
      }
      const thread = this.requireActive();
      if (thread.backend.kind !== "pi") throw new Error("Claude Code runtime resources are managed by the Claude backend and cannot be reloaded as Pi extensions.");
      if (thread.backend.isStreaming()) throw new Error("Wait for the active run before reloading Pi.");
      await thread.backend.reload();
      this.modelCatalogCache.invalidate();
      this.resourceDiscoveryCache.invalidate();
      // Other idle runtimes still hold the old resources; they are cheap to
      // rebuild on demand, so drop them rather than reload each one.
      this.discardSpare();
      for (const record of this.threads.list()) {
        if (record.runtime !== thread && isPiBackend(record.runtime)
          && record.runtime.backend.isIdle()
          && (record.runtime.checkpointRuntime?.pendingCount ?? 0) === 0
          && !this.hasOpenUiPrompts(record.threadId)) {
          await this.threads.release(record.threadId);
        }
      }
      this.extensionCount = thread.backend.extensionCount();
      this.log("runtime.reloaded");
      const snapshot = await this.snapshot();
      for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
      this.scheduleRuntimePrewarm();
      this.scheduleSpareThread(this.cwd);
    });
  }

  async compactContext(): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "compact" }, 120_000);
      await this.refreshBridgeSnapshot();
    } else {
      await this.requireActive().backend.compact();
    }
    this.log("context.compacted");
    const snapshot = await this.snapshot();
    const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async snapshot(): Promise<HostSnapshot> {
    const models = await this.ensureModels();
    return { ...this.snapshotSync(models), branch: this.branchFor(this.cwd) };
  }

  async getFileTree(path?: string): Promise<FileNode[]> {
    const root = path ?? this.cwd;
    await assertWorkspacePath(this.cwd, root);
    return this.readTree(root, 0, { count: 0 });
  }

  async getChanges(): Promise<UiWorkspaceChanges> {
    return this.gitCoordinator.getChanges(this.cwd);
  }

  async getFileDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff> {
    await assertWorkspacePath(this.cwd, path);
    return workspaceGit.getFileDiff(this.cwd, path, options);
  }

  /**
   * Returns the immutable diff captured when a completed turn settled. This
   * deliberately never falls back to the live workspace: an old card must not
   * change when a later turn edits the same file or commits the work.
   */
  async getTurnFileDiff(
    sessionId: string,
    checkpointId: string,
    path: string,
    options?: DiffLoadOptions,
  ): Promise<UiFileDiff> {
    if (this.bridgeOwns(sessionId)) {
      await assertWorkspacePath(this.cwd, path);
      const result = await this.bridgeCommand({
        command: "turn_file_diff",
        checkpointId,
        path,
        ...(options ?? {}),
      });
      if (result && typeof result === "object" && Array.isArray((result as { hunks?: unknown }).hunks)) {
        return result as UiFileDiff;
      }
      return { path, added: 0, removed: 0, hunks: [], note: "Pi did not return this historical diff." };
    }
    const thread = this.requireThread(sessionId);
    await assertWorkspacePath(thread.cwd, path);
    const checkpoint = turnCheckpointsFromEntries(thread.backend.branchEntries(), sessionId)
      .find((entry) => entry.id === checkpointId);
    if (!checkpoint) {
      return { path, added: 0, removed: 0, hunks: [], note: "This turn checkpoint is no longer available." };
    }
    if (!thread.checkpointFeature) {
      return { path, added: 0, removed: 0, hunks: [], note: "Turn checkpoint history is unavailable." };
    }
    return thread.checkpointFeature.historicalDiff(thread.cwd, checkpoint, path, options);
  }

  /** Returns the lazy historical file-list page for one immutable checkpoint. */
  async getTurnFiles(
    sessionId: string,
    checkpointId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UiWorkspaceChangesPage> {
    if (this.bridgeOwns(sessionId)) {
      const result = await this.bridgeCommand({ command: "turn_files_page", checkpointId, cursor, limit });
      if (!result || typeof result !== "object") throw new Error("Pi did not return this historical file page.");
      const page = result as Partial<PiBridgeTurnFilesPage>;
      if (page.sessionId !== sessionId || page.checkpointId !== checkpointId
        || !Array.isArray(page.files) || typeof page.fileCount !== "number" || typeof page.hasMore !== "boolean") {
        throw new Error("Pi returned an invalid historical file page.");
      }
      return page as PiBridgeTurnFilesPage;
    }
    const thread = this.requireThread(sessionId);
    const checkpoint = turnCheckpointsFromEntries(thread.backend.branchEntries(), sessionId)
      .find((entry) => entry.id === checkpointId);
    if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
    if (!thread.checkpointFeature) throw new Error("Turn checkpoint history is unavailable.");
    return thread.checkpointFeature.historicalFiles(thread.cwd, checkpoint, cursor, limit);
  }

  async commit(message: string, push: boolean): Promise<CommitResult> {
    const project = this.cwd;
    try {
      const result = await workspaceGit.commit(project, message, push, async (cwd) => {
        this.gitCoordinator.invalidate(cwd);
        return this.gitCoordinator.getChanges(cwd);
      });
      this.gitCoordinator.invalidate(project);
      this.log("git.commit", result.detail);
      return result;
    } catch (error) {
      this.gitCoordinator.invalidate(project);
      throw error;
    }
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return this.gitCoordinator.getWorkspaceInfo(this.cwd);
  }

  async push(): Promise<PushResult> {
    const project = this.cwd;
    try {
      const result = await workspaceGit.push(project);
      this.gitCoordinator.invalidate(project);
      this.log("git.push", result.detail);
      return result;
    } catch (error) {
      this.gitCoordinator.invalidate(project);
      throw error;
    }
  }

  async createWorktree(branch: string, baseRef?: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const project = this.cwd;
      try {
        const destination = await workspaceGit.createWorktree(
          project,
          branch,
          baseRef,
          (cwd) => this.gitCoordinator.getWorkspaceInfo(cwd),
        );
        this.knownProjectNames.set(destination, await this.loadProjectName(project));
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        this.log("git.worktree.added", destination);
        return this.setWorkspaceNow(destination);
      } catch (error) {
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        throw error;
      }
    });
  }

  async switchRef(ref: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const project = this.cwd;
      try {
        const target = await workspaceGit.resolveRefTarget(project, ref, (cwd) => this.gitCoordinator.getWorkspaceInfo(cwd));
        this.log("git.ref.switch", `${ref} → ${target}`);
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        if (target === this.cwd) return this.activeUpdates();
        return this.setWorkspaceNow(target);
      } catch (error) {
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        throw error;
      }
    });
  }

  async listEditors(): Promise<UiEditor[]> {
    return workspaceGit.listEditors();
  }

  async openInEditor(editorId: string, path?: string): Promise<void> {
    if (path) await assertWorkspacePath(this.cwd, path);
    await workspaceGit.openInEditor(this.cwd, editorId, path);
  }

  async dispose(): Promise<void> {
    return this.runLifecycle(async () => {
      this.toolOutputBatcher.dispose();
      if (this.activeIndexPublish) clearTimeout(this.activeIndexPublish);
      this.activeIndexPublish = undefined;
      if (this.indexRecoveryTimer) clearInterval(this.indexRecoveryTimer);
      this.indexRecoveryTimer = undefined;
      if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
      this.prewarmTimer = undefined;
      this.pendingShellUpdates.clear();
      const teardownErrors: unknown[] = [];
      this.detachBridge();
      try { await this.discardSpare(); } catch (error) { teardownErrors.push(error); }
      const opening = [...this.openingThreads.values()];
      this.openingThreads.clear();
      await Promise.allSettled(opening);
      const results = await Promise.allSettled(this.threads.list().map((record) => this.threads.release(record.threadId)));
      for (const result of results) if (result.status === "rejected") teardownErrors.push(result.reason);
      try {
        await this.projectHistory.flush();
      } catch (error) {
        teardownErrors.push(error);
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, "Pi runtime shutdown failed");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Thread runtime lifecycle
  // ---------------------------------------------------------------------------

  /** Opens a Claude-owned thread without allocating a Pi AgentSession carrier. */
  private async openClaudeThread(
    threadId: string,
    cwd: string,
    options: { background?: boolean; adopt?: boolean; resume?: boolean } = {},
  ): Promise<ThreadRuntime> {
    if (this.safeMode) throw new Error("Claude Code threads are disabled in Tau safe mode; choose the Pi runtime.");
    const adapter = this.adapterFor("claude-code");
    if (adapter.id !== "claude-code") throw new Error("Claude Code is not configured for this host.");
    const store = this.claudeSessionStore();
    if (!store) throw new Error("Claude Code backend has no durable session store.");
    const backend = new ClaudeThreadRuntimeBackend(threadId, cwd, {
      adapter,
      store,
      // Resolve the external runtime's command catalog once at its owner
      // boundary. The host never substitutes a Pi resource loader later.
      commands: this.claudeComposerCommands(cwd),
      projectName: this.projectNameFor(cwd),
      branch: this.knownBranches.get(cwd),
      permissionPolicy: () => runtimePermissionPolicy(this.accessLevel),
      onMessage: (message) => {
        const thread = this.threads.get(threadId)?.runtime;
        if (thread) {
          thread.adapterMessages = [...thread.adapterMessages, message];
          this.emit(message.role === "user"
            ? { type: "user-message", sessionId: threadId, message }
            : { type: "assistant-end", sessionId: threadId, message });
        }
      },
    });
    if (options.resume === false) await backend.create();
    else await backend.resume();
    const thread = new ThreadRuntime(backend);
    thread.adapterMessages = await backend.transcript();
    thread.adapterTitle = (await store.get(threadId))?.title;
    thread.adapterTitleSource = (await store.get(threadId))?.titleSource;
    if (options.adopt !== false) await this.adoptThread(thread);
    return thread;
  }

  /**
   * Builds a runtime for one session, binds Tau's UI to it, and hands it to the
   * registry. The thread is live afterwards but not yet on screen.
   */
  private async openThread(
    manager: SessionManager,
    sessionStartEvent: RuntimeStartEvent | undefined,
    options: { background?: boolean; adopt?: boolean; prepared?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<ThreadRuntime> {
    const cwd = manager.getCwd() || this.cwd;
    // A previous process may have died after publishing a snapshot ref but
    // before appending its custom entry. Clean that incomplete phase before a
    // runtime can start another turn in the same session.
    if (manager.getSessionFile()) {
      await this.checkpointMaintenance.cleanupOrphanRefs(
        cwd,
        manager.getSessionId(),
        turnCheckpointsFromEntries(manager.getBranch(), manager.getSessionId()),
        turnRestoreBackupsFromEntries(manager.getBranch(), manager.getSessionId()),
      );
    }
    if (options.background) this.backgroundManagers.add(manager);
    let runtime: AgentSessionRuntime | undefined;
    let thread: ThreadRuntime | undefined;
    let backend: PiThreadRuntimeBackend | undefined;
    try {
      const createdRuntime = await createAgentSessionRuntime(this.createRuntime, {
        cwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        sessionStartEvent,
      });
      runtime = createdRuntime;
      backend = new PiThreadRuntimeBackend(createdRuntime, this.adapterFor("pi"), {
        mapMessages: (messages) => messages
          .map((message, index) => mapMessage(message, index, this.messageMappingOptions(thread!)))
          .filter((message): message is UiMessage => Boolean(message?.text || message?.skill)),
        index: async (owner) => {
          const existing = this.sessions.find((entry) => entry.id === owner.threadId);
          if (existing) return existing;
          const messages = await owner.transcript();
          return {
            id: owner.threadId,
            path: owner.sessionFile() ?? owner.threadId,
            title: cleanThreadTitle(safeSessionTitle(owner.sessionName()) || firstSentence(visibleTitleText(messages[0]?.text ?? ""))),
            modifiedAt: Date.now(),
            projectPath: owner.cwd,
            projectName: this.projectNameFor(owner.cwd),
            branch: this.branchFor(owner.cwd),
            messageCount: messages.length,
            backendKind: "pi",
          };
        },
      });
      thread = new ThreadRuntime(backend, createdRuntime, this.checkpointFeatures.get(manager));
      const preparedThread = thread;
      if (options.prepared ?? options.adopt === false) thread.beginEventBarrier();
      const cancelPrepared = () => {
        this.cancelUiPromptsFor(preparedThread.threadId);
        void preparedThread.backend.abort().catch((error) => this.log("runtime.prepared.abort", this.errorMessage(error)));
      };
      if (options.abortSignal) {
        options.abortSignal.addEventListener("abort", cancelPrepared, { once: true });
        if (options.abortSignal.aborted) cancelPrepared();
      }
      if (sessionStartEvent?.reason === "resume") await backend!.resume();
      else await backend!.create();
      await this.bindThread(thread);
      if (options.abortSignal?.aborted) throw new Error("Prepared runtime creation was cancelled.");
      this.installThreadHooks(thread);
      if (options.adopt !== false) await this.adoptThread(thread);
      return thread;
    } catch (error) {
      // A prepared runtime may have created extension questions while binding.
      // Keep its barrier active until every callback and teardown side effect
      // has completed, then discard all buffered output.
      if (thread) this.cancelUiPromptsFor(thread.sessionId);
      if (runtime) {
        const cleanupErrors = await this.teardownRuntime(runtime);
        thread?.cancelEventBarrier();
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Pi runtime initialization failed");
      } else thread?.cancelEventBarrier();
      throw error;
    } finally {
      this.backgroundManagers.delete(manager);
    }
  }

  private async adoptThread(thread: ThreadRuntime): Promise<void> {
    await this.threads.adopt({ threadId: thread.threadId, cwd: thread.cwd, runtime: thread, isolation: "in-process" });
  }

  /** One runtime per session file: concurrent opens for the same path share it. */
  private openThreadForPath(
    path: string,
    reason: "resume",
    background = false,
    backendKind?: ThreadBackendKind,
  ): Promise<ThreadRuntime> {
    const live = this.liveThreadForPath(path);
    if (live) return Promise.resolve(live);
    let pending = this.openingThreads.get(path);
    if (!pending) {
      pending = (async () => {
        const storedThreadId = claudeThreadIdFromPath(path);
        const indexedSession = this.sessions.find((session) => session.path === path);
        const owner = backendKind ?? indexedSession?.backendKind ?? (storedThreadId ? "claude-code" : "pi");
        if (owner === "claude-code") {
          if (this.safeMode) throw new Error("Claude Code threads are disabled in Tau safe mode; choose the Pi runtime.");
          const threadId = storedThreadId ?? indexedSession?.id;
          if (!threadId) throw new Error("The Claude Code thread has no durable Tau thread id.");
          const record = await this.claudeSessionStore()?.get(threadId);
          if (!record) throw new Error("The selected Claude Code session is no longer available.");
          return this.openClaudeThread(record.tauThreadId, record.cwd, { background });
        }
        if (storedThreadId) throw new Error("The selected Claude Code thread is owned by another runtime backend.");
        let manager: SessionManager;
        manager = SessionManager.open(path);
        return this.openThread(
          manager,
          { type: "session_start", reason, previousSessionFile: this.active?.sessionFile },
          { background },
        );
      })().then((thread) => thread).finally(() => {
        if (this.openingThreads.get(path) === pending) this.openingThreads.delete(path);
      });
      this.openingThreads.set(path, pending);
    }
    return pending;
  }

  private async bindThread(thread: ThreadRuntime): Promise<void> {
    if (!isPiBackend(thread)) return;
    const bindStartedAt = performance.now();
    await thread.backend.bind({
      uiContext: createExtensionUiContext({
        sessionId: () => thread.threadId,
        ask: (prompt) => this.askExtensionUi(prompt, thread),
        notify: (message, level) => this.emitForThread(thread, { type: "notice", message, level, sessionId: thread.threadId }),
        setWindowTitle: (title) => {
          if (!thread.deferTitle(title)) this.onWindowTitle?.(title);
        },
        unsupported: (method) => this.logForThread(thread, "extension-ui.unsupported", method),
      }),
      mode: "rpc",
      onError: (error) => this.fail(error, thread.threadId, thread),
    }, (event) => this.handleSessionEvent(event, thread, thread.threadId, thread.cwd));
    this.recoverOrphanedClientMessageMarkers(thread);
    this.logRuntimePhase("bind", bindStartedAt, "active", thread.cwd, undefined, thread);
  }

  /**
   * A persisted request marker can outlive a host process that crashed or was
   * disconnected before Pi emitted the corresponding user message. Cancel
   * those markers before subscribing to a reopened runtime so they cannot be
   * assigned to a later, unrelated turn.
   */
  private recoverOrphanedClientMessageMarkers(thread: ThreadRuntime): void {
    const staleIds = unclaimedClientMessageIds(thread.backend.branchEntries(), knownSkillNames(this.composerCommands(thread)));
    for (const clientMessageId of staleIds) {
      thread.backend.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
      this.forgetClientMessageId(thread, clientMessageId);
    }
  }

  private installThreadHooks(thread: ThreadRuntime): void {
    if (!isPiBackend(thread)) return;
    thread.backend.setLifecycleHooks(() => {
      thread.backend.unbind();
      thread.resetLiveState();
    }, async () => {
      await this.bindThread(thread);
      if (this.active === thread) await this.publishActiveCatalog();
    });
  }

  /**
   * A restore backup is a real recovery thread, not only a retention marker.
   * Opening it replays its verified workspace pair while retaining a temporary
   * rollback pair for the workspace that is currently on disk.
   */
  private async restoreBackupWorkspaceOnOpen(thread: ThreadRuntime): Promise<RestoreActivationTransaction | undefined> {
    // Recovery is workspace-scoped, not backend-scoped. A normal project
    // session can be the first thread opened after switching projects and
    // still needs to repair a pending clean/read-tree transaction in its cwd.
    await this.recoverPendingRestoreTransactions(thread.cwd);
    if (!isPiBackend(thread)) return undefined;
    const backup = turnRestoreBackupsFromEntries(thread.backend.branchEntries(), thread.sessionId).at(-1);
    if (!backup) return undefined;
    if (backup.cwd !== thread.cwd) throw new Error("This restore backup belongs to another workspace.");
    if (!thread.backend.isIdle() || thread.adapterStreaming || thread.adapterPending > 0) {
      throw new Error("Wait for the backup thread to become idle before restoring its workspace.");
    }
    const active = this.active;
    if (active && active !== thread && (active.backend.isStreaming() || active.adapterStreaming || active.adapterPending > 0)) {
      throw new Error("Wait for the active turn to finish before opening the restore backup.");
    }
    await workspaceGit.validateRestorableWorkspaceSnapshotRefs(
      thread.cwd,
      backup.beforeSnapshotId,
      backup.afterSnapshotId,
      { sessionId: backup.sessionId, turnId: backup.turnId },
    );
    const rollbackTurnId = `open-backup-${randomUUID()}`;
    const lease = await this.checkpointLeaseManager.acquire(thread.cwd, {
      sessionId: thread.sessionId,
      turnId: rollbackTurnId,
    });
    let rollbackBefore: workspaceGit.WorkspaceSnapshot | undefined;
    let rollbackAfter: workspaceGit.WorkspaceSnapshot | undefined;
    let handedOff = false;
    let transaction: TurnRestoreTransaction | undefined;
    const cleanupRollback = async (): Promise<void> => {
      if (!rollbackBefore && !rollbackAfter) return;
      await workspaceGit.cleanupTurnCheckpointRefs(thread.cwd, [{ sessionId: thread.sessionId, turnId: rollbackTurnId }]);
    };
    const appendTransaction = (state: TurnRestoreTransaction["state"]): void => {
      if (!transaction) return;
      transaction = { ...transaction, state };
      thread.backend.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, transaction);
    };
    try {
      rollbackBefore = await workspaceGit.createTurnWorkspaceSnapshot(
        thread.cwd,
        thread.sessionId,
        rollbackTurnId,
        "before",
      );
      rollbackAfter = await workspaceGit.createTurnWorkspaceSnapshot(
        thread.cwd,
        thread.sessionId,
        rollbackTurnId,
        "after",
      );
      transaction = {
        version: 1,
        kind: "backup-open",
        transactionId: randomUUID(),
        state: "prepared",
        sessionId: thread.sessionId,
        backupSessionId: thread.sessionId,
        backupTurnId: rollbackTurnId,
        sourceSessionId: backup.sessionId,
        sourceTurnId: backup.turnId,
        sourceCheckpointId: backup.backupId,
        targetSessionId: thread.sessionId,
        ...(this.active && this.active.threadId !== thread.threadId ? { previousSessionId: this.active.threadId } : {}),
        cwd: thread.cwd,
        targetAfterSnapshotId: backup.afterSnapshotId,
        backupAfterSnapshotId: rollbackAfter.id,
        createdAt: Date.now(),
      };
      appendTransaction("prepared");
      await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, backup.afterSnapshotId, {
        target: { sessionId: backup.sessionId, turnId: backup.turnId },
        rollback: { sessionId: thread.sessionId, turnId: rollbackTurnId },
        onPhase: (phase) => {
          const state = phase === "apply-started"
            ? "applying"
            : phase === "cleaned"
              ? "cleaned"
              : phase === "applied"
                ? "workspace-applied"
                : "rolling-back";
          appendTransaction(state);
        },
      });
      this.gitCoordinator.invalidate(thread.cwd);
      appendTransaction("workspace-applied");
      handedOff = true;
      let finished = false;
      const commit = async (): Promise<void> => {
        if (finished) return;
        appendTransaction("committed");
        finished = true;
        await cleanupRollback().catch(() => undefined);
        await lease.release();
      };
      const rollback = async (): Promise<void> => {
        if (finished) return;
        try {
          await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, rollbackAfter!.id, {
            target: { sessionId: thread.sessionId, turnId: rollbackTurnId },
            rollback: { sessionId: backup.sessionId, turnId: backup.turnId },
          });
          this.gitCoordinator.invalidate(thread.cwd);
          appendTransaction("recovered");
          finished = true;
          await cleanupRollback().catch(() => undefined);
        } finally {
          await lease.release();
        }
      };
      return { commit, rollback };
    } catch (error) {
      let recovered = false;
      const recoveryErrors: unknown[] = [];
      if (transaction && rollbackAfter) {
        try {
          await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, rollbackAfter.id, {
            target: { sessionId: thread.sessionId, turnId: rollbackTurnId },
            rollback: { sessionId: backup.sessionId, turnId: backup.turnId },
          });
          this.gitCoordinator.invalidate(thread.cwd);
          appendTransaction("recovered");
          recovered = true;
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recovered) await cleanupRollback().catch((error) => recoveryErrors.push(error));
      const message = `The restore backup could not be applied safely; the selected thread was not opened. ${this.errorMessage(error)}`;
      if (recoveryErrors.length > 0) {
        throw new AggregateError([error, ...recoveryErrors], `${message} Workspace recovery needs attention.`);
      }
      throw new Error(message);
    } finally {
      // The lease remains held while activateThread publishes the selected
      // thread. Pending transactions retain their temporary rollback pair
      // until the next startup can recover it.
      if (!handedOff) await lease.release();
    }
  }

  /** Puts a live thread on screen. Cheap: it changes pointers and publishes state. */
  private async activateThread(thread: ThreadRuntime, touch: boolean): Promise<void> {
    const restore = await this.restoreBackupWorkspaceOnOpen(thread);
    try {
      if (!this.threads.has(thread.threadId)) await this.adoptThread(thread);
      this.threads.setActive(thread.threadId);
      this.cwd = thread.cwd;
      this.extensionCount = thread.backend.extensionCount();
      await this.rememberProject(this.cwd);
      await this.refreshThreadShell(thread, touch);
      this.log("session.opened", thread.threadId.slice(0, 8));
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: thread.cwd } });
      this.scheduleRuntimePrewarm();
      if (this.defaultBackendKind === "pi") this.scheduleSpareThread(thread.cwd);
      await restore?.commit();
    } catch (error) {
      if (restore) {
        try {
          await restore.rollback();
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Thread activation failed and workspace recovery needs attention.");
        }
      }
      throw error;
    }
  }

  private async publishActiveCatalog(): Promise<void> {
    const snapshot = await this.snapshot();
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
  }

  private async disposeThread(thread: ThreadRuntime): Promise<void> {
    this.settleApprovalsFor(thread.threadId, { allowed: false, reason: "Blocked by Tau: the thread was closed." });
    this.cancelUiPromptsFor(thread.threadId);
    thread.adapterAbortGeneration ??= 0;
    thread.adapterAbortGeneration += 1;
    thread.unsubscribe?.();
    thread.unsubscribe = undefined;
    try {
      for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
      if (thread.backend.isStreaming() || !thread.backend.isIdle()) {
        await Promise.race([
          thread.backend.abort(),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
        ]);
      }
    } catch (error) {
      this.log("runtime.adapter.abort-failed", this.errorMessage(error));
    }
    thread.backend.unbind();
    for (const id of thread.tools.keys()) this.toolOwners.delete(id);
    // Stop Pi before closing the checkpoint lifecycle: closing first would
    // discard a running capture and release its workspace lease while the
    // provider could still mutate the checkout during the abort window.
    const errors = thread.runtime ? await this.abortRuntime(thread.runtime) : [];
    try {
      await thread.checkpointRuntime?.close();
    } catch (error) {
      errors.push(error);
    }
    if (thread.runtime) errors.push(...await this.disposeRuntime(thread.runtime));
    else {
      try { await thread.backend.dispose(); } catch (error) { errors.push(error); }
    }
    thread.cancelEventBarrier();
    if (errors.length > 0) throw new AggregateError(errors, "Pi runtime shutdown failed");
  }

  private async teardownRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors = await this.abortRuntime(runtime);
    errors.push(...await this.disposeRuntime(runtime));
    return errors;
  }

  private async abortRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      // A run that will not stop must not block shutdown forever.
      await Promise.race([
        runtime.session.abort(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
      ]);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async disposeRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors: unknown[] = [];
    let disposed = false;
    try {
      await runtime.dispose();
      disposed = true;
    } catch (error) {
      errors.push(error);
    }
    if (!disposed) {
      try {
        runtime.session.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private scheduleSpareThread(cwd: string, force = false): void {
    if ((!this.automaticPrewarm && !force) || this.safeMode || this.spare?.cwd === cwd) return;
    void this.discardSpare().catch((error) => this.fail(error));
    const startedAt = performance.now();
    const cancellation = new AbortController();
    const pending = this.openThread(
      SessionManager.create(cwd),
      { type: "session_start", reason: "new", previousSessionFile: undefined },
      { background: true, adopt: false, prepared: true, abortSignal: cancellation.signal },
    ).then((thread) => {
      this.log("runtime.spare.ready", basename(cwd));
      return thread;
    }).catch((error) => {
      this.log("runtime.spare.failed", this.errorMessage(error));
      return undefined;
    }).finally(() => this.recordBackgroundLifecycle("spare", startedAt));
    this.spare = { cwd, pending, cancel: () => cancellation.abort() };
  }

  private async takePreparedThread(cwd: string): Promise<ThreadRuntime | undefined> {
    const spare = this.spare;
    if (!spare || spare.cwd !== cwd) return undefined;
    this.spare = undefined;
    const thread = await spare.pending;
    if (!thread) return undefined;
    return thread;
  }

  private retainPreparedThread(thread: ThreadRuntime): void {
    this.spare = { cwd: thread.cwd, pending: Promise.resolve(thread), cancel: () => {
      this.cancelUiPromptsFor(thread.sessionId);
      void thread.backend.abort().catch((error) => this.log("runtime.prepared.abort", this.errorMessage(error)));
    } };
  }

  private async discardSpare(): Promise<void> {
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) return;
    spare.cancel();
    const thread = await spare.pending;
    if (thread) await this.disposeThread(thread);
  }

  private projectNameFor(cwd: string): string {
    return this.knownProjectNames.get(cwd) ?? (basename(cwd) || cwd);
  }

  private async loadProjectName(cwd: string): Promise<string> {
    const known = this.knownProjectNames.get(cwd);
    if (known) return known;
    const name = await workspaceGit.repositoryDisplayName(cwd);
    this.knownProjectNames.set(cwd, name);
    return name;
  }

  private async rememberProject(cwd: string): Promise<void> {
    await this.projectHistory.remember(cwd, await this.loadProjectName(cwd));
  }

  /**
   * The branch a project is on, as last seen. A refresh always runs in the
   * background and publishes when the answer changes, so opening or switching a
   * thread never waits on git — a busy repository used to hold switches for
   * seconds behind its own status scan.
   */
  private branchFor(cwd: string): string | undefined {
    this.refreshBranchInBackground(cwd);
    return this.knownBranches.get(cwd);
  }

  private refreshBranchInBackground(cwd: string): void {
    if (this.branchRefreshes.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.resolveBranch(cwd).then((branch) => {
      const known = this.knownBranches.has(cwd);
      const previous = this.knownBranches.get(cwd);
      this.knownBranches.set(cwd, branch);
      if (!known || previous !== branch) this.publishBranch(cwd, branch);
    }).catch((error) => this.log("branch.failed", `${basename(cwd)}: ${this.errorMessage(error)}`)).finally(() => {
      this.recordBackgroundLifecycle("branch", startedAt);
      this.branchRefreshes.delete(cwd);
    });
    this.branchRefreshes.set(cwd, pending);
  }

  private publishBranch(cwd: string, branch: string | undefined): void {
    if (cwd === this.cwd) {
      this.projectBranch = branch;
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, branch } });
    }
    const changed = this.sessions.filter((session) => session.projectPath === cwd && session.branch !== branch);
    if (changed.length === 0) return;
    this.sessions = this.sessions.map((session) => session.projectPath === cwd ? { ...session, branch } : session);
    for (const session of this.sessions) {
      if (session.projectPath === cwd) this.publishThreadShellSoon(session);
    }
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
  }

  private scheduleRuntimePrewarm(): void {
    if (!this.automaticPrewarm || this.safeMode || this.prewarmTimer) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = undefined;
      if (this.bridge) return;
      const live = this.liveThreadIds();
      const candidates = this.sessions
        .filter((session) => session.projectPath === this.cwd && !live.has(session.id) && !this.openingThreads.has(session.path))
        .slice(0, Math.max(0, MAX_LIVE_THREADS - 2 - live.size));
      for (const session of candidates) void this.prewarmSession(session.path);
    }, 1_000);
    this.prewarmTimer.unref?.();
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Pi session bridge (a Pi TUI owns the visible thread)
  // ---------------------------------------------------------------------------

  private async attachAvailableBridge(
    cwd: string,
    sessionFile?: string,
    options: { ownerPid?: number } = {},
  ): Promise<boolean> {
    if (this.safeMode || this.suppressBridgeAttach) return false;
    const descriptor = await findPiBridge(cwd, sessionFile, options.ownerPid);
    if (!descriptor) return false;
    if (this.bridge?.descriptor.epoch === descriptor.epoch && this.bridge.isConnected) return true;
    const client = new PiBridgeClient(descriptor);
    let bridgeSnapshot: PiBridgeSnapshot;
    try {
      bridgeSnapshot = await client.open();
    } catch (error) {
      client.close();
      this.log("bridge.connect.failed", this.errorMessage(error));
      if (!processIsAlive(descriptor.pid)) return false;
      throw new Error(`Pi owns this session, but Tau could not connect to it: ${this.errorMessage(error)}`);
    }
    if (bridgeSnapshot.runtimeCapabilities
      && bridgeSnapshot.runtimeCapabilities.skillInvocationDialect !== PI_AGENT_RUNTIME_ADAPTER.capabilities.skillInvocationDialect) {
      client.close();
      throw new Error("The attached bridge does not advertise the Pi runtime adapter.");
    }
    for (const clientMessageId of bridgeSnapshot.failedClientMessageIds ?? []) {
      if (typeof clientMessageId === "string" && clientMessageId.length > 0) {
        this.emit({
          type: "user-message-failed",
          sessionId: bridgeSnapshot.sessionId,
          clientMessageId,
          message: "Pi did not add the prompt to the transcript.",
        });
      }
    }
    // Pi is the sole writer of that session while attached; a local runtime for
    // the same file would race it.
    const local = this.liveThreadForPath(descriptor.sessionFile);
    if (local) await this.threads.release(local.threadId);
    this.threads.setActive(undefined);
    this.detachBridge(false);
    this.bridge = client;
    this.bridgeSnapshot = bridgeSnapshot;
    await this.flushBridgeNewSessionAborts(client, bridgeSnapshot);
    this.acceptPendingBridgeSnapshot(bridgeSnapshot, client.descriptor.epoch);
    this.cwd = bridgeSnapshot.cwd;
    const unsubscribeEvents = client.subscribe((frame) => this.handleBridgeFrame(frame));
    const unsubscribeDisconnect = client.subscribeDisconnect(() => {
      if (this.bridge === client) this.reconnectBridge(client);
    });
    this.bridgeUnsubscribe = () => { unsubscribeEvents(); unsubscribeDisconnect(); };
    this.log("bridge.attached", bridgeSnapshot.sessionId.slice(0, 8));
    return true;
  }

  private detachBridge(cancelReconnect = true): void {
    if (cancelReconnect) this.bridgeReconnectLoop.cancel();
    if (!this.bridge) return;
    const bridge = this.bridge;
    const detachedEpoch = bridge.descriptor.epoch;
    if (cancelReconnect) {
      for (const [requestId, pending] of this.pendingBridgeNewSessions) {
        if (pending.bridgeEpoch !== detachedEpoch) continue;
        this.abortBridgeNewSession(bridge, requestId, pending);
        this.pendingBridgeNewSessions.delete(requestId);
        pending.reject(new Error("The Pi bridge was detached before the new thread was reported."));
      }
    }
    // Pi's run state was ours only while attached; leaving it set would keep the
    // thread looking busy forever once Tau is no longer following that session.
    const detachedSessionId = this.bridgeSnapshot?.sessionId;
    if (detachedSessionId) {
      this.emit({ type: "agent-status", sessionId: detachedSessionId, running: false });
    }
    this.syncBridgeAwaitingInput({ ...(this.bridgeSnapshot ?? {}), awaitingInput: undefined } as PiBridgeSnapshot);
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = undefined;
    this.bridge.close();
    this.bridge = undefined;
    this.bridgeSnapshot = undefined;
  }

  private reconnectBridge(disconnected: PiBridgeClient): void {
    const { cwd, sessionFile, pid } = disconnected.descriptor;
    this.emit({ type: "event-log", label: "bridge.reconnecting", detail: "Pi session bridge", timestamp: Date.now() });
    this.bridgeReconnectLoop.start(
      async () => {
        if (await this.attachAvailableBridge(cwd, sessionFile)) return true;
        return this.attachAvailableBridge(cwd, undefined, { ownerPid: pid });
      },
      () => {
        void this.refreshActiveThreadIndex(false).then(async () => {
          const snapshot = await this.snapshot();
          for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
          this.emit({ type: "event-log", label: "bridge.reconnected", detail: "Pi session bridge", timestamp: Date.now() });
        }).catch((error) => this.fail(error));
      },
      (error) => this.log("bridge.reconnect.retry", this.errorMessage(error)),
    );
  }

  private abortBridgeNewSession(
    bridge: PiBridgeClient,
    requestId: NewThreadRequestId,
    pending: { projectPath: string; observed?: { sessionId: string; sessionFile: string; bridgeEpoch: string } },
  ): void {
    const tombstone = this.pendingBridgeNewSessionAborts.get(requestId) ?? { projectPath: pending.projectPath };
    this.pendingBridgeNewSessionAborts.set(requestId, tombstone);
    void this.tryAbortBridgeNewSession(bridge, requestId, pending.observed?.sessionId);
  }

  private async flushBridgeNewSessionAborts(bridge: PiBridgeClient, snapshot: PiBridgeSnapshot): Promise<void> {
    const attempts = [...this.pendingBridgeNewSessionAborts.keys()]
      .filter((requestId) => this.pendingBridgeNewSessionAborts.get(requestId)?.projectPath === snapshot.cwd)
      .map((requestId) => this.tryAbortBridgeNewSession(bridge, requestId, snapshot.sessionId, snapshot.newSessionRequestId));
    await Promise.allSettled(attempts);
  }

  private async tryAbortBridgeNewSession(
    bridge: PiBridgeClient,
    requestId: NewThreadRequestId,
    sessionId?: string,
    snapshotRequestId?: NewThreadRequestId,
  ): Promise<void> {
    const tombstone = this.pendingBridgeNewSessionAborts.get(requestId);
    if (!tombstone || tombstone.attempting || (snapshotRequestId && snapshotRequestId !== requestId)) return;
    tombstone.attempting = true;
    const targetSessionId = sessionId ?? bridge.descriptor.sessionId;
    try {
      const response = await bridge.command({
        command: "new_session_abort",
        requestId,
        sessionId: targetSessionId,
        bridgeEpoch: bridge.descriptor.epoch,
      }, 3_000);
      if (response && typeof response === "object"
        && (response as { accepted?: unknown }).accepted === true
        && (response as { requestId?: unknown }).requestId === requestId
        && (response as { sessionId?: unknown }).sessionId === targetSessionId
        && (response as { bridgeEpoch?: unknown }).bridgeEpoch === bridge.descriptor.epoch) {
        this.pendingBridgeNewSessionAborts.delete(requestId);
      }
    } catch (error) {
      this.log("bridge.new_session.abort_failed", this.errorMessage(error));
    } finally {
      if (this.pendingBridgeNewSessionAborts.get(requestId) === tombstone) tombstone.attempting = false;
    }
  }

  private acceptPendingBridgeSnapshot(snapshot: PiBridgeSnapshot, transportEpoch?: string): NewThreadRequestId | undefined {
    const requestId = snapshot.newSessionRequestId;
    if (!requestId) return undefined;
    const pending = this.pendingBridgeNewSessions.get(requestId);
    if (!pending
      || snapshot.sessionId === pending.previousSessionId
      || snapshot.cwd !== pending.projectPath
      || transportEpoch === undefined
      || transportEpoch !== this.bridge?.descriptor.epoch) return undefined;
    pending.observed = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      bridgeEpoch: transportEpoch,
    };
    pending.resolve(snapshot);
    void this.acknowledgeBridgeNewSession(requestId, transportEpoch);
    return requestId;
  }

  private async acknowledgeBridgeNewSession(requestId: NewThreadRequestId, transportEpoch?: string): Promise<void> {
    const pending = this.pendingBridgeNewSessions.get(requestId);
    const bridge = this.bridge;
    const observed = pending?.observed;
    if (!pending || !observed || !bridge || transportEpoch !== bridge.descriptor.epoch || observed.bridgeEpoch !== transportEpoch) return;
    if (pending.acknowledging) return;
    pending.acknowledging = true;
    try {
      const response = await bridge.command({
        command: "new_session_ack",
        requestId,
        sessionId: observed.sessionId,
        bridgeEpoch: observed.bridgeEpoch,
      }, 3_000);
      if (!response || typeof response !== "object"
        || !("accepted" in response) || response.accepted !== true
        || !("requestId" in response) || response.requestId !== requestId
        || !("sessionId" in response) || response.sessionId !== observed.sessionId
        || !("bridgeEpoch" in response) || response.bridgeEpoch !== observed.bridgeEpoch) {
        pending.acknowledging = false;
        return;
      }
      if (this.pendingBridgeNewSessions.get(requestId) === pending) this.pendingBridgeNewSessions.delete(requestId);
    } catch (error) {
      pending.acknowledging = false;
      this.log("bridge.new_session.ack_failed", this.errorMessage(error));
    }
  }

  private handleBridgeFrame(frame: PiBridgeServerFrame): void {
    if (frame.type === "event") {
      const event = frame.event;
      if (event && typeof event === "object" && (event as { type?: unknown }).type === "new_session_failed") {
        const failed = event as { requestId?: unknown; message?: unknown };
        const requestId = failed.requestId as NewThreadRequestId | undefined;
        const pending = requestId ? this.pendingBridgeNewSessions.get(requestId) : undefined;
        if (requestId && pending && failed.requestId === requestId) {
          this.pendingBridgeNewSessions.delete(requestId);
          pending.reject(new Error(typeof failed.message === "string" ? failed.message : "Pi could not create the new thread."));
          return;
        }
      }
      this.handleBridgeSessionEvent(frame.event, frame.sessionId);
      return;
    }
    if (frame.type !== "snapshot") return;
    this.bridgeSnapshot = frame.snapshot;
    if (this.bridge) void this.flushBridgeNewSessionAborts(this.bridge, frame.snapshot);
    const requestId = this.acceptPendingBridgeSnapshot(frame.snapshot, frame.epoch);
    this.syncBridgeAwaitingInput(frame.snapshot);
    this.cwd = frame.snapshot.cwd;
    void this.snapshot().then((snapshot) => {
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) });
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
    }).catch((error) => this.fail(error));
  }

  /**
   * Pi answers its own extension questions in its terminal, so Tau cannot offer
   * the choices. It can still stop the thread from looking like ordinary work and
   * say where the answer is expected.
   */
  private bridgeAwaitingPromptId?: string;

  private syncBridgeAwaitingInput(snapshot: PiBridgeSnapshot): void {
    const awaiting = snapshot.awaitingInput;
    if (awaiting && !this.bridgeAwaitingPromptId) {
      const id = `bridge-await-${snapshot.sessionId}`;
      this.bridgeAwaitingPromptId = id;
      this.emit({
        type: "extension-ui-prompt",
        sessionId: snapshot.sessionId,
        prompt: {
          id,
          sessionId: snapshot.sessionId,
          kind: awaiting.kind,
          title: awaiting.title ?? "Pi is waiting for an answer",
          message: "This thread runs in Pi, which asks in its own terminal. Answer it there to continue.",
          answerElsewhere: true,
        },
      });
      return;
    }
    if (!awaiting && this.bridgeAwaitingPromptId) {
      this.emit({ type: "extension-ui-resolved", id: this.bridgeAwaitingPromptId, sessionId: snapshot.sessionId });
      this.bridgeAwaitingPromptId = undefined;
    }
  }

  private async refreshBridgeSnapshot(): Promise<void> {
    if (!this.bridge) return;
    this.bridgeSnapshot = await this.bridge.command({ command: "snapshot" }) as PiBridgeSnapshot;
  }

  private bridgeHostSnapshot(): HostSnapshot {
    const snapshot = this.bridgeSnapshot;
    if (!snapshot) throw new Error("Pi bridge snapshot is unavailable.");
    const checkpoints = snapshot.turnCheckpoints ?? [];
    const mapping = this.messageMappingOptions();
    const runtimeAdapter = this.bridgeRuntimeAdapter();
    const composerCommands = this.composerCommandsForAdapter(snapshot.composerCommands ?? [], runtimeAdapter);
    const messages = mapBridgeMessages(snapshot.messages, snapshot.messagesOffset, { ...mapping, checkpoints });
    const firstUserMessage = messages.find((message) => message.role === "user");
    const taskHistory = mergeTaskProgressHistory(
      snapshot.taskHistory,
      taskProgressHistoryFromMessages(snapshot.messages),
    );
    const historyCompleteness = historyCompletenessForBridgeSnapshot(snapshot);
    const olderCursor = !transcriptPagingNegotiated(snapshot.capabilities) || snapshot.olderCursor === undefined
      ? undefined
      : hostCursorAtBridgeValue(snapshot.olderCursor);
    const firstVisibleUser = messages.find((message) => message.role === "user");
    const cursorBoundaries = normalizeTranscriptCursorBoundaries(
      undefined,
      firstVisibleUser?.id,
      olderCursor,
    );
    return {
      cwd: snapshot.cwd,
      threadId: snapshot.sessionId,
      providerSessionId: snapshot.sessionId,
      sessionId: snapshot.sessionId,
      sessionName: safeSessionTitle(snapshot.sessionName),
      sessionTitle: cleanThreadTitle(safeSessionTitle(snapshot.sessionName) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: snapshot.model ? mapModel(snapshot.model) : undefined,
      runtimeCapabilities: snapshot.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
      backendKind: "pi",
      models: snapshot.models.map(mapModel),
      thinkingLevel: snapshot.thinkingLevel,
      thinkingLevels: snapshot.thinkingLevels,
      messages,
      ...(transcriptPagingNegotiated(snapshot.capabilities) ? { transcriptWindow: "bounded" as const } : {}),
      ...(olderCursor ? { olderCursor } : {}),
      ...(firstVisibleUser ? { cursorBeforeMessageId: firstVisibleUser.id } : {}),
      ...(cursorBoundaries ? { cursorBoundaries } : {}),
      historyCompleteness,
      isStreaming: snapshot.isStreaming,
      activeTools: snapshot.activeTools,
      turnActivity: lastTurnActivityFromMessages(snapshot.activityMessages ?? snapshot.messages),
      turnCheckpoints: checkpointsForMessages(checkpoints, messages),
      taskProgress: snapshot.taskProgress ?? taskProgressFromMessages(snapshot.messages),
      taskHistory,
      allTools: snapshot.allTools,
      composerCommands,
      extensionCount: 0,
      serviceTier: "standard",
      serviceTierAvailable: false,
      supportsCheckpointRestore: false,
      supportsImageInput: false,
      contextUsage: snapshot.contextUsage && snapshot.contextUsage.tokens !== null && snapshot.contextUsage.percent !== null
        ? { tokens: snapshot.contextUsage.tokens, contextWindow: snapshot.contextUsage.contextWindow, percent: snapshot.contextUsage.percent }
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Session events. Every live runtime reports through here; the thread it
  // belongs to travels with each event so the renderer can scope it.
  // ---------------------------------------------------------------------------

  /** Bridge events have no local runtime; a detached carrier keeps their live state. */
  private bridgeTurn?: LiveTurnState & { sessionId: string };

  private handleBridgeSessionEvent(event: any, sessionId: string): void {
    if (this.bridgeTurn?.sessionId !== sessionId) this.bridgeTurn = { sessionId, tools: new Map() };
    // The Pi extension is the bridge runtime's checkpoint owner. Replaying its
    // events here is still useful for tools/streaming, but starting a second
    // snapshot capture would duplicate Git work and could race the writer.
    const thread = this.bridgeTurn;
    if (!thread) return;
    if (event && typeof event === "object" && event.type === "turn-checkpoint") {
      const checkpoint = event.checkpoint as UiTurnCheckpoint | undefined;
      const hasLoadedAnchor = Boolean(checkpoint && this.bridgeSnapshot?.messages.some((message) =>
        message && typeof message === "object" && (message as { tauEntryId?: unknown }).tauEntryId === checkpoint.anchorMessageId));
      // A live checkpoint is only rendered when the current bounded bridge page
      // contains its exact assistant entry. The following snapshot still carries
      // the durable record for a page that is not currently loaded.
      if (checkpoint && hasLoadedAnchor) this.emit({ type: "turn-checkpoint", sessionId, checkpoint });
      return;
    }
    if (event && typeof event === "object" && event.type === "turn-checkpoint-error") {
      if (typeof event.message === "string") this.emit({ type: "error", message: event.message });
      return;
    }
    if (event && typeof event === "object" && event.type === "turn-checkpoint-status") {
      if (typeof event.turnId === "string"
        && ["queued", "waiting", "capturing", "persisting", "ready", "failed"].includes(String(event.status))) {
        this.emit({ type: "turn-checkpoint-status", sessionId, turnId: event.turnId, status: event.status as "queued" | "waiting" | "capturing" | "persisting" | "ready" | "failed" });
      }
      return;
    }
    this.handleSessionEvent(event, thread, sessionId, this.cwd);
  }

  private handleSessionEvent(
    event: any,
    thread: LiveTurnState,
    sessionId: string,
    cwd: string,
  ): void {
    if (thread instanceof ThreadRuntime && thread.deferEvent(event, sessionId, cwd)) return;
      switch (event.type) {
        case "user_message_failed":
          if (typeof event.clientMessageId === "string") {
            this.emit({
              type: "user-message-failed",
              sessionId,
              clientMessageId: event.clientMessageId,
              message: typeof event.message === "string" ? event.message : "Pi rejected the message.",
            });
          }
          break;
        case "agent_start":
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId });
          this.emit({ type: "agent-status", sessionId, running: true });
          this.log("agent.started", sessionId.slice(0, 8));
          break;
        case "agent_end":
          this.log("agent.ended", `${event.messages.length} messages`);
          break;
        case "agent_settled":
          // Pi can report a settled inner turn while a follow-up is already
          // queued. Only an actually idle session proves that no pending
          // marker still belongs to a subsequent queued user message.
        if (isThreadRuntime(thread) && thread.backend.isIdle()
          && (thread.pendingClientMessageIds.length > 0 || thread.inFlightClientMessageIds.size > 0)) {
            for (const clientMessageId of this.trackedClientMessageIds(thread)) {
              this.failClientMessageIfUnpersisted(thread, clientMessageId, sessionId);
            }
            // Every tracked id was either persisted or canceled above.
            thread.pendingClientMessageIds.length = 0;
            thread.inFlightClientMessageIds.clear();
          }
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId });
          this.emit({ type: "agent-status", sessionId, running: false });
          this.log("agent.settled", sessionId.slice(0, 8));
          break;
        case "message_start":
          if (event.message.role === "user" && isThreadRuntime(thread)) {
            this.correlateUserMessageStart(thread, event.message);
          }
          if (event.message.role === "assistant") {
            thread.currentAssistantId = `assistant-live-${event.message.timestamp}`;
            thread.liveAssistant = { id: thread.currentAssistantId, text: "", thinking: "", timestamp: event.message.timestamp };
            this.emit({
              type: "assistant-start",
              sessionId,
              id: thread.currentAssistantId,
              timestamp: event.message.timestamp,
            });
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (!thread.currentAssistantId) break;
          if (update.type === "text_delta") {
            if (thread.liveAssistant) thread.liveAssistant.text += update.delta;
            this.emit({ type: "assistant-delta", sessionId, id: thread.currentAssistantId, delta: update.delta });
          } else if (update.type === "thinking_delta") {
            if (thread.liveAssistant) thread.liveAssistant.thinking += update.delta;
            this.emit({ type: "assistant-thinking", sessionId, id: thread.currentAssistantId, delta: update.delta });
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            const message = mapMessage(event.message, 0, this.messageMappingOptions(thread));
            if (message) {
              message.id = thread.currentAssistantId ?? message.id;
              this.emit({ type: "assistant-end", sessionId, message });
              // Pi emits `message_end` before SessionManager appends the entry.
              // Resolve the durable id in the next microtask so a checkpoint
              // can be attached to the live row instead of creating a duplicate
              // synthetic assistant at the transcript tail.
              if (thread instanceof ThreadRuntime) {
                const liveMessageId = message.id;
                queueMicrotask(() => {
                  const branch = thread!.backend.branchEntries();
                  const sourceEntryId = assistantAnchorForBranch(branch, event.message);
                  if (sourceEntryId) this.emit({
                    type: "assistant-anchor",
                    sessionId,
                    id: liveMessageId,
                    sourceEntryId,
                    timestamp: message.timestamp,
                    beforeMessageId: nextVisibleMessageId(branch, sourceEntryId, this.turnCheckpoints(thread!)),
                  });
                });
              }
            }
            thread.currentAssistantId = undefined;
            thread.liveAssistant = undefined;
          } else if (event.message.role === "user") {
            const decorated = isThreadRuntime(thread) ? this.decorateUserEvent(thread, event.message) : event.message;
            const message = mapMessage(decorated, 0, this.messageMappingOptions(thread));
            if (message) this.emit({ type: "user-message", sessionId, message });
          }
          break;
        case "tool_execution_start": {
          const tool: UiToolRun = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args as Record<string, unknown>,
            status: "running",
            startedAt: Date.now(),
          };
          thread.tools.set(tool.id, tool);
          this.toolOwners.set(tool.id, sessionId);
          this.emit({ type: "tool-start", sessionId, tool });
          this.log("tool.started", event.toolName);
          break;
        }
        case "tool_execution_update": {
          const output = boundedToolOutput(resultText(event.partialResult));
          const previous = thread.tools.get(event.toolCallId);
          if (previous) thread.tools.set(event.toolCallId, { ...previous, output });
          this.toolOutputBatcher.push(event.toolCallId, output);
          break;
        }
        case "tool_execution_end": {
          // Never let a delayed batch arrive after the terminal event.
          this.toolOutputBatcher.flushId(event.toolCallId);
          const previous = thread.tools.get(event.toolCallId);
          const tool: UiToolRun = {
            id: event.toolCallId,
            name: event.toolName,
            args: (previous?.args ?? {}) as Record<string, unknown>,
            status: event.isError ? "error" : "done",
            output: boundedToolOutput(resultText(event.result)),
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: Date.now(),
          };
          this.invalidateGitAfterTool(tool, cwd);
          this.emit({ type: "tool-end", sessionId, tool });
          // Settled output belongs to the renderer/artifact store, not the host's
          // active-run map. Do not retain every completed tool forever.
          thread.tools.delete(tool.id);
          this.toolOwners.delete(tool.id);
          this.log("tool.ended", `${event.toolName}:${tool.status}`);
          break;
        }
        case "queue_update":
          this.emit({ type: "queue", sessionId, steering: [...event.steering], followUp: [...event.followUp] });
          break;
      }
  }

  private async ensureModels(): Promise<UiModel[]> {
    if (this.bridgeSnapshot) return this.bridgeSnapshot.models.map(mapModel);
    if (this.active && this.active.backend.kind !== "pi") return [];
    const key = this.resourceFingerprint(this.cwd);
    const cached = this.modelCatalogCache.get(key);
    if (cached) return cached;
    const active = this.active;
    if (!active) return [];
    const models = (await active.backend.catalog()).models;
    this.modelCatalogCache.set(key, models);
    return models;
  }

  private resourceFingerprint(cwd: string, settingsManager?: SettingsManager): string {
    return runtimeResourceFingerprint({
      cwd,
      settings: settingsManager
        ? { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings(), safeMode: this.safeMode, accessLevel: this.accessLevel }
        : { safeMode: this.safeMode, accessLevel: this.accessLevel },
      extensions: { enabled: !this.safeMode, accessGate: true },
      providerState: { agentDir: this.agentDir },
    });
  }

  private async externalSessionShells(): Promise<UiSession[]> {
    if (this.safeMode) return [];
    const store = this.claudeSessionStore();
    if (!store) return [];
    const records = await store.list();
    return records.map((record) => {
      const firstUser = record.messages.find((message) => message.role === "user");
      return {
        id: record.tauThreadId,
        path: claudeThreadPath(record.tauThreadId),
        title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
        modifiedAt: record.updatedAt,
        projectPath: record.cwd,
        projectName: this.projectNameFor(record.cwd),
        branch: this.branchFor(record.cwd),
        messageCount: record.messages.length,
        backendKind: "claude-code",
      };
    });
  }

  private async refreshThreadIndex(publish: boolean): Promise<ThreadIndexSnapshot> {
    if (!this.threadIndexRefresh) {
      const scanStartedAt = Date.now();
      this.threadIndexRefresh = (async () => {
        const sessionInfos = await SessionManager.listAll();
        const scanned = await mapSessions(
          sessionInfos,
          this.cwd,
          async (cwd) => this.branchFor(cwd),
          (cwd) => this.projectNameFor(cwd),
        );
        const previous = this.sessions;
        const external = await this.externalSessionShells();
        const byId = new Map(scanned.map((session) => [session.id, session] as const));
        for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
        this.sessions = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveThreadIds());
        await this.cleanupCheckpointRefsForPersistedSessions(sessionInfos);
        await this.cleanupDeletedSessionCheckpointRefs(previous, this.sessions);
        return this.threadIndexSnapshot();
      })().finally(() => {
        this.threadIndexRefresh = undefined;
      });
    }
    const threadIndex = await this.threadIndexRefresh;
    if (publish) this.emit({ type: "thread-index", threadIndex });
    return threadIndex;
  }

  private startIndexRecovery(): void {
    if (this.indexRecoveryTimer) return;
    this.indexRecoveryTimer = setInterval(() => {
      void this.recoverThreadIndex().catch((error) => this.fail(error));
    }, 30_000);
    this.indexRecoveryTimer.unref?.();
  }

  private async recoverThreadIndex(): Promise<void> {
    const previous = this.sessions;
    const scanStartedAt = Date.now();
    const sessionInfos = await SessionManager.listAll();
    const scanned = await mapSessions(
      sessionInfos,
      this.cwd,
      async (cwd) => this.branchFor(cwd),
      (cwd) => this.projectNameFor(cwd),
    );
    const external = await this.externalSessionShells();
    const byId = new Map(scanned.map((session) => [session.id, session] as const));
    for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
    const next = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveThreadIds());
    this.sessions = next;
    await this.cleanupCheckpointRefsForPersistedSessions(sessionInfos);
    await this.cleanupDeletedSessionCheckpointRefs(previous, next);
    for (const update of sessionIndexUpdates(previous, next)) this.emitUpdate(update);
  }

  /** Runtime eviction keeps persisted history; only a missing session file is deletion. */
  private async cleanupDeletedSessionCheckpointRefs(previous: readonly UiSession[], next: readonly UiSession[]): Promise<void> {
    const nextIds = new Set(next.map((session) => session.id));
    const liveIds = this.liveThreadIds();
    const deleted = previous.filter((session) => !nextIds.has(session.id) && !liveIds.has(session.id) && !existsSync(session.path));
    await Promise.allSettled(deleted.map(async (session) => {
      await this.checkpointMaintenance.cleanupSessionRefs(session.projectPath, session.id);
    }));
  }

  /**
   * Finish restore transactions left behind by a process crash. The backup
   * thread is the journal owner, so a prepared or workspace-applied marker is
   * sufficient to identify the only safe recovery target without trusting the
   * partially-created target runtime.
   */
  private async recoverPendingRestoreTransactions(workspaceCwd = this.cwd): Promise<void> {
    if (this.bridge) return;
    const sessionInfos = await SessionManager.listAll();
    const byId = new Map(sessionInfos.map((info) => [info.id, info] as const));
    const currentWorkspace = await realpath(workspaceCwd).catch(() => resolve(workspaceCwd));
    for (const info of sessionInfos) {
      let manager: SessionManager;
      try {
        manager = SessionManager.open(info.path);
      } catch {
        continue;
      }
      const transactions = turnRestoreTransactionsFromEntries(manager.getBranch(), info.id)
        .filter((transaction) => transaction.state !== "committed" && transaction.state !== "recovered");
      const committedTransactions = turnRestoreTransactionsFromEntries(manager.getBranch(), info.id)
        .filter((transaction) => transaction.state === "committed" && transaction.kind === "checkpoint-restore");
      for (const transaction of committedTransactions) {
        const targetInfo = byId.get(transaction.targetSessionId);
        if (!targetInfo?.path || targetInfo.path === info.path) continue;
        const transactionWorkspace = await realpath(transaction.cwd).catch(() => resolve(transaction.cwd));
        if (transactionWorkspace !== currentWorkspace) continue;
        const [targetStat, backupStat] = await Promise.all([
          stat(targetInfo.path).catch(() => undefined),
          stat(info.path).catch(() => undefined),
        ]);
        // A crash can occur after the committed marker updates the backup's
        // mtime but before the target-prioritization write. Repair that
        // discoverability gap before continueRecent chooses a session.
        if (targetStat && backupStat && backupStat.mtimeMs >= targetStat.mtimeMs) {
          await prioritizeRestoreTargetSession(targetInfo.path, info.path).catch(() => undefined);
        }
      }
      for (const transaction of transactions) {
        // listAll spans every project. Recovery is deliberately scoped to the
        // checkout this host is opening; mutating an unrelated project's
        // workspace during startup would be a data-loss bug in its own right.
        const transactionWorkspace = await realpath(transaction.cwd).catch(() => resolve(transaction.cwd));
        if (transactionWorkspace !== currentWorkspace) continue;
        await this.recoverRestoreTransaction(transaction, manager, byId);
      }
    }
  }

  private async recoverRestoreTransaction(
    transaction: TurnRestoreTransaction,
    backupManager: SessionManager,
    sessionInfos: ReadonlyMap<string, SessionInfo>,
  ): Promise<void> {
    const [transactionWorkspace, backupWorkspace] = await Promise.all([
      this.checkpointLeaseManager.canonicalKey(transaction.cwd),
      this.checkpointLeaseManager.canonicalKey(backupManager.getCwd()),
    ]);
    if (transactionWorkspace !== backupWorkspace) {
      throw new Error(`Restore recovery refused a workspace mismatch for backup ${transaction.backupSessionId.slice(0, 12)}.`);
    }
    const lease = await this.checkpointLeaseManager.acquire(transaction.cwd, {
      sessionId: transaction.backupSessionId,
      turnId: `restore-recovery-${transaction.transactionId}`,
    });
    try {
      if (transaction.kind === "backup-open") {
        // Opening a backup uses the durable backup pair as the target and a
        // temporary pair in the same backup session as the rollback. If the
        // process died before activation committed, put the pre-open
        // workspace back and leave the backup thread unopened.
        await workspaceGit.restoreWorkspaceSnapshot(transaction.cwd, transaction.backupAfterSnapshotId, {
          target: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
          rollback: { sessionId: transaction.sourceSessionId, turnId: transaction.sourceTurnId },
        });
        this.gitCoordinator.invalidate(transaction.cwd);
        backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, {
          ...transaction,
          state: "recovered",
        });
        const previousPath = transaction.previousSessionId
          ? sessionInfos.get(transaction.previousSessionId)?.path
          : undefined;
        const backupPath = backupManager.getSessionFile();
        if (previousPath && backupPath && previousPath !== backupPath) {
          await prioritizeRestoreTargetSession(previousPath, backupPath).catch(() => undefined);
        } else if (backupPath) {
          await utimes(backupPath, new Date(0), new Date(0)).catch(() => undefined);
        }
        // Recovery is durable before deleting the temporary rollback pair. If
        // cleanup is interrupted, the committed recovery marker makes the
        // harmless orphan eligible for ordinary checkpoint GC.
        await workspaceGit.cleanupTurnCheckpointRefs(transaction.cwd, [{
          sessionId: transaction.backupSessionId,
          turnId: transaction.backupTurnId,
        }]);
        return;
      }
      const backupBefore = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "before");
      const backupAfter = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "after");
      // Replaying the backup pair is idempotent and also repairs a process
      // death in the middle of Git's clean/read-tree sequence. Using the same
      // pair as rollback means an apply failure is retried against the same
      // known-good state rather than falling back to the selected checkpoint.
      await workspaceGit.restoreWorkspaceSnapshot(transaction.cwd, backupAfter, {
        target: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
        rollback: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
      });
      this.gitCoordinator.invalidate(transaction.cwd);

      // Remove the uncommitted target before recording recovery. If the
      // process dies between these operations the next startup simply repeats
      // the idempotent workspace replay and cleanup.
      await workspaceGit.cleanupTurnCheckpointSessionRefs(transaction.cwd, transaction.targetSessionId);
      const targetInfo = sessionInfos.get(transaction.targetSessionId);
      if (targetInfo?.path && targetInfo.path !== backupManager.getSessionFile()) {
        await rm(targetInfo.path, { force: true });
      }
      backupManager.appendCustomEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, {
        ...transaction,
        state: "recovered",
      });
    } catch (error) {
      throw new Error(`Restore recovery failed for backup ${transaction.backupSessionId.slice(0, 12)}; the workspace was not exposed as restored. ${this.errorMessage(error)}`);
    } finally {
      await lease.release();
    }
  }

  /** Shared trust boundary used by both the restore action and its UI offer. */
  private async verifiedRestoreCheckpoint(sessionId: string, checkpointId: string) {
    if (this.bridge) throw new Error("Restore is unavailable while Pi owns this thread.");
    const sourceThread = this.requireActive();
    if (sourceThread.threadId !== sessionId) throw new Error("The selected thread changed before it could be restored.");
    if (!isPiBackend(sourceThread)) throw new Error("Only local Pi threads with workspace checkpoints can be restored.");
    if (sourceThread.backend.isStreaming()
      || !sourceThread.backend.isIdle()
      || sourceThread.adapterStreaming
      || sourceThread.adapterPending > 0
      || (sourceThread.checkpointRuntime?.pendingCount ?? 0) > 0
      || this.hasOpenUiPrompts(sourceThread.threadId)) {
      throw new Error("Wait for the active turn and its checkpoint to finish before restoring it.");
    }
    const sourceFile = sourceThread.sessionFile;
    if (!sourceFile || !existsSync(sourceFile)) throw new Error("This thread has no durable session to restore.");
    const sourceManager = SessionManager.open(sourceFile);
    const sourceBranch = sourceManager.getBranch();
    const sourceCheckpoints = turnCheckpointsFromEntries(sourceBranch, sourceThread.sessionId);
    const checkpoint = sourceCheckpoints.find((entry) => entry.id === checkpointId);
    if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
    if (checkpoint.completeness === "partial") {
      throw new Error("This checkpoint is incomplete and cannot be restored safely. Use Fork instead.");
    }
    const anchor = sourceBranch.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as { id?: unknown; type?: unknown; message?: unknown };
      return item.id === checkpoint.anchorMessageId
        && item.type === "message"
        && Boolean(item.message && typeof item.message === "object"
          && (item.message as { role?: unknown }).role === "assistant");
    });
    if (!anchor || typeof (anchor as { id?: unknown }).id !== "string") {
      throw new Error("This checkpoint has no completed assistant anchor and cannot be restored.");
    }
    await workspaceGit.validateRestorableWorkspaceSnapshotRefs(
      sourceThread.cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      { sessionId: sourceThread.sessionId, turnId: checkpoint.turnId },
    );
    return { sourceThread, sourceFile, sourceBranch, sourceCheckpoints, checkpoint };
  }

  /** Ref verification is deliberately completed before the renderer offers Restore. */
  async canRestoreCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    if (this.bridge) return false;
    return this.runLifecycle(async () => {
      try {
        await this.verifiedRestoreCheckpoint(sessionId, checkpointId);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Preview the exact live-workspace delta that the selected checkpoint would replace. */
  async getRestorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges> {
    if (this.bridge) throw new Error("Restore is unavailable while Pi owns this thread.");
    return this.runLifecycle(async () => {
      const { sourceThread, checkpoint } = await this.verifiedRestoreCheckpoint(sessionId, checkpointId);
      return workspaceGit.previewWorkspaceRestore(
        sourceThread.cwd,
        checkpoint.beforeSnapshotId,
        checkpoint.afterSnapshotId,
        { sessionId: sourceThread.sessionId, turnId: checkpoint.turnId },
        { branch: this.knownBranches.get(sourceThread.cwd) },
      );
    });
  }

  /**
   * Reconciles all persisted session journals against namespaced snapshot refs.
   * The sweep runs under the same checkout lease as capture, so an offline
   * deletion/prune cannot remove a live writer's provisional or committed refs.
   */
  private async cleanupCheckpointRefsForPersistedSessions(sessionInfos: readonly SessionInfo[]): Promise<void> {
    const live: WorkspaceKitLiveCheckpointSession[] = [];
    for (const info of sessionInfos) {
      try {
        const manager = SessionManager.open(info.path);
        live.push({
          sessionId: info.id,
          cwd: info.cwd,
          checkpoints: turnCheckpointsFromEntries(manager.getBranch(), info.id),
          backups: turnRestoreBackupsFromEntries(manager.getBranch(), info.id),
          restoreTransactions: turnRestoreTransactionsFromEntries(manager.getBranch(), info.id),
        });
      } catch {
        // A session can disappear between listAll and open; its refs are
        // intentionally eligible for the same sweep.
      }
    }
    for (const record of this.threads.list()) {
      if (!isPiBackend(record.runtime)) continue;
      const branch = record.runtime.backend.branchEntries();
      if (live.some((session) => session.sessionId === record.threadId)) continue;
      live.push({
        sessionId: record.threadId,
        cwd: record.cwd,
        checkpoints: turnCheckpointsFromEntries(branch, record.threadId),
        backups: turnRestoreBackupsFromEntries(branch, record.threadId),
        restoreTransactions: turnRestoreTransactionsFromEntries(branch, record.threadId),
      });
    }
    const workspaces = new Map<string, string>();
    for (const info of sessionInfos) {
      const cwd = info.cwd || this.cwd;
      try { workspaces.set(await this.checkpointLeaseManager.canonicalKey(cwd), cwd); } catch { /* invalid path */ }
    }
    for (const record of this.threads.list()) {
      try { workspaces.set(await this.checkpointLeaseManager.canonicalKey(record.cwd), record.cwd); } catch { /* invalid path */ }
    }
    // A project can outlive its last session in the persisted project history.
    // Include those roots in the sweep so deleting/pruning the final session is
    // recovered after a host restart, even though no SessionInfo still names it.
    for (const project of this.projectHistory.list()) {
      try { workspaces.set(await this.checkpointLeaseManager.canonicalKey(project.path), project.path); } catch { /* invalid path */ }
    }
    await Promise.allSettled([...workspaces.values()].map(async (cwd) => {
      await this.checkpointMaintenance.cleanupLiveRefs(cwd, live);
    }));
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(touch = true): Promise<void> {
    const thread = this.active;
    if (!thread) return;
    await this.refreshThreadShell(thread, touch);
  }

  private sessionShellPath(thread: ThreadRuntime): string {
    return threadBackendKind(thread) === "claude-code"
      ? claudeThreadPath(thread.threadId)
      : thread.sessionFile ?? thread.threadId;
  }

  private async refreshThreadShell(thread: ThreadRuntime, touch: boolean): Promise<void> {
    const projectPath = thread.cwd;
    const existing = this.sessions.find((entry) => entry.id === thread.threadId);
    const visibleMessages = await thread.backend.transcript();
    const shell = reconcileActiveThreadShell({
      id: thread.threadId,
      path: this.sessionShellPath(thread),
      explicitTitle: safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle),
      derivedTitle: firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
      now: Date.now(),
      projectPath,
      projectName: this.projectNameFor(projectPath),
      branch: this.branchFor(projectPath),
      messageCount: visibleMessages.length,
      backendKind: threadBackendKind(thread),
    }, existing, touch);
    this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
    this.publishThreadShellSoon(shell);
  }

  private retitleShell(sessionId: string, title: string): void {
    const shell = this.sessions.find((entry) => entry.id === sessionId);
    if (!shell || shell.title === title) return;
    const titled = { ...shell, title };
    this.sessions = this.sessions.map((entry) => entry.id === sessionId ? titled : entry);
    this.publishThreadShellSoon(titled);
  }

  private publishThreadShellSoon(shell: UiSession): void {
    this.pendingShellUpdates.set(shell.id, shell);
    if (this.activeIndexPublish !== undefined) return;
    this.activeIndexPublish = setTimeout(() => {
      this.activeIndexPublish = undefined;
      const updates = [...this.pendingShellUpdates.values()];
      this.pendingShellUpdates.clear();
      for (const pending of updates) {
        this.emitUpdate({
          version: HOST_PROTOCOL_VERSION,
          type: "thread-shell",
          update: { sessionId: pending.id, shell: pending },
        });
      }
    }, 0);
    this.activeIndexPublish.unref?.();
  }

  private threadIndexSnapshot(): ThreadIndexSnapshot {
    const projects = this.projectHistory.list();
    const knownPaths = new Set(projects.map((project) => project.path));
    for (const thread of this.sessions) {
      if (knownPaths.has(thread.projectPath) || this.projectHistory.isHidden(thread.projectPath)) continue;
      projects.push({
        path: thread.projectPath,
        name: thread.projectName,
        lastOpenedAt: thread.modifiedAt,
      });
      knownPaths.add(thread.projectPath);
    }
    projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    return { projects, sessions: this.sessions };
  }

  private branchMessagesWithEntryIds(thread: ThreadRuntime): unknown[] {
    const entries = thread.backend.branchEntries();
    const messages = branchMessagesWithClientMessageIds(entries, knownSkillNames(this.composerCommands(thread)));
    let messageIndex = 0;
    return entries.flatMap((entry) => {
      const typed = entry as { type?: unknown; id?: unknown };
      return typed.type === "message"
      ? [{ ...(messages[messageIndex++] as Record<string, unknown>), tauEntryId: typed.id }]
      : [];
    });
  }

  private appendClientMessageMarker(
    thread: ThreadRuntime,
    clientMessageId: string | undefined,
    correlationText?: string,
    preparedFingerprint?: string,
  ): boolean {
    if (!clientMessageId) return false;
    thread.pendingClientMessageFingerprints ??= new Map<string, string>();
    const fingerprint = preparedFingerprint ?? (correlationText === undefined
      ? undefined
      : clientMessageFingerprint(correlationText, knownSkillNames(this.composerCommands(thread))));
    thread.backend.appendCustomEntry(CLIENT_MESSAGE_MARKER, clientMessageMarker(clientMessageId, fingerprint).data);
    thread.pendingClientMessageIds.push(clientMessageId);
    if (fingerprint) thread.pendingClientMessageFingerprints.set(clientMessageId, fingerprint);
    return true;
  }

  private trackedClientMessageIds(thread: ThreadRuntime): string[] {
    return [...new Set([
      ...thread.pendingClientMessageIds,
      ...thread.inFlightClientMessageIds,
    ])];
  }

  /** Only a runtime-persisted id proves that a marker's request was recorded. */
  private persistedClientMessageIds(thread: ThreadRuntime): Set<string> {
    return new Set(branchMessagesWithClientMessageIds(thread.backend.branchEntries(), knownSkillNames(this.composerCommands(thread))).flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const value = message as { role?: unknown; clientMessageId?: unknown };
      return value.role === "user" && typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
        ? [value.clientMessageId]
        : [];
    }));
  }

  private forgetClientMessageId(thread: ThreadRuntime, clientMessageId: string): void {
    for (;;) {
      const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
      if (pending < 0) break;
      thread.pendingClientMessageIds.splice(pending, 1);
    }
    thread.inFlightClientMessageIds.delete(clientMessageId);
    thread.pendingClientMessageFingerprints.delete(clientMessageId);
  }

  private cancelClientMessageMarker(thread: ThreadRuntime, clientMessageId: string | undefined): boolean {
    if (!clientMessageId) return false;
    const wasPending = thread.pendingClientMessageIds.includes(clientMessageId);
    const wasInFlight = thread.inFlightClientMessageIds.has(clientMessageId);
    if (!wasPending && !wasInFlight) return false;
    // Persist the tombstone before mutating the in-memory state. A transient
    // runtime write failure must leave the request claim available for retry;
    // otherwise a later message could be correlated to an orphaned marker.
    thread.backend.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
    this.forgetClientMessageId(thread, clientMessageId);
    return true;
  }

  private failClientMessageIfUnpersisted(thread: ThreadRuntime, clientMessageId: string | undefined, sessionId = thread.threadId): boolean {
    if (!clientMessageId) return false;
    if (this.persistedClientMessageIds(thread).has(clientMessageId)) {
      this.forgetClientMessageId(thread, clientMessageId);
      return false;
    }
    const cancelled = this.cancelClientMessageMarker(thread, clientMessageId);
    if (cancelled) {
      this.emit({
        type: "user-message-failed",
        sessionId,
        clientMessageId,
        message: "Pi did not add the prompt to the transcript.",
      });
    }
    return cancelled;
  }

  private correlateUserMessageStart(thread: ThreadRuntime, message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as { role?: string; clientMessageId?: unknown };
    if (value.role !== "user") return;
    if (typeof value.clientMessageId === "string") {
      const pending = thread.pendingClientMessageIds.indexOf(value.clientMessageId);
      if (pending >= 0) {
        thread.pendingClientMessageIds.splice(pending, 1);
        thread.inFlightClientMessageIds.add(value.clientMessageId);
      }
      return;
    }
    thread.pendingClientMessageFingerprints ??= new Map<string, string>();
    const clientMessageId = matchClientMessageId(
      thread.pendingClientMessageIds,
      thread.pendingClientMessageFingerprints,
      message,
      knownSkillNames(this.composerCommands(thread)),
    );
    if (clientMessageId) {
      const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
      if (pending >= 0) thread.pendingClientMessageIds.splice(pending, 1);
      thread.inFlightClientMessageIds.add(clientMessageId);
      (message as Record<string, unknown>).clientMessageId = clientMessageId;
    }
  }

  private decorateUserEvent(thread: ThreadRuntime, message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const value = message as { role?: string; clientMessageId?: string };
    if (value.role !== "user") return message;
    const directId = typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
      ? value.clientMessageId
      : undefined;
    const fingerprintId = thread.pendingClientMessageFingerprints
      ? matchClientMessageId(thread.pendingClientMessageIds, thread.pendingClientMessageFingerprints, message, knownSkillNames(this.composerCommands(thread)))
      : undefined;
    const clientMessageId = directId
      ?? clientMessageIdForMessage(thread.backend.branchEntries(), message, knownSkillNames(this.composerCommands(thread)));
    const resolvedClientMessageId = clientMessageId ?? fingerprintId;
    if (resolvedClientMessageId) this.forgetClientMessageId(thread, resolvedClientMessageId);
    return directId || !resolvedClientMessageId ? message : { ...value, clientMessageId: resolvedClientMessageId };
  }

  private messageSnapshot(thread: ThreadRuntime): UiMessage[] {
    if (!isPiBackend(thread)) {
      return [...thread.adapterMessages];
    }
    const mapping = this.messageMappingOptions(thread);
    const checkpoints = this.turnCheckpoints(thread);
    const messages = this.branchMessagesWithEntryIds(thread)
      .map((message, index) => mapMessage(message, index, mapping))
      .filter((message): message is UiMessage => Boolean(message
        && (message.text || message.skill || messageHasCheckpointAnchor(message, checkpoints))));
    messages.push(...(thread.adapterMessages ?? []));
    // Text still streaming is not in the session yet; without it a thread opened
    // mid-answer would look silent until the answer finished.
    const live = thread.liveAssistant;
    if (live && live.text) {
      messages.push({ id: live.id, role: "assistant", text: live.text, thinking: live.thinking || undefined, timestamp: live.timestamp });
    }
    return messages;
  }

  /** Persisted turn activity, with the host's live output for tools still running. */
  private turnActivity(thread: ThreadRuntime, branchMessages: unknown[]): UiTurnActivity | undefined {
    const activity = lastTurnActivityFromMessages(branchMessages);
    if (!activity || thread.tools.size === 0) return activity;
    return {
      ...activity,
      tools: activity.tools.map((tool) => tool.status === "running" ? thread.tools.get(tool.id) ?? tool : tool),
    };
  }

  private turnCheckpoints(thread: ThreadRuntime): UiTurnCheckpoint[] {
    return turnCheckpointsFromEntries(thread.backend.branchEntries(), thread.sessionId).map(cloneTurnCheckpoint);
  }

  private composerCommands(thread: ThreadRuntime): UiComposerCommand[] {
    return thread.backend.composerCommands();
  }

  /** Claude gets only skill metadata from the shared skill directories. It
   * never creates a Pi resource loader or imports Pi transcript/context state. */
  private claudeComposerCommands(cwd: string): UiComposerCommand[] {
    if (this.runtimeCommands.length > 0) {
      // Runtime command catalogs can originate from the embedded Pi loader,
      // whose skillCommand may still be `/skill:name`. Re-project every skill
      // through the selected Claude adapter before exposing the catalog.
      return this.composerCommandsForAdapter(this.runtimeCommands, this.adapterFor("claude-code"));
    }
    const result = loadSkills({ cwd, agentDir: this.agentDir, skillPaths: [], includeDefaults: true });
    return result.skills
      .filter((skill) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(skill.name))
      .map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
        skillCommand: skillInvocationCommand(skill.name, this.adapterFor("claude-code")),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private isExtensionCommand(thread: ThreadRuntime, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const commandName = text.slice(1).split(/[ \t\r\n]/u, 1)[0];
    return this.composerCommands(thread).some((command) => command.source === "extension" && command.name === commandName);
  }

  private bridgeRuntimeAdapter(): AgentRuntimeAdapter {
    // The bridge is implemented by Pi itself. Its model provider is unrelated
    // to the Pi command dialect, so the host never derives this from snapshot.model.
    return PI_AGENT_RUNTIME_ADAPTER;
  }

  private composerCommandsForAdapter(
    commands: readonly UiComposerCommand[],
    adapter: AgentRuntimeAdapter,
  ): UiComposerCommand[] {
    return commands.map((command) => {
      if (command.source !== "skill") return { ...command };
      const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
      return { ...command, skillCommand: skillInvocationCommand(name, adapter) };
    });
  }

  private messageMappingOptions(thread?: LiveTurnState): MessageMappingOptions {
    if (isThreadRuntime(thread)) {
      return {
        runtimeAdapter: thread.runtimeAdapter,
        skillCommands: this.composerCommands(thread),
      };
    }
    const runtimeAdapter = this.bridgeRuntimeAdapter();
    return {
      runtimeAdapter,
      skillCommands: this.composerCommandsForAdapter(this.bridgeSnapshot?.composerCommands ?? [], runtimeAdapter),
    };
  }

  private snapshotSync(models: UiModel[]): HostSnapshot {
    if (this.bridgeSnapshot) return { ...this.bridgeHostSnapshot(), models };
    const thread = this.requireActive();
    if (!isPiBackend(thread)) {
      const messages = this.messageSnapshot(thread);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return {
        cwd: thread.cwd,
        threadId: thread.threadId,
        providerSessionId: thread.backend.providerSessionId,
        sessionId: thread.threadId,
        sessionName: safeSessionTitle(thread.adapterTitle),
        sessionTitle: cleanThreadTitle(safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
        runtimeCapabilities: thread.runtimeAdapter.capabilities,
        backendKind: thread.backend.kind,
        models: [],
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        messages,
        isStreaming: thread.adapterStreaming || thread.backend.isStreaming(),
        activeTools: [],
        taskProgress: undefined,
        taskHistory: [],
        allTools: [],
        composerCommands: this.composerCommands(thread),
        extensionCount: 0,
        serviceTier: "standard",
        serviceTierAvailable: false,
        supportsCheckpointRestore: false,
      };
    }
    const branchMessages = this.branchMessagesWithEntryIds(thread);
    const messages = this.messageSnapshot(thread);
    const firstUserMessage = messages.find((message) => message.role === "user");
    const usage = thread.backend.contextUsage();
    return {
      cwd: this.cwd,
      threadId: thread.threadId,
      providerSessionId: thread.backend.providerSessionId,
      sessionId: thread.threadId,
      sessionName: safeSessionTitle(thread.backend.sessionName()),
      sessionTitle: cleanThreadTitle(safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: thread.backend.model(),
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      backendKind: thread.backend.kind,
      models,
      thinkingLevel: thread.backend.thinkingLevel(),
      thinkingLevels: thread.backend.thinkingLevels(),
      messages,
      isStreaming: thread.backend.isStreaming() || thread.adapterStreaming,
      activeTools: thread.backend.activeToolNames(),
      turnActivity: this.turnActivity(thread, branchMessages),
      turnCheckpoints: this.turnCheckpoints(thread),
      taskProgress: taskProgressFromMessages(branchMessages),
      taskHistory: taskProgressHistoryFromMessages(branchMessages),
      allTools: thread.backend.allTools(),
      composerCommands: this.composerCommands(thread),
      extensionCount: this.extensionCount,
      serviceTier: this.serviceTier,
      serviceTierAvailable: this.serviceTierAvailable(),
      supportsCheckpointRestore: true,
      historyCompleteness: "complete",
      supportsImageInput: modelSupportsImageInput(thread.runtime?.session.model),
      contextUsage: usage && usage.tokens !== null && usage.percent !== null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined,
    };
  }

  private requestApproval(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<AccessDecision> {
    const id = `${toolCallId}-${(this.approvalCounter += 1)}`;
    return new Promise<AccessDecision>((resolve) => {
      let settled = false;
      const settle = (decision: AccessDecision) => {
        if (settled) return;
        settled = true;
        this.pendingApprovals.delete(id);
        resolve(decision);
      };
      // No deadline: an unanswered approval is a paused thread, not a refusal.
      // Only that thread waits, and stopping the run settles it.
      this.pendingApprovals.set(id, { sessionId, settle });
      this.emitForThread(this.threadFor(sessionId), {
        type: "tool-approval",
        sessionId,
        request: { id, sessionId, toolName, summary: approvalSummary(toolName, input) },
      });
    });
  }

  private askExtensionUi(prompt: ExtensionUiPrompt, thread?: ThreadRuntime): Promise<ExtensionUiAnswer> {
    // The user already typed the answer for the select before this; the
    // extension is only asking for it now in its own words.
    const typed = prompt.kind === "input" ? this.typedAnswers.get(prompt.sessionId) : undefined;
    if (typed) {
      this.typedAnswers.delete(prompt.sessionId);
      if (typed.expiresAt > Date.now()) {
        this.log("extension-ui.typed", prompt.title.split("\n")[0]);
        return Promise.resolve({ value: typed.text });
      }
    }
    this.attachQuestionnaire(prompt);
    return new Promise<ExtensionUiAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: ExtensionUiAnswer) => {
        if (settled) return;
        settled = true;
        this.pendingUiPrompts.delete(prompt.id);
        this.openUiPrompts.delete(prompt.id);
        if (timer) clearTimeout(timer);
        this.emitForThread(thread, { type: "extension-ui-resolved", id: prompt.id, sessionId: prompt.sessionId });
        resolve(answer);
      };
      // Only the extension's own deadline ends a question. Without one the
      // thread simply waits: a question is a stop until the user answers, and
      // an answer invented by a timer would send the run off in the wrong direction.
      const timer = prompt.expiresAt
        ? setTimeout(() => {
          if (thread) this.logForThread(thread, "extension-ui.timeout", prompt.title);
          else this.log("extension-ui.timeout", prompt.title);
          settle({ cancelled: true });
        }, Math.max(0, prompt.expiresAt - Date.now()))
        : undefined;
      timer?.unref?.();
      this.pendingUiPrompts.set(prompt.id, { sessionId: prompt.sessionId, settle });
      this.openUiPrompts.set(prompt.id, prompt);
      if (thread) this.logForThread(thread, "extension-ui.prompt", `${prompt.kind}: ${prompt.title}`);
      else this.log("extension-ui.prompt", `${prompt.kind}: ${prompt.title}`);
      this.emitForThread(thread, { type: "extension-ui-prompt", prompt, sessionId: prompt.sessionId });
    });
  }

  /** Places a prompt inside the questionnaire it came from, by its question text. */
  private attachQuestionnaire(prompt: ExtensionUiPrompt): void {
    if (prompt.kind !== "select" && prompt.kind !== "input") return;
    const questionnaire = this.questionnaires.get(prompt.sessionId);
    if (!questionnaire) return;
    const { questions } = questionnaire;
    const byTitle = questions.findIndex((q) => prompt.title.startsWith(`${q.header ? `[${q.header}] ` : ""}${q.question}`));
    const index = byTitle >= 0 ? byTitle : Math.min(questionnaire.asked, questions.length - 1);
    questionnaire.asked = index + 1;
    prompt.questionnaire = { index, questions };
  }

  answerExtensionUi(id: string, answer: ExtensionUiAnswer): void {
    const prompt = this.openUiPrompts.get(id);
    // Text typed for a select goes through the extension's own free-text row:
    // pick that row, then hand the text to the input prompt it asks with next.
    // Answering the select with raw text would read as a dismissal instead.
    if (prompt?.kind === "select" && "typed" in answer && answer.typed && "value" in answer) {
      const sentinel = freeTextOption(prompt.options);
      if (sentinel) {
        this.typedAnswers.set(prompt.sessionId, { text: answer.value, expiresAt: Date.now() + TYPED_ANSWER_TTL_MS });
        this.pendingUiPrompts.get(id)?.settle({ value: sentinel });
        return;
      }
    }
    this.pendingUiPrompts.get(id)?.settle(answer);
  }

  /** Re-announces questions raised before the renderer was listening. */
  replayOpenUiPrompts(): void {
    for (const prompt of this.openUiPrompts.values()) {
      this.emit({ type: "extension-ui-prompt", prompt, sessionId: prompt.sessionId });
    }
  }

  private hasOpenUiPrompts(sessionId: string): boolean {
    for (const pending of this.pendingUiPrompts.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  private cancelUiPromptsFor(sessionId: string): void {
    const pending = [...this.pendingUiPrompts.values()].filter((entry) => entry.sessionId === sessionId);
    pending.forEach((entry) => entry.settle({ cancelled: true }));
  }

  private settleApprovalsFor(sessionId: string, decision: AccessDecision): void {
    const pending = [...this.pendingApprovals.values()].filter((entry) => entry.sessionId === sessionId);
    pending.forEach((entry) => entry.settle(decision));
  }

  private settleAllApprovals(decision: AccessDecision): void {
    const pending = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    pending.forEach((entry) => entry.settle(decision));
  }

  private resolveBranch(cwd: string): Promise<string | undefined> {
    return this.gitCoordinator.getBranch(cwd);
  }

  private invalidateGitAfterTool(tool: UiToolRun, cwd: string): void {
    const command = typeof tool.args.command === "string" ? tool.args.command : "";
    const mutatesGit = /\bgit\s+(?:checkout|switch|branch|reset|worktree|commit|merge|rebase|pull|fetch)\b/iu.test(command);
    if (tool.name === "edit" || tool.name === "write" || mutatesGit) {
      this.gitCoordinator.invalidate(cwd, mutatesGit
        ? ["status", "branch", "workspace"]
        : ["status", "workspace"]);
    }
  }

  private async readTree(path: string, depth: number, budget: { count: number }): Promise<FileNode[]> {
    if (depth > 4 || budget.count > 320) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (budget.count++ > 320) break;
      if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = join(path, entry.name);
      const node: FileNode = {
        name: entry.name,
        path: fullPath,
        kind: entry.isDirectory() ? "directory" : "file",
      };
      nodes.push(node);
    }
    return nodes;
  }

  private logRuntimePhase(phase: string, startedAt: number, reason: string, cwd: string, note?: string, thread?: ThreadRuntime): void {
    this.lifecycleMetrics.phase(phase, startedAt);
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    const detail = `${elapsed}ms · ${reason} · ${basename(cwd) || cwd}`;
    const eventDetail = note ? `${detail} · ${note}` : detail;
    if (thread) this.logForThread(thread, `runtime.${phase}.ready`, eventDetail);
    else this.log(`runtime.${phase}.ready`, eventDetail);
  }

  private logReplacement(reason: string, startedAt: number): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    this.log("runtime.replace.ready", `${elapsed}ms · ${reason}`);
  }

  private emitUpdate(update: HostUpdate): void {
    this.emit({ type: "host-update", update });
  }

  private emitForThread(thread: ThreadRuntime | undefined, event: ThreadHostEvent): void {
    if (thread?.deferHostEvent(event)) return;
    this.emit(event);
  }

  private log(label: string, detail?: string): void {
    const event = { type: "event-log" as const, label, detail, timestamp: Date.now() };
    this.emit(event);
  }

  private logForThread(thread: ThreadRuntime, label: string, detail?: string): void {
    this.emitForThread(thread, { type: "event-log", label, detail, timestamp: Date.now(), sessionId: thread.sessionId });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void {
    if (thread?.deferError(error)) return;
    const message = this.errorMessage(error);
    if (sessionId) this.emit({ type: "error", message, sessionId });
    else this.emit({ type: "error", message });
    const owner = thread instanceof ThreadRuntime
      ? thread
      : sessionId ? this.threadFor(sessionId) : undefined;
    if (owner instanceof ThreadRuntime) this.logForThread(owner, "host.error", message);
    else if (sessionId) this.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now(), sessionId });
    else this.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now() });
  }
}

export function workspaceLabel(cwd: string): string {
  return basename(cwd) || cwd;
}
