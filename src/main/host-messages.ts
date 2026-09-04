import { basename } from "node:path";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";
import type {
  ThreadBackendKind,
  UiComposerCommand,
  UiMessage,
  UiMessageImage,
  UiModel,
  UiPromptAttachment,
  UiSession,
  UiToolRun,
  UiTurnActivity,
  UiTurnActivityEntry,
} from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  normalizeTranscriptCursorBoundaries,
  taskHistoryForMessages,
  turnActivityHistoryForMessages,
  type HostUpdate,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import { transcriptPagingNegotiated, type PiBridgeSnapshot, type PiBridgeTranscriptPage } from "../shared/pi-bridge-protocol.js";
import {
  inferUnavailableTranscriptCompleteness,
  isTranscriptHistoryMetadataConsistent,
  parseTranscriptHistoryCompleteness,
  resolveTranscriptHistoryCompleteness,
  type TranscriptHistoryCompleteness,
} from "../shared/transcript-completeness.js";
import { hostCursorAtBridgeValue, providerCursorValue } from "./transcript-cursor.js";
import { skillMessagePresentation } from "./skill-invocation.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import { promptImages } from "./prompt-attachments.js";

/**
 * Pure projections of Pi's raw session data into the workbench contract:
 * messages, tool activity, titles, the session index and bridge pages. Nothing
 * here touches a runtime; the host and the attached-session code both use it.
 */

export function textFromContent(content: unknown): string {
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

export function extensionCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const name = text.slice(1).trim().split(/\s+/u, 1)[0];
  return name || undefined;
}

export function isExtensionCommand(session: AgentSession, text: string): boolean {
  const name = extensionCommandName(text);
  if (!name) return false;
  return session.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has(name));
}

export const MESSAGE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imagesFromContent(content: unknown): UiMessageImage[] {
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

export function thinkingFromContent(content: unknown): string | undefined {
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

export const EMPTY_PINS: ReadonlySet<string> = new Set();

export interface MessageMappingOptions {
  runtimeAdapter?: AgentRuntimeAdapter;
  skillCommands?: readonly UiComposerCommand[];
  /** Entries extensions pinned; a text-empty assistant among them stays visible. */
  pinned?: ReadonlySet<string>;
}


export function mapMessage(message: unknown, index: number, options: MessageMappingOptions = {}): UiMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as {
    role?: string;
    content?: unknown;
    timestamp?: number;
    customType?: string;
    tauEntryId?: string;
    clientTurnId?: string;
    clientMessageId?: string;
    tauClientTurnId?: string;
    tauClientMessageId?: string;
  };

  const clientTurnId = value.clientTurnId ?? value.tauClientTurnId;
  const clientMessageId = value.clientMessageId ?? value.tauClientMessageId;
  const clientIdentity = {
    ...(clientTurnId ? { clientTurnId } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  };

  if (value.role === "user") {
    const text = textFromContent(value.content);
    const images = imagesFromContent(value.content);
    const presentation = options.runtimeAdapter && options.skillCommands
      ? skillMessagePresentation(text, options.runtimeAdapter, options.skillCommands)
      : undefined;
    const visibleText = presentation?.text ?? text;
    return {
      // Live events do not carry a persisted entry id yet. The request id is
      // already stable at message_start, so use it to keep equal-timestamp
      // user turns distinct until the next authoritative snapshot.
      id: value.tauEntryId ?? (clientMessageId ? `user-${clientMessageId}` : `user-${value.timestamp ?? index}-${index}`),
      sourceEntryId: value.tauEntryId,
      ...clientIdentity,
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
      ...clientIdentity,
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
      ...clientIdentity,
      role: "notice",
      text: textFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  return undefined;
}

export function bridgeMessagesOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Pi returned an invalid transcript message offset.");
  }
  return value as number;
}

export function bridgeTranscriptCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return providerCursorValue(value);
  } catch {
    throw new Error("Pi returned an invalid transcript page cursor.");
  }
}

