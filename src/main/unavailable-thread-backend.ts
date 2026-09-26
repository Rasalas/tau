import type { PreparedPrompt, ThreadBackendKind, UiMessage } from "../shared/contracts.js";
import type { HostBackendThreadRecord } from "./host-extensions.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type {
  ThreadBackendPromptResult,
  ThreadBackendState,
  ThreadCatalogView,
  ThreadRuntimeBackend,
  ThreadBackendCapabilities,
} from "./runtime-types.js";

/** A Pi session another host writes: its entries, read once from the file, and where that file is. */
export interface StoredPiSession {
  sessionFile: string;
  entries: readonly unknown[];
}

/**
 * Stands in for a thread whose runtime could not start (its CLI is missing, say,
 * or another host writes its Pi session): the thread opens read-only from what
 * its provider keeps, and every attempt to run it answers with the reason.
 * Switching to the thread again tries the real one.
 */
export class UnavailableThreadBackend implements ThreadRuntimeBackend {
  readonly capabilities: ThreadBackendCapabilities;
  readonly turnReporting = "awaited" as const;
  readonly providerSessionId: string;
  readonly threadId: string;
  readonly cwd: string;
  private readonly messages: UiMessage[];

  constructor(
    readonly kind: ThreadBackendKind,
    readonly runtimeAdapter: AgentRuntimeAdapter,
    private readonly record: HostBackendThreadRecord,
    readonly reason: string,
    /** A Pi thread reads as it would live: from its session entries, not from a shell. */
    private readonly stored?: StoredPiSession,
  ) {
    const refuse = (): never => { throw new Error(reason); };
    this.capabilities = stored ? { journal: { entries: () => stored.entries, appendCustomEntry: refuse, appendMessage: refuse } } : {};
    this.threadId = record.threadId;
    this.providerSessionId = record.threadId;
    this.cwd = record.cwd;
    this.messages = record.messages.map((message, index) => ({
      id: `${record.threadId}-stored-${index}`,
      role: message.role,
      text: message.text,
      timestamp: (message as { timestamp?: number }).timestamp ?? record.updatedAt,
    }));
  }

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
  async waitForIdle(): Promise<void> {}
  async abort(): Promise<void> {}
  async persist(): Promise<void> {}
  async setTitle(): Promise<void> {}

  state(): ThreadBackendState {
    return {
      streaming: false,
      idle: true,
      hasMessages: this.messages.length > 0 || (this.stored?.entries.length ?? 0) > 0,
      ...(this.record.title ? { title: this.record.title } : {}),
      ...(this.stored ? { sessionFile: this.stored.sessionFile } : {}),
      activeTools: [],
      supportsImageInput: false,
      extensionCount: 0,
    };
  }

  async preparePrompt(): Promise<PreparedPrompt> { throw new Error(this.reason); }
  async prompt(): Promise<ThreadBackendPromptResult> { throw new Error(this.reason); }
  async transcript(): Promise<UiMessage[]> { return this.messages; }
  catalogView(): ThreadCatalogView { return { thinkingLevel: "off", thinkingLevels: [], allTools: [] }; }
  async models() { return []; }
  composerCommands() { return []; }
}

export function isUnavailableBackend(backend: ThreadRuntimeBackend): backend is UnavailableThreadBackend {
  return backend instanceof UnavailableThreadBackend;
}
