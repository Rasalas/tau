import { existsSync } from "node:fs";
import { readSessionFile } from "./session-read.js";
import type { UiComposerCommand, UiMessage, UiToolOutputReadResult } from "../shared/contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { HostBackendThreadRecord, HostThread } from "./host-extensions.js";
import {
  EMPTY_PINS,
  isVisibleMessage,
  mapMessage,
  turnActivityHistoryFromMessages,
  type MessageMappingOptions,
} from "./host-messages.js";
import { localTranscriptPage, readLocalToolOutput } from "./host-transcript.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import { branchRecords } from "./thread-projection.js";

/** What the reader is told when the file behind a thread cannot be opened. */
export const MISSING_SESSION_FILE = "That thread's session file is gone. It may have been deleted.";
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
  const messages: UiMessage[] = record.messages.map((message, index) => ({
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

  constructor(thread: PersistedThreadInfo, options: PersistedTranscriptOptions) {
    this.sessionId = thread.sessionId;
    const entries = openBranch(thread.path);
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
    return this.messagesWith(this.mapping);
  }

  page(cursor?: HostTranscriptCursor): TranscriptPage {
    return localTranscriptPage(
      this.sessionId,
      this.messages(),
      taskProgressHistoryFromMessages(this.records),
      turnActivityHistoryFromMessages(this.records),
      true,
      cursor,
    );
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
function fileOnlyThread(
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