/** Normalize the pre-v6 Pi-only state before it reaches the shared contract. */
export function normalizeBridgeHistoryCompleteness(value: unknown): unknown {
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

/** Text-empty assistant messages are omitted unless an extension pinned their entry. */
export function isVisibleMessage(message: UiMessage | undefined, pinned?: ReadonlySet<string>): message is UiMessage {
  if (!message) return false;
  if (message.text || message.skill) return true;
  return Boolean(pinned && (pinned.has(message.id) || (message.sourceEntryId !== undefined && pinned.has(message.sourceEntryId))));
}

/** Validate and map one bridge-owned raw page without exposing provider coordinates. */
export function mapBridgeMessages(value: unknown, messagesOffsetValue?: unknown, options: MessageMappingOptions = {}): UiMessage[] {
  if (!Array.isArray(value)) throw new Error("Pi returned an invalid transcript message list.");
  const rawMessageOffset = bridgeMessagesOffset(messagesOffsetValue);
  const messages = value.flatMap((raw, index) => {
    // When the bridge gives us a raw offset, use it for fallback IDs too. A
    // bridge record without tauEntryId must still deduplicate across pages.
    const mapped = mapMessage(raw, rawMessageOffset === undefined ? index : rawMessageOffset + index, options);
    return isVisibleMessage(mapped, options.pinned) ? [mapped] : [];
  });
  return messages;
}

export type ValidatedBridgeTranscriptPage = Omit<PiBridgeTranscriptPage, "olderCursor"> & {
  olderCursor?: string;
};

export function bridgeTranscriptPage(value: unknown, expectedSessionId: string): ValidatedBridgeTranscriptPage {
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
  if (page.activityMessages !== undefined && !Array.isArray(page.activityMessages)) {
    throw new Error("Pi returned an invalid transcript activity records list.");
  }
  if (page.turnActivityHistory !== undefined && !Array.isArray(page.turnActivityHistory)) {
    throw new Error("Pi returned an invalid turn activity history.");
  }
  if (page.turnActivityHistoryComplete !== undefined && typeof page.turnActivityHistoryComplete !== "boolean") {
    throw new Error("Pi returned an invalid turn activity completeness flag.");
  }
  const pinnedEntryIds = Array.isArray(page.pinnedEntryIds)
    ? page.pinnedEntryIds.filter((id): id is string => typeof id === "string")
    : undefined;
  return {
    sessionId,
    messages,
    hasMore,
    ...(page.taskHistory !== undefined ? { taskHistory: page.taskHistory } : {}),
    ...(page.activityMessages !== undefined ? { activityMessages: page.activityMessages } : {}),
    ...(page.turnActivityHistory !== undefined ? { turnActivityHistory: page.turnActivityHistory } : {}),
    ...(page.turnActivityHistoryComplete !== undefined ? { turnActivityHistoryComplete: page.turnActivityHistoryComplete } : {}),
    ...(messagesOffset !== undefined ? { messagesOffset } : {}),
    ...(olderCursor !== undefined ? { olderCursor } : {}),
    ...(historyCompleteness !== undefined ? { historyCompleteness } : {}),
    ...(pinnedEntryIds ? { pinnedEntryIds } : {}),
  };
}

/** Validate and map one bridge-owned transcript page at the host seam. */
export function mapBridgeTranscriptPageValue(sessionId: string, value: unknown): TranscriptPage {
  const page = bridgeTranscriptPage(value, sessionId);
  const messages = mapBridgeMessages(page.messages, page.messagesOffset, { pinned: new Set(page.pinnedEntryIds ?? []) });
  const taskHistory = taskHistoryForMessages(page.taskHistory, messages);
  const turnActivityHistory = turnActivityHistoryForMessages(
    page.turnActivityHistory ?? turnActivityHistoryFromMessages(page.activityMessages ?? page.messages),
    messages,
  );
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
    ...(turnActivityHistory ? { turnActivityHistory } : {}),
    ...(page.turnActivityHistoryComplete !== undefined ? { turnActivityHistoryComplete: page.turnActivityHistoryComplete } : {}),
    ...(firstUserMessage ? { cursorBeforeMessageId: firstUserMessage.id } : {}),
    ...(olderCursor !== undefined ? { olderCursor } : {}),
    ...(cursorBoundaries ? { cursorBoundaries } : {}),
    historyCompleteness: resolveTranscriptHistoryCompleteness(page.historyCompleteness, page.hasMore),
    hasMore: page.hasMore,
  };
}

/**
 * Finds the next row that the renderer would expose after an assistant entry.
 * Empty assistant messages are omitted until an extension pins them, so an
 * explicit insertion point keeps a late anchor beside its own turn even when
 * a queued user message has already arrived.
 */
export function nextVisibleMessageId(
  entries: readonly unknown[],
  sourceEntryId: string,
  pinned?: ReadonlySet<string>,
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
    if (isVisibleMessage(message, pinned)) return message.id;
  }
  return undefined;
}

/**
 * Reconstructs every tool group from the raw branch, preserving the user-turn
 * boundary that the renderer needs for chronological placement.  Keeping this
 * derivation host-side means the renderer receives bounded, typed activity
 * rather than the provider's hidden tool-result records.
 */
