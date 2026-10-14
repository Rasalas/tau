import { existsSync } from "node:fs";
import { readSessionFile } from "./session-read.js";
import type { UiComposerCommand, UiMessage, UiToolOutputReadResult, UiTaskProgressEntry, UiTurnActivityEntry } from "../shared/contracts.js";
import { normalizeTranscriptCursorBoundaries, type TranscriptPage } from "../shared/host-protocol.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { HostBackendThreadRecord, HostThread } from "./host-extensions.js";
import { inStartOrder } from "./kit-message-order.js";
import {
  EMPTY_PINS,
  isVisibleMessage,
  mapMessage,
  turnActivityHistoryFromMessages,
  type MessageMappingOptions,
} from "./host-messages.js";
import { localTranscriptCursorPolicy, localTranscriptPage, readLocalToolOutput } from "./host-transcript.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import { startsTurn } from "../shared/message-turns.js";
import { hostCursorAtLocalIndex } from "./transcript-cursor.js";
import { branchRecords } from "./thread-projection.js";

/** What the reader is told when the file behind a thread cannot be opened. */
export const MISSING_SESSION_FILE = "That thread's session file is gone. It may have been deleted.";
export const PERSISTED_TRANSCRIPT_CHANGED = "That thread's session file changed while it was being read. Try again.";
export const UNREADABLE_SESSION_FILE = "That thread's session file could not be read.";

/**
 * The transcript of a thread another runtime backend owns while no runtime
 * holds it: the shell that backend keeps for the index, paged the same way.
 * It carries what the program persisted — the visible messages — and reading
 * it starts nothing.
 */
export function shellTranscriptPage(
  sessionId: string,
  record: Pick<HostBackendThreadRecord, "messages" | "updatedAt">,
  cursor?: HostTranscriptCursor,
): TranscriptPage {
  // A store's messages may carry their times, beyond what the record's type promises.
  const messages: UiMessage[] = inStartOrder(record.messages as ReadonlyArray<Pick<UiMessage, "role" | "text"> & { timestamp?: number }>).map((message, index) => ({
    id: `${sessionId}:${index}`,
    role: message.role,
    text: message.text,
    timestamp: record.updatedAt,
  }));
  return localTranscriptPage(sessionId, messages, undefined, undefined, true, cursor);
}

/** The thread a persisted transcript belongs to, as the index knows it. */
export interface PersistedThreadInfo {
  sessionId: string;
  cwd: string;
  path: string;
  title?: string;
  parentThreadId?: string;
}

export interface PersistedTranscriptOptions {
  runtimeAdapter: AgentRuntimeAdapter;
  /** The host's own skill commands, so a skill turn reads the way it did live. */
  skillCommands: readonly UiComposerCommand[];
  /** Entry pins extensions contribute; they see a file, not a runtime. */
  pins?: (thread: HostThread) => ReadonlySet<string>;
  /** Changes when the host registers or removes pin providers. */
  pinsRevision?: string | number;
}

/** The branch of a persisted session; every failure reads as a missing transcript. */
function openBranch(path: string): readonly unknown[] {
  if (!path || !existsSync(path)) throw new Error(MISSING_SESSION_FILE);
  try {
    // Read in memory: Pi's open could repair a file another host is writing.
    return readSessionFile(path).getBranch();
  } catch (error) {
    throw new Error(UNREADABLE_SESSION_FILE, { cause: error });
  }
}

/**
 * A thread's transcript read back from its session file, for a thread the host
 * holds no runtime for. Runtimes are capped and released oldest first, so with
 * many agents this is the ordinary way a thread's tab is read, not a fallback:
 * it maps, pages, and correlates client messages exactly as the live path does.
 */
export class PersistedThreadTranscript {
  private readonly sessionId: string;
  private readonly records: unknown[];
  private readonly mapping: MessageMappingOptions;
  readonly entries: readonly unknown[];
  private mapped?: UiMessage[];
  private users: number[] = [];
  private turnNumbers = new Map<number, number>();
  private tasks = new Map<string, UiTaskProgressEntry[]>();
  private activities = new Map<string, UiTurnActivityEntry[]>();

