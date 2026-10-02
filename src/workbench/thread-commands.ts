import type {
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  ShellActionResult,
  UiMessage,
  UiProject,
  UiToolOutputPreview,
  UiToolRun,
} from "../shared/contracts";
import type { HostActionResult, TranscriptPage } from "../shared/host-protocol";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { ClientStorage } from "./client-storage";
import { errorMessage } from "./error-message";
import type { HostClient } from "./host-client";
import type { Platform } from "./platform";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";
import { clearCachedTurnActivity } from "./turn-activity";

/** What a command needs of the contribution registry. */
export interface ThreadCommandRegistryPort {
  notifyPromptAnswered(prompt: ExtensionUiPrompt, answer: ExtensionUiAnswer): void;
}

/** What a command needs of the user's preferences. */
export interface ThreadCommandPreferencesPort {
  toggleSettled(sessionId: string): void;
}

export interface ThreadCommandPorts {
  /** Read every time: the client outlives no reload, the commands do. */
  client(): HostClient | undefined;
  view: ThreadViewStore;
  threads: ThreadStore;
  storage: ClientStorage;
  platform: Platform;
  registry: ThreadCommandRegistryPort;
  preferences: ThreadCommandPreferencesPort;
  applyActionResult(result: HostActionResult): boolean;
}

/**
 * Everything the workbench does to the thread on screen that is one host call
 * and a notice: rename, model, thinking, recovery, compaction, fork, duplicate,
 * copy. None of it needs a view, so none of it belongs in a component — and a
 * client without React runs the same commands.
 */
export class ThreadCommands {
  constructor(private readonly ports: ThreadCommandPorts) {}

  private get client(): HostClient | undefined {
    return this.ports.client();
  }

  private notify(message: string): void {
    this.ports.view.setNotice(message);
  }

  private sessionId(): string | undefined {
    return this.ports.view.getSnapshot()?.sessionId;
  }

  /** Says why an action is unavailable rather than failing silently without a host. */
  requireHost = (what: string): boolean => {
    if (this.client) return true;
    this.notify(`${what} requires the Electron host`);
    return false;
  };

  /** A host, and a device allowed to change something on it. */
  private requireWrite(what: string): boolean {
    return !this.readOnly(what) && this.requireHost(what);
  }

  // Shared by the composer and the activity rail's stop button, so neither
  // recreates it every render and defeats a downstream memo.
  abort = (sessionId?: string): void => {
    if (!this.readOnly("Stopping a run")) void this.client?.abort(sessionId);
  };

  /** A Read-only device is refused every change (ADR 0024); true after saying so. */
  private readOnly(what: string): boolean {
    if (!this.client?.isReadOnly()) return false;
    this.notify(`${what} needs Full access; this device is paired Read only.`);
    return true;
  }

  loadThread = async (sessionId: string): Promise<TranscriptPage> => {
    const client = this.client;
    if (!client) throw new Error("Reading another thread requires the Electron host");
    return client.loadTranscript(sessionId);
  };

  loadTranscriptPage = async (sessionId: string, cursor: HostTranscriptCursor) => {
    const client = this.client;
    if (!client) throw new Error("Transcript history requires the Electron host.");
    return client.loadTranscript(sessionId, cursor);
  };