export function turnActivityHistoryFromMessages(messages: unknown[]): UiTurnActivityEntry[] {
  const history: UiTurnActivityEntry[] = [];
  let active: {
    id: string;
    anchorMessageId?: string;
    tools: UiToolRun[];
    interrupted: boolean;
    error: boolean;
  } | undefined;
  let toolIndexes = new Map<string, number>();
  let lastVisibleMessageId: string | undefined;

  const finish = () => {
    if (!active || active.tools.length === 0) {
      active = undefined;
      toolIndexes = new Map();
      lastVisibleMessageId = undefined;
      return;
    }
    const hasError = active.error || active.tools.some((tool) => tool.status === "error");
    const hasRunning = active.tools.some((tool) => tool.status === "running");
    history.push({
      id: active.id,
      ...(active.anchorMessageId ? { anchorMessageId: active.anchorMessageId } : {}),
      tools: active.tools,
      status: hasError ? "error" : active.interrupted ? "interrupted" : hasRunning ? "running" : "completed",
    });
    active = undefined;
    toolIndexes = new Map();
    lastVisibleMessageId = undefined;
  };

  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      tauEntryId?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      stopReason?: string;
    };
    if (message.role === "user") {
      finish();
      const mapped = mapMessage(message, index);
      const id = mapped?.id ?? `user-${message.timestamp ?? index}-${index}`;
      active = { id: `turn-activity-${id}`, anchorMessageId: mapped?.id ?? id, tools: [], interrupted: false, error: false };
      lastVisibleMessageId = mapped?.id ?? id;
      return;
    }
    if (!active) return;
    const mapped = mapMessage(message, index);
    if (mapped && (mapped.role === "user" || mapped.text.trim())) lastVisibleMessageId = mapped.id;
    if (message.stopReason === "aborted" || message.stopReason === "cancelled") active.interrupted = true;
    if (message.stopReason === "error") active.error = true;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (call.type !== "toolCall" || !call.id || !call.name) continue;
        active.anchorMessageId ??= lastVisibleMessageId;
        toolIndexes.set(call.id, active.tools.length);
        active.tools.push({
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
      if (toolIndex === undefined) return;
      const tool = active.tools[toolIndex];
      const output = textFromContent(message.content);
      const preview = boundedToolOutput(output);
      active.tools[toolIndex] = {
        ...tool,
        name: message.toolName ?? tool.name,
        status: message.isError ? "error" : "done",
        output: preview,
        ...(preview !== output ? { outputTruncated: true, fullOutputAvailable: true } : {}),
        endedAt: message.timestamp ?? tool.startedAt,
      };
    }
  });
  finish();
  return history;
}

export function lastTurnActivityFromMessages(messages: unknown[]): UiTurnActivity | undefined {
  const latest = turnActivityHistoryFromMessages(messages).at(-1);
  return latest ? { tools: latest.tools, ...(latest.anchorMessageId ? { anchorMessageId: latest.anchorMessageId } : {}) } : undefined;
}

export function mapModel(model: { provider: string; id: string; name?: string }): UiModel {
  return { provider: model.provider, id: model.id, name: model.name ?? model.id };
}

export function modelSupportsImageInput(model: { input?: readonly string[] } | undefined): boolean {
  return model?.input?.includes("image") === true;
}

export function assertImageInputCapability(session: AgentSession, attachments: readonly UiPromptAttachment[]): void {
  if (attachments.length > 0 && !modelSupportsImageInput(session.model)) {
    throw new Error("The active model does not support image input.");
  }
}

export function assertBridgeImageInputCapability(snapshot: PiBridgeSnapshot | undefined, attachments: readonly UiPromptAttachment[]): void {
  if (attachments.length === 0) return;
  if (snapshot?.supportsImageInput !== true) throw new Error("The active model does not support image input.");
  promptImages(attachments);
}

export function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "Untitled thread";
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/u);
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trimEnd()}…` : sentence;
}

export function visibleTitleText(value: string): string {
  // A raw skill wrapper has no trustworthy title text. Keep runtime internals
  // out of sidebar/title fallback rather than echoing its tag or local path.
  return /<skill\b/iu.test(value)
    ? "Skill invocation"
    : value;
}

export function safeSessionTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return cleanThreadTitle(visibleTitleText(value)); }
  catch { return undefined; }
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

export async function mapSessions(
  sessions: SessionInfo[],
  fallbackCwd: string,
  resolveLabel: (cwd: string) => Promise<string | undefined>,
  resolveProjectName: (cwd: string) => string = (cwd) => basename(cwd) || cwd,
): Promise<UiSession[]> {
  const recent = [...sessions]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const projectPaths = [...new Set(recent.map((session) => session.cwd || fallbackCwd))];
  const labels = new Map(
    await Promise.all(projectPaths.map(async (path) => [path, await resolveLabel(path)] as const)),
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
      projectLabel: labels.get(projectPath),
      messageCount: session.messageCount,
      backendKind: "pi",
    };
  });
}

export function sessionShellEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id && left.path === right.path && left.title === right.title &&
    left.modifiedAt === right.modifiedAt && left.projectPath === right.projectPath &&
    left.projectName === right.projectName && left.projectLabel === right.projectLabel &&
    left.messageCount === right.messageCount && left.backendKind === right.backendKind &&
    left.modelProvider === right.modelProvider;
}

export function sessionIndexUpdates(previous: readonly UiSession[], next: readonly UiSession[]): HostUpdate[] {
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
  projectLabel?: string;
  messageCount: number;
  backendKind?: ThreadBackendKind;
  modelProvider?: string;
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
    projectLabel: input.projectLabel,
    messageCount: input.messageCount,
    ...(input.backendKind ? { backendKind: input.backendKind } : {}),
    ...(input.modelProvider ?? existing?.modelProvider ? { modelProvider: input.modelProvider ?? existing?.modelProvider } : {}),
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

export function resultText(result: unknown): string {
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
