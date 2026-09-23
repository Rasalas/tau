import type { PreparedPrompt, ThreadBackendKind, UiMessage } from "../shared/contracts.js";
import type { HostBackendThreadRecord } from "./host-extensions.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type {
  ThreadBackendPromptResult,
  ThreadBackendState,
  ThreadCatalogView,
  ThreadRuntimeBackend,
} from "./runtime-types.js";

/**
 * Stands in for a thread whose runtime could not start (its CLI is missing, say):
 * the thread opens read-only from what its provider keeps, and every attempt to
 * run it answers with the reason. Switching to the thread again tries the real one.
 */
export class UnavailableThreadBackend implements ThreadRuntimeBackend {
  readonly capabilities = {};
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
  ) {
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
      hasMessages: this.messages.length > 0,
      ...(this.record.title ? { title: this.record.title } : {}),
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
