import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ThreadBackendKind, ThreadHostEvent, UiMessage, UiToolRun, UiTurnActivityEntry } from "../shared/contracts.js";
import type { LiveAssistant, LiveTurnState } from "./live-turn-state.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import { requireCapability, type ThreadBackendState, type ThreadRuntimeBackend, type ThreadTitleSource } from "./runtime-types.js";

type DeferredThreadRecord =
  | { kind: "event"; event: any; sessionId: string; cwd: string }
  | { kind: "error"; error: unknown }
  | { kind: "host"; event: ThreadHostEvent }
  | { kind: "title"; title: string };

/** One runtime bound to one Tau thread for the runtime's whole life. */
export class ThreadRuntime implements LiveTurnState {
  readonly tools = new Map<string, UiToolRun>();
  readonly pendingClientMessageIds: string[] = [];
  pendingClientMessageFingerprints = new Map<string, string>();
  /** Markers assigned at message_start but not finalized at message_end yet. */
  readonly inFlightClientMessageIds = new Set<string>();
  adapterMessages: UiMessage[] = [];
  /** Tool activity per turn of a backend without a journal; the newest entry may still run. */
  adapterActivity: UiTurnActivityEntry[] = [];
  adapterTitle?: string;
  adapterTitleSource?: ThreadTitleSource;
  adapterStreaming = false;
  adapterPending = 0;
  adapterAbortGeneration = 0;
  restartGeneration = 0;
  adapterAbortControllers = new Set<AbortController>();
  adapterQueue: Promise<void> = Promise.resolve();
  currentAssistantId?: string;
  liveAssistant?: LiveAssistant;
  turnError?: string;
  /** The running turn is one the runtime began itself; no prompt of the host's ends it. */
  unpromptedTurn = false;
  unsubscribe?: () => void;
  private deferredRecords?: DeferredThreadRecord[];

  constructor(
    readonly backend: ThreadRuntimeBackend,
    readonly runtime?: AgentSessionRuntime,
  ) {}

  get runtimeAdapter(): AgentRuntimeAdapter { return this.backend.runtimeAdapter; }
  get threadId(): string { return this.backend.threadId; }
  /** @deprecated External v1 calls still use sessionId; internal code uses threadId. */
  get sessionId(): string { return this.threadId; }
  get cwd(): string { return this.backend.cwd; }
  /** Cheap live state of the runtime; the adapter fields beside it are the host's own bookkeeping. */
  get state(): ThreadBackendState { return this.backend.state(); }
  get sessionFile(): string | undefined { return this.backend.state().sessionFile; }
  /** Raw journal entries of this thread's branch; empty for a runtime that keeps none. */
  get entries(): readonly unknown[] { return this.backend.capabilities.journal?.entries() ?? []; }
  appendJournalEntry(customType: string, data?: unknown): void {
    requireCapability(this.backend, "journal").appendCustomEntry(customType, data);
  }

  resetLiveState(): void {
    this.tools.clear();
    this.pendingClientMessageIds.length = 0;
    this.pendingClientMessageFingerprints.clear();
    this.inFlightClientMessageIds.clear();
    this.adapterAbortControllers.clear();
    this.currentAssistantId = undefined;
    this.liveAssistant = undefined;
    this.turnError = undefined;
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
    // Questions must remain answerable while a prepared runtime is binding.
    // Buffering their prompt would deadlock bind until the answer arrives.
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

/** True when the host itself runs this thread's Pi session in its own process. */
export function isLocalPiRuntime(thread: ThreadRuntime | undefined): boolean {
  return Boolean(thread?.runtime);
}

export function isThreadRuntime(thread: LiveTurnState | undefined): thread is ThreadRuntime {
  // Attached Pi sessions have a deliberately smaller live-state carrier.
  if (!thread || !("backend" in thread)) return false;
  const candidate = thread as ThreadRuntime;
  return candidate.backend.kind === "pi" && Boolean(candidate.runtime);
}

export function threadBackendKind(thread: ThreadRuntime | LiveTurnState | undefined): ThreadBackendKind {
  if (thread && "backend" in thread && thread.backend) return thread.backend.kind;
  return thread && "runtimeAdapter" in thread ? thread.runtimeAdapter.id : "pi";
}

export function isPiBackend(thread: ThreadRuntime | LiveTurnState | undefined): boolean {
  return threadBackendKind(thread) === "pi";
}