  constructor(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, entriesFromWorker?: readonly unknown[]) {
    this.sessionId = thread.sessionId;
    const entries = entriesFromWorker ?? openBranch(thread.path);
    this.entries = entries;
    this.records = branchRecords(entries, knownSkillNames(options.skillCommands)).map(({ record }) => record);
    const unpinned: MessageMappingOptions = {
      runtimeAdapter: options.runtimeAdapter,
      skillCommands: options.skillCommands,
    };
    this.mapping = {
      ...unpinned,
      pinned: options.pins?.(fileOnlyThread(thread, entries, () => this.messagesWith(unpinned))) ?? EMPTY_PINS,
    };
  }

  messages(): UiMessage[] {
    if (!this.mapped) {
      this.mapped = this.messagesWith(this.mapping);
      let turn = 0;
      this.mapped.forEach((message, index) => {
        if (message.role === "user") this.users.push(index);
        if (startsTurn(message)) this.turnNumbers.set(index, ++turn);
      });
      for (const entry of taskProgressHistoryFromMessages(this.records)) {
        const key = entry.anchorMessageId ?? "";
        this.tasks.set(key, [...(this.tasks.get(key) ?? []), entry]);
      }
      for (const entry of turnActivityHistoryFromMessages(this.records)) {
        const key = entry.anchorMessageId ?? "";
        this.activities.set(key, [...(this.activities.get(key) ?? []), entry]);
      }
    }
    return this.mapped;
  }

  page(cursor?: HostTranscriptCursor): TranscriptPage {
    const messages = this.messages();
    const end = cursor === undefined ? messages.length : localTranscriptCursorPolicy.indexFromCursor(cursor, messages.length);
    // Binary search the user-turn index instead of walking the prefix on every page.
    let low = 0;
    let high = this.users.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.users[middle]! < end) low = middle + 1;
      else high = middle;
    }
    const user = Math.max(0, low - 20);
    const start = low === 0 ? end : this.users[user]!;
    const window = messages.slice(start, end);
    const numbered = window.findIndex(startsTurn);
    if (start > 0 && numbered >= 0) window[numbered] = { ...window[numbered]!, turnNumber: this.turnNumbers.get(start + numbered) };
    const taskHistory = [...(this.tasks.get("") ?? [])];
    const activityHistory = [...(this.activities.get("") ?? [])];
    const ids = new Set(window.flatMap((message) => [message.id, ...(message.sourceEntryId ? [message.sourceEntryId] : [])]));
    for (const id of ids) {
      taskHistory.push(...(this.tasks.get(id) ?? []));
      activityHistory.push(...(this.activities.get(id) ?? []));
    }
    const page = localTranscriptPage(this.sessionId, window, taskHistory, activityHistory, true);
    const olderCursor = user > 0 ? hostCursorAtLocalIndex(start) : undefined;
    return {
      ...page,
      ...(olderCursor ? { olderCursor } : {}),
      hasMore: user > 0,
      historyCompleteness: user > 0 ? "has-more" : "complete",
      ...(olderCursor && window.find((message) => message.role === "user") ? {
        cursorBeforeMessageId: window.find((message) => message.role === "user")!.id,
        cursorBoundaries: normalizeTranscriptCursorBoundaries(undefined, window.find((message) => message.role === "user")!.id, olderCursor),
      } : {}),
    };
  }

  toolOutput(toolCallId: string): UiToolOutputReadResult | undefined {
    return readLocalToolOutput(this.records, toolCallId);
  }

  private messagesWith(mapping: MessageMappingOptions): UiMessage[] {
    return this.records
      .map((record, index) => mapMessage(record, index, mapping))
      .filter((message): message is UiMessage => isVisibleMessage(message, mapping.pinned));
  }
}

/**
 * The thread a pin provider sees for a session that has no runtime: its
 * entries and its identity, and nothing that would need one.
 */
export function fileOnlyThread(
  thread: PersistedThreadInfo,
  entries: readonly unknown[],
  messages: () => UiMessage[],
): HostThread {
  const noRuntime = (): never => { throw new Error("That thread has no runtime; only its persisted transcript is available."); };
  return {
    sessionId: thread.sessionId,
    cwd: thread.cwd,
    backendKind: "pi",
    sessionFile: thread.path,
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    isStreaming: () => false,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    isCurrent: () => false,
    sessionName: () => thread.title,
    transcript: async () => messages(),
    complete: noRuntime,
    modelApi: () => undefined,
    shortcuts: () => [],
    runShortcut: async () => false,
    entries: () => entries,
    appendEntry: noRuntime,
  };
}
