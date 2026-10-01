import type { UiMessage } from "../../shared/contracts";
import { startsTurn, turnNumberOf } from "../../shared/message-turns";
import { visibleUserMessageText } from "./MessageText";

/** Keep short transcripts quiet; a turn index becomes useful at eight turns. */
export const MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS = 8 as const;

/** The preview is deliberately short enough to scan in a compact turn rail. */
export const TRANSCRIPT_TURN_PREVIEW_LENGTH = 76 as const;

/** Eight pixels keeps short threads airy while dense histories still fit on screen. */
export const TRANSCRIPT_TURN_NAVIGATION_ITEM_SPACING = 8 as const;

/** Avoid adding an unbounded number of decorative lines to very long threads. */
export const MAX_TRANSCRIPT_TURN_NAVIGATION_MARKERS = 120 as const;

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
    if (!startsTurn(message)) continue;
    turnNumber = turnNumberOf(turnNumber, message);
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

export function transcriptTurnNavigationTopPercent(index: number, entryCount: number): number {
  if (entryCount <= 1) return 0;
  return (Math.max(0, Math.min(index, entryCount - 1)) / (entryCount - 1)) * 100;
}

export function transcriptTurnNavigationHeight(entryCount: number): string {
  const naturalHeight = Math.max(1, (entryCount - 1) * TRANSCRIPT_TURN_NAVIGATION_ITEM_SPACING);
  return `min(${naturalHeight}px, calc(100% - 10rem))`;
}

export function transcriptTurnNavigationIndexFromPointer(input: {
  entryCount: number;
  railTop: number;
  railHeight: number;
  pointerY: number;
}): number | null {
  if (input.entryCount <= 0 || !Number.isFinite(input.railHeight) || input.railHeight <= 0) return null;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.entryCount - 1, Math.round(progress * (input.entryCount - 1))));
}

export function transcriptTurnNavigationMarkerIndexes(entryCount: number): number[] {
  if (entryCount <= 0) return [];
  const markerCount = Math.min(entryCount, MAX_TRANSCRIPT_TURN_NAVIGATION_MARKERS);
  if (markerCount === entryCount) return Array.from({ length: entryCount }, (_, index) => index);
  return Array.from({ length: markerCount }, (_, index) => (
    Math.round((index / (markerCount - 1)) * (entryCount - 1))
  ));
}
