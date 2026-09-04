import type {
  PreparedPrompt,
  UiComposerCommand,
  UiMessage,
  UiModel,
  UiSkillDraft,
} from "../shared/contracts.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { transcriptPagingNegotiated, type PiBridgePreparedPrompt, type PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { bridgeCursorValue } from "./transcript-cursor.js";
import { localTranscriptPage, readAttachedToolOutput } from "./host-transcript.js";
import { mapBridgeTranscriptPageValue, mapModel } from "./host-messages.js";
import { bridgeHostSnapshot, composerCommandsForAdapter } from "./bridge-snapshot.js";
import { PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { AttachedPiSession, type AttachedSessionHost } from "./attached-pi-session.js";
import type { AttachedRuntimeBackend } from "./attached-runtime.js";
import type { HostAttachedRuntime } from "./host-extensions.js";
import type {
  RuntimeChatTranscript,
  RuntimeNewThreadOutcome,
  RuntimeNewThreadRequest,
  ThreadBackendCapabilities,
  ThreadBackendPromptInput,
  ThreadBackendPromptResult,
  ThreadBackendState,
  ThreadCatalogView,
  ThreadRuntimeBackend,
} from "./runtime-types.js";

/**
 * The thread a Pi terminal owns while Tau is attached to it, as an ordinary
 * runtime backend. What Tau cannot do through the socket is a missing
 * capability here, never a branch in the host: no session journal, no tree, no
 * project actions, no runtime extensions. `session` is the attach/detach seam.
 */
export class AttachedThreadBackend implements ThreadRuntimeBackend {
  readonly kind = "pi" as const;
  readonly runtimeAdapter: AgentRuntimeAdapter = PI_AGENT_RUNTIME_ADAPTER;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  readonly session: AttachedRuntimeBackend;

  constructor(private readonly host: AttachedSessionHost, session?: AttachedRuntimeBackend) {
    this.session = session ?? new AttachedPiSession(host);
    this.capabilities = {
      // Pi runs /fork in its own terminal and reports the result as a snapshot.
      fork: {
        runtimeOwned: true,
        requestFork: async (entryId) => { await this.session.send({ command: "fork", entryId }); },
      },
      compaction: {
        compact: async () => {
          await this.session.send({ command: "compact" }, 120_000);
          await this.session.refreshSnapshot();
        },
      },
      catalogWrite: {
        setModel: async (provider, id) => {
          await this.session.send({ command: "set_model", provider, id });
          await this.session.refreshSnapshot();
        },
        setThinkingLevel: async (level) => {
          await this.session.send({ command: "set_thinking", level });
          await this.session.refreshSnapshot();
        },
      },
      // Pi reloads its own resources in its terminal.
      reload: { reload: async () => { await this.session.send({ command: "reload" }); } },
      transcriptPaging: {
        page: (cursor) => this.transcriptPage(cursor),
        readToolOutput: (toolCallId) => readAttachedToolOutput(toolCallId, (command) => this.session.command(command)),
      },
      markdownExport: { exportTranscript: () => this.exportTranscript() },
      newThread: { create: (request) => this.createThread(request) },
    };
  }

  private get snapshot(): PiBridgeSnapshot | undefined { return this.session.snapshot; }

  get threadId(): string { return this.snapshot?.sessionId ?? ""; }
  get providerSessionId(): string { return this.threadId; }
  get cwd(): string { return this.snapshot?.cwd ?? ""; }

  /** Attaching is its own entry point; a thread Pi owns is never started by the host. */
  async start(): Promise<void> {}
  async dispose(): Promise<void> { this.session.detach(); }

  state(): ThreadBackendState {
    const snapshot = this.snapshot;
    return {
      streaming: snapshot?.isStreaming ?? false,
      idle: !snapshot?.isStreaming,
      hasMessages: (snapshot?.messages.length ?? 0) > 0,
      ...(snapshot?.sessionName ? { title: snapshot.sessionName } : {}),
      ...(snapshot?.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
      activeTools: snapshot?.activeTools ?? [],
      supportsImageInput: snapshot?.supportsImageInput === true,
      extensionCount: 0,
    };
  }

  catalogView(): ThreadCatalogView {
    const snapshot = this.snapshot;
    return {
      ...(snapshot?.model ? { model: mapModel(snapshot.model) } : {}),
      thinkingLevel: snapshot?.thinkingLevel ?? "off",
      thinkingLevels: snapshot?.thinkingLevels ?? ["off"],
      allTools: snapshot?.allTools ?? [],
    };
  }

  async models(): Promise<UiModel[]> { return (this.snapshot?.models ?? []).map(mapModel); }

  composerCommands(): UiComposerCommand[] {
    return composerCommandsForAdapter(this.snapshot?.composerCommands ?? [], this.runtimeAdapter);
  }

  async transcript(): Promise<UiMessage[]> {
    const snapshot = this.snapshot;
    return snapshot ? bridgeHostSnapshot(snapshot, this.host.clientTurns).messages : [];
  }

  /**
   * Pi's bridge pages its own transcript once it has negotiated paging; an
   * older bridge extension only publishes a bounded window, which the host
   * pages locally without ever inspecting the cursor.
   */
  private async transcriptPage(cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const snapshot = this.snapshot;
    if (snapshot && transcriptPagingNegotiated(snapshot.capabilities)) {
      const raw = cursor === undefined
        ? await this.session.command({ command: "transcript_page" }) as unknown
        : await this.session.command({ command: "transcript_page", cursor: bridgeCursorValue(cursor) }) as unknown;
      return mapBridgeTranscriptPageValue(this.threadId, raw);
    }
    if (!snapshot) throw new Error("Pi bridge snapshot is unavailable.");
    const window = bridgeHostSnapshot(snapshot, this.host.clientTurns);
    return localTranscriptPage(
      this.threadId,
      window.messages,
      window.taskHistory,
      window.turnActivityHistory,
      window.turnActivityHistoryComplete,
      cursor,
    );
  }

  /** Pi is the sole writer of its session file. */
  async persist(): Promise<void> {}

  /** Pi's terminal owns the run; the host can only watch its snapshot. */
  async waitForIdle(): Promise<void> {
    while (this.session.isAttached && this.snapshot?.isStreaming) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 100).unref?.(); });
      await this.session.refreshSnapshot();
    }
  }

  /** How a host extension reaches its counterpart inside the Pi that owns this thread. */
  get hostRuntime(): HostAttachedRuntime {
    return {
      sessionId: this.threadId,
      invoke: (extensionId, name, input) => this.session.command({ command: "extension", extensionId, name, input }),
    };
  }

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    const result = await this.session.command({ command: "prepare_prompt", text, ...(skill ? { skill } : {}) });
    if (!result || typeof result !== "object") throw new Error("Pi bridge returned an invalid prepared prompt.");
    const prepared = result as Partial<PiBridgePreparedPrompt>;
    if (typeof prepared.visibleText !== "string" || typeof prepared.runtimeText !== "string" || typeof prepared.sourceFingerprint !== "string") {
      throw new Error("Pi bridge returned an invalid prepared prompt.");
    }
    const threadId = this.threadId || undefined;
    const preparedResult: PreparedPrompt = {
      tauThreadId: threadId,
      providerSessionId: threadId,
      sessionId: threadId,
      backendKind: "pi",
      runtimeCapabilities: prepared.runtimeCapabilities ?? this.runtimeAdapter.capabilities,
      visibleText: prepared.visibleText,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: prepared.sourceFingerprint,
    };
    validatePreparedPrompt(text, preparedResult, {
      backendKind: "pi",
      threadId,
      providerSessionId: threadId,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      commands: this.snapshot?.composerCommands ?? [],
    });
    return preparedResult;
  }

  /**
   * Pi's bridge extension is the runtime owner and normalizes the prompt
   * against its own command registry exactly once, so the attachments travel
   * as the composer sent them.
   */
  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    const attachments = input.attachments ?? [];
    await this.session.send({
      command: "prompt",
      text: input.text,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      ...(input.delivery === "prompt" ? {} : { deliverAs: input.delivery }),
      ...(input.identity ?? {}),
      ...(input.prepared ? { prepared: this.bridgePrepared(input.prepared) } : {}),
    });
    input.onAdmitted?.(true);
    return {};
  }

  async abort(): Promise<void> {
    this.session.cancelPendingNewSession(this.threadId || undefined);
    await this.session.send({ command: "abort" });
  }

  async setTitle(title: string): Promise<void> {
    await this.session.send({ command: "set_session_name", name: title });
    await this.session.refreshSnapshot();
  }

  private async createThread(request: RuntimeNewThreadRequest): Promise<RuntimeNewThreadOutcome> {
    const outcome = await this.session.requestNewSession({
      requestId: request.requestId,
      projectPath: request.projectPath,
      ...(request.initialPrompt === undefined ? {} : { initialPrompt: request.initialPrompt }),
      attachments: request.attachments,
      ...(request.identity ? { identity: request.identity } : {}),
      ...(request.prepared ? { prepared: this.bridgePrepared(request.prepared) } : {}),
    });
    if (!outcome.snapshot) return { adopted: false };
    this.session.adoptSnapshot(outcome.snapshot);
    return { adopted: true };
  }

  /**
   * Pi owns the normalization of its own transcript. Re-parsing here could
   * reinterpret a legitimate visible `$skill ...` instruction after the
   * wrapper has already been removed.
   */
  private async exportTranscript(): Promise<RuntimeChatTranscript> {
    const result = await this.session.send({ command: "export_markdown" }) as {
      title?: unknown;
      cwd?: unknown;
      sessionId?: unknown;
      messages?: unknown;
    };
    if (!Array.isArray(result.messages)) throw new Error("Pi did not return a normalized chat transcript.");
    return {
      ...(typeof result.title === "string" ? { title: result.title } : {}),
      cwd: typeof result.cwd === "string" ? result.cwd : this.cwd,
      threadId: typeof result.sessionId === "string" ? result.sessionId : this.threadId,
      messages: result.messages as Array<{ role?: string; content?: unknown }>,
    };
  }

  private bridgePrepared(prepared: PreparedPrompt): PiBridgePreparedPrompt {
    if (prepared.backendKind !== "pi") throw new Error("Prepared prompt belongs to another runtime.");
    return {
      visibleText: prepared.visibleText,
      runtimeText: prepared.runtimeText,
      runtimeCapabilities: prepared.runtimeCapabilities,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: prepared.sourceFingerprint,
    };
  }
}
