import type { UiMessage, UiTaskProgressEntry, UiTurnActivityEntry, UiToolOutputReadResult } from "../shared/contracts.js";
import {
  normalizeTranscriptCursorBoundaries,
  taskHistoryForMessages,
  turnActivityHistoryForMessages,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import type { PiBridgeCommand, PiBridgeToolOutputPage } from "../shared/pi-bridge-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { OLDER_TRANSCRIPT_TURN_LIMIT, TranscriptPager, type TranscriptCursorPolicy } from "../shared/transcript-pager.js";
import { completeToolOutputRead, TOOL_OUTPUT_READ_PAGE_CHARACTERS } from "../shared/tool-output.js";
import { decodeHostCursor, hostCursorAtLocalIndex } from "./transcript-cursor.js";
import { firstSentence, safeSessionTitle, textFromContent, visibleTitleText } from "./host-messages.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export const localTranscriptCursorPolicy: TranscriptCursorPolicy<HostTranscriptCursor> = {
  cursorAtIndex: hostCursorAtLocalIndex,
  indexFromCursor: (cursor, maximum) => {
    const coordinate = decodeHostCursor(cursor);
    if (coordinate.kind !== "local" || coordinate.index > maximum) throw new Error("Invalid transcript cursor");
    return coordinate.index;
  },
};

export function localTranscriptPage(
  sessionId: string,
  messages: readonly UiMessage[],
  taskHistory: readonly UiTaskProgressEntry[] | undefined,
  turnActivityHistory: readonly UiTurnActivityEntry[] | undefined,
  turnActivityHistoryComplete: boolean | undefined,
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
  const visibleActivityHistory = turnActivityHistoryForMessages(turnActivityHistory, page.messages);
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
    ...(visibleActivityHistory ? { turnActivityHistory: visibleActivityHistory } : {}),
    ...(turnActivityHistoryComplete !== undefined ? { turnActivityHistoryComplete } : {}),
  };
}

export function readLocalToolOutput(
  rawMessages: readonly unknown[],
  toolCallId: string,
): UiToolOutputReadResult | undefined {
  const raw = [...rawMessages].reverse().find((message) => {
    if (!message || typeof message !== "object") return false;
    const value = message as { role?: unknown; toolCallId?: unknown };
    return value.role === "toolResult" && value.toolCallId === toolCallId;
  });
  if (!raw || typeof raw !== "object") return undefined;
  return completeToolOutputRead(toolCallId, textFromContent((raw as { content?: unknown }).content));
}

export async function readAttachedToolOutput(
  toolCallId: string,
  send: (command: PiBridgeCommand) => Promise<unknown>,
): Promise<UiToolOutputReadResult | undefined> {
  let offset = 0;
  let totalBytes: number | undefined;
  let output = "";
  for (let pageCount = 0; ; pageCount += 1) {
    if (totalBytes !== undefined && pageCount > Math.ceil(totalBytes / TOOL_OUTPUT_READ_PAGE_CHARACTERS) + 1) {
      throw new Error("Pi returned too many tool output pages for one deliberate read.");
    }
    const raw = await send({ command: "read_tool_output", toolCallId, ...(offset > 0 ? { offset } : {}) });
    if (raw === undefined) return undefined;
    const page = parseToolOutputPage(raw, toolCallId, offset);
    if (totalBytes === undefined) totalBytes = page.totalBytes;
    if (page.totalBytes !== totalBytes) throw new Error("Pi returned inconsistent tool output metadata.");
    output += page.output;
    if (page.nextOffset === undefined) {
      if (new TextEncoder().encode(output).byteLength !== totalBytes) {
        throw new Error("Pi returned an incomplete tool output page.");
      }
      return { toolCallId, output, totalBytes, truncated: false };
    }
    if (page.nextOffset <= offset || page.output.length === 0) {
      throw new Error("Pi returned an invalid tool output cursor.");
    }
    offset = page.nextOffset;
  }
}

function parseToolOutputPage(value: unknown, toolCallId: string, offset: number): PiBridgeToolOutputPage {
  if (!value || typeof value !== "object") throw new Error("Pi returned an invalid tool output page.");
  const page = value as Partial<PiBridgeToolOutputPage>;
  const { output, totalBytes, nextOffset } = page;
  if (page.toolCallId !== toolCallId || page.offset !== offset || typeof output !== "string"
    || typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || (nextOffset !== undefined && (!Number.isSafeInteger(nextOffset) || nextOffset < 0))) {
    throw new Error("Pi returned an invalid tool output page.");
  }
  return { toolCallId, offset, output, totalBytes, ...(nextOffset !== undefined ? { nextOffset } : {}) };
}

/** Exports the full transcript using the runtime's normalized messages when provided. */
export async function exportThreadMarkdown(thread: ThreadRuntime): Promise<string> {
  // A runtime that normalizes its own transcript owns the export: re-parsing
  // here could reinterpret a visible `$skill ...` instruction as a wrapper.
  const exported = await thread.backend.capabilities.markdownExport?.exportTranscript();
  const messages = exported?.messages
    ?? (await thread.backend.transcript()).map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] }));
  const firstUserMessage = messages.find((message) => message.role === "user");
  return formatChatTranscript({
    title: safeSessionTitle(exported?.title) || safeSessionTitle(thread.state.title) || safeSessionTitle(thread.adapterTitle)
      || firstSentence(visibleTitleText(textFromContent(firstUserMessage?.content))),
    cwd: exported?.cwd ?? thread.cwd,
    threadId: exported?.threadId ?? thread.threadId,
    messages,
  });
}