  removeProject = async (project: UiProject): Promise<void> => {
    if (!this.requireWrite("Project removal")) return;
    try {
      this.ports.applyActionResult(await this.client!.removeProject(project.workspaceId ?? project.path));
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  renameThread = async (title: string): Promise<boolean> => {
    if (!this.requireWrite("Thread rename")) return false;
    try {
      this.ports.applyActionResult(await this.client!.renameThread(
        title,
        this.ports.threads.getSnapshot().activeThreadId,
      ));
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    }
  };

  setModel = async (provider: string, id: string): Promise<void> => {
    if (!this.requireWrite("Model selection")) return;
    try {
      this.ports.applyActionResult(await this.client!.setModel(provider, id));
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  setThinking = async (level: string): Promise<void> => {
    if (!this.requireWrite("Thinking level")) return;
    try {
      this.ports.applyActionResult(await this.client!.setThinkingLevel(level));
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  /** Resolves false when the host refused; the notice says why. */
  setMode = async (mode: string): Promise<boolean> => {
    if (!this.requireWrite("Interaction mode")) return false;
    try {
      this.ports.applyActionResult(await this.client!.setMode(mode, this.sessionId()));
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    }
  };

  recoverThread = async (): Promise<void> => {
    if (!this.requireWrite("Thread recovery")) return;
    try {
      const sessionId = this.sessionId();
      this.ports.applyActionResult(await this.client!.recoverThread());
      // The stalled row is restored from a client-side cache, so clearing the
      // session alone would leave the ghost on screen.
      if (sessionId) clearCachedTurnActivity(this.ports.storage, sessionId);
      this.ports.view.setTools([]);
      this.ports.view.setToolAnchorId(undefined);
      this.notify("Closed the interrupted call. The thread can continue.");
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  compactContext = async (): Promise<void> => {
    if (!this.requireWrite("Compaction")) return;
    try {
      // The transcript draws the compaction where it happened.
      this.ports.applyActionResult(await this.client!.compactContext());
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  /** Pi's `!command` for extensions: runs in the active thread's project. */
  runShellAction = async (command: string, includeInContext: boolean): Promise<ShellActionResult> => {
    const client = this.client;
    if (!client) throw new Error("Project actions require the Electron host");
    return client.runShellAction(command, includeInContext, this.ports.view.getSnapshot()?.cwd);
  };

  answerUiPrompt = (id: string, answer: ExtensionUiAnswer): void => {
    // Left on screen: the host keeps waiting for a device that may answer.
    if (this.readOnly("Answering")) return;
    const prompt = this.ports.view.getUiPrompts().find((entry) => entry.id === id);
    if (prompt) this.ports.registry.notifyPromptAnswered(prompt, answer);
    this.ports.view.setUiPrompts((current) => current.filter((entry) => entry.id !== id));
    void this.client?.answerExtensionUi(id, answer);
  };

  settleActiveThread = (): void => {
    const activeId = this.ports.threads.getSnapshot().activeThreadId;
    if (!activeId) return;
    this.ports.preferences.toggleSettled(activeId);
  };

  /** The chat as Markdown goes through the host, which owns the transcript; the rest is the user's clipboard. */
  copyThreadValue = async (kind: "chat" | "path" | "thread-id"): Promise<void> => {
    const snapshot = this.ports.view.getSnapshot();
    if (kind === "chat") {
      if (!snapshot?.sessionId || !this.client) return;
      try {
        const markdown = await this.client.threadMarkdown(snapshot.sessionId);
        if (markdown) await this.ports.platform.clipboard.writeText(markdown);
        this.notify("Chat copied as Markdown.");
      } catch (error) {
        this.notify(errorMessage(error));
      }
      return;
    }
    const value = kind === "path" ? snapshot?.cwd : snapshot?.sessionId;
    if (!value) {
      this.notify("Value is unavailable.");
      return;
    }
    try {
      await this.ports.platform.clipboard.writeText(value);
      this.notify(`${kind === "path" ? "Path" : "Thread ID"} copied.`);
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  /** One clipboard write with its own confirmation; the caller decides what the text is. */
  copyText = async (text: string, done: string): Promise<void> => {
    try {
      await this.ports.platform.clipboard.writeText(text);
      this.notify(done);
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  copyToolOutput = async (tool: UiToolRun): Promise<void> => {
    const sessionId = this.sessionId();
    if (!sessionId || !this.client) {
      this.notify("Tool output is unavailable.");
      return;
    }
    try {
      const result = await this.client.readToolOutput(sessionId, tool.id);
      if (!result) throw new Error("The complete tool output is no longer available.");
      await this.ports.platform.clipboard.writeText(result.output);
      this.notify(result.truncated
        ? "Tool output exceeded the read limit; the bounded result was copied."
        : "Full tool output copied.");
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  /** A deferred tool's output, from the thread on screen; undefined when the host no longer has it. */
  loadToolOutput = async (tool: UiToolRun): Promise<UiToolOutputPreview | undefined> => {
    const sessionId = this.sessionId();
    if (!sessionId || !this.client) return undefined;
    return this.client.toolOutput(sessionId, tool.id);
  };

  forkMessage = async (message: UiMessage): Promise<void> => {
    const sessionId = this.sessionId();
    if (!message.sourceEntryId || !sessionId || !this.requireWrite("Fork thread")) return;
    try {
      this.notify("Forking thread…");
      this.ports.applyActionResult(await this.client!.forkThread(message.sourceEntryId, sessionId));
    } catch (error) {
      this.notify(errorMessage(error));
    }
  };

  duplicateThread = async (): Promise<boolean> => {
    if (!this.requireWrite("Duplicate thread")) return false;
    try {
      this.notify("Duplicating thread…");
      this.ports.applyActionResult(await this.client!.duplicateThread(this.sessionId()));
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    }
  };
}
