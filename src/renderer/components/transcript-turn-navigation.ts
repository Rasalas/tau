import type { UiMessage } from "../../shared/contracts";
import { visibleUserMessageText } from "./MessageText";

/** Keep short transcripts quiet; a turn index becomes useful at eight turns. */
export const MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS = 8 as const;

/** The preview is deliberately short enough to scan in a compact turn rail. */
export const TRANSCRIPT_TURN_PREVIEW_LENGTH = 76 as const;

/** Keep the turn rail's interactive DOM bounded even for very long threads. */
export const TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE = 8 as const;

export interface TranscriptTurnNavigationEntry {
  /** The user-message ID used by the virtual transcript as its stable anchor. */
  messageId: string;
  /** Zero-based position in the complete loaded message sequence. */
  messageIndex: number;
  /** One-based position among loaded user turns. */
  turnNumber: number;
  /** Text shown in the navigation row and announced by its button. */
  preview: string;
}

/**
 * Collapse layout whitespace without changing the wording of a prompt. A
 * navigation preview should read like a sentence even when its source prompt
 * contains a multiline list or a pasted paragraph.
 */
export function normalizePromptPreview(text: string): string {
  return visibleUserMessageText(text).replace(/\s+/gu, " ").trim();
}

/**
 * Truncate at a word boundary where possible. Array.from keeps a surrogate
 * pair together, which matters for prompts containing emoji or non-BMP text.
 */
export function truncatePromptPreview(
  text: string,
  maxLength: number = TRANSCRIPT_TURN_PREVIEW_LENGTH,
): string {
  const normalized = normalizePromptPreview(text);
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…".slice(0, maxLength);

  const cutoff = Math.max(1, maxLength - 1);
  const candidate = characters.slice(0, cutoff).join("");
  const boundary = candidate.lastIndexOf(" ");
  // Do not reduce a preview to a tiny fragment when the first word is long.
  const readableCandidate = boundary >= Math.floor(candidate.length * 0.55)
    ? candidate.slice(0, boundary)
    : candidate;
  return `${readableCandidate.trimEnd()}…`;
}

export function buildTranscriptTurnNavigation(
  messages: readonly UiMessage[],
): TranscriptTurnNavigationEntry[] {
  let turnNumber = 0;
  const entries: TranscriptTurnNavigationEntry[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "user") continue;
    turnNumber += 1;
    entries.push({
      messageId: message.id,
      messageIndex,
      turnNumber,
      preview: truncatePromptPreview(message.text),
    });
  }
  return entries;
}

export function shouldShowTranscriptTurnNavigation(
  entries: readonly TranscriptTurnNavigationEntry[],
): boolean {
  return entries.length >= MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS;
}
