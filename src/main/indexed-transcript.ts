import type { UiMessage, UiTaskProgressEntry, UiTurnActivityEntry } from "../shared/contracts.js";
import { normalizeTranscriptCursorBoundaries, type TranscriptPage } from "../shared/host-protocol.js";
import { startsTurn } from "../shared/message-turns.js";
import { OLDER_TRANSCRIPT_TURN_LIMIT } from "../shared/transcript-pager.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { localTranscriptCursorPolicy, localTranscriptPage } from "./host-transcript.js";
import { hostCursorAtLocalIndex } from "./transcript-cursor.js";

/** The persisted reader's turn/history index, shared by live Pi branches.
 * Building is linear; a page visits only its window and binary-searches turns.
 * A live tail is separate so assistant deltas never rebuild the saved branch.
 */
export class IndexedTranscript {
  private readonly users: number[] = [];
  private readonly turnNumbers = new Map<number, number>();
  private readonly tasks = new Map<string, UiTaskProgressEntry[]>();
  private readonly activities = new Map<string, UiTurnActivityEntry[]>();
  private readonly turns: number;

  constructor(
    private readonly sessionId: string,
    private readonly messages: readonly UiMessage[],
    taskHistory: readonly UiTaskProgressEntry[] = [],
    activityHistory: readonly UiTurnActivityEntry[] = [],
  ) {
    let turn = 0;
    messages.forEach((message, index) => {
      if (message.role === "user") this.users.push(index);
      if (startsTurn(message)) this.turnNumbers.set(index, ++turn);
    });
    this.turns = turn;
    for (const entry of taskHistory) {
      const key = entry.anchorMessageId ?? "";
      const group = this.tasks.get(key) ?? [];
      group.push(entry);
      this.tasks.set(key, group);
    }
    for (const entry of activityHistory) {
      const key = entry.anchorMessageId ?? "";
      const group = this.activities.get(key) ?? [];
      group.push(entry);
      this.activities.set(key, group);
    }
  }

  get messageCount(): number { return this.messages.length; }

  /** Serialized retained payload, charged to the existing reader cache budget. */
  get cacheBytes(): number {
    return Buffer.byteLength(JSON.stringify([this.messages, [...this.tasks], [...this.activities]]));
  }

  page(cursor?: HostTranscriptCursor, tail: readonly UiMessage[] = []): TranscriptPage {
    const baseLength = this.messages.length;
    const end = cursor === undefined ? baseLength + tail.length
      : localTranscriptCursorPolicy.indexFromCursor(cursor, baseLength + tail.length);
    let low = 0;
    let high = this.users.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.users[middle]! < end) low = middle + 1;
      else high = middle;
    }
    const tailUsers = tail.flatMap((message, index) => message.role === "user" && baseLength + index < end ? [baseLength + index] : []);
    const count = low + tailUsers.length;
    const user = Math.max(0, count - OLDER_TRANSCRIPT_TURN_LIMIT);
    const start = count === 0 ? end : user < low ? this.users[user]! : tailUsers[user - low]!;
    const window = [
      ...this.messages.slice(Math.min(start, baseLength), Math.min(end, baseLength)),
      ...tail.slice(Math.max(0, start - baseLength), Math.max(0, end - baseLength)),
    ];
    const numbered = window.findIndex(startsTurn);
    if (start > 0 && numbered >= 0) {
      const position = start + numbered;
      const turnNumber = position < baseLength ? this.turnNumbers.get(position)
        : this.turns + tail.slice(0, position - baseLength + 1).filter(startsTurn).length;
      window[numbered] = { ...window[numbered]!, turnNumber };
    }
    const taskHistory = [...(this.tasks.get("") ?? [])];
    const activityHistory = [...(this.activities.get("") ?? [])];
    const ids = new Set(window.flatMap((message) => [message.id, ...(message.sourceEntryId ? [message.sourceEntryId] : [])]));
    for (const id of ids) {
      taskHistory.push(...(this.tasks.get(id) ?? []));
      activityHistory.push(...(this.activities.get(id) ?? []));
    }
    const page = localTranscriptPage(this.sessionId, window, taskHistory, activityHistory, true);
    const olderCursor = user > 0 ? hostCursorAtLocalIndex(start) : undefined;
    const firstUser = window.find((message) => message.role === "user");
    return {
      ...page,
      ...(olderCursor ? { olderCursor } : {}),
      hasMore: user > 0,
      historyCompleteness: user > 0 ? "has-more" : "complete",
      ...(olderCursor && firstUser ? {
        cursorBeforeMessageId: firstUser.id,
        cursorBoundaries: normalizeTranscriptCursorBoundaries(undefined, firstUser.id, olderCursor),
      } : {}),
    };
  }
}
