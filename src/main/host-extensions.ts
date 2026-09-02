import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DiffLoadOptions, ExtensionUiPrompt, GlobalHostEvent, HostExtensionSummary, ThreadBackendKind, ThreadHostEvent, UiFileDiff, UiMessage, UiWorkspaceChanges, UiWorkspaceChangesPage } from "../shared/contracts.js";
import type { HostActionResult } from "../shared/host-protocol.js";
import type { GitCoordinator } from "./git-coordinator.js";
import type { RuntimePermissionPolicy } from "./runtime-adapters.js";

export interface DirectoryPickerOptions {
  buttonLabel?: string;
  message?: string;
  createDirectory?: boolean;
}

/** What the platform (Electron main, later a remote host) lends to extensions. */
export interface HostPlatform {
  pickDirectory?(options?: DirectoryPickerOptions): Promise<string | undefined>;
}

export type CheckpointHostEvent = Extract<ThreadHostEvent, { type: "turn-checkpoint" | "turn-checkpoint-status" }>;

/**
 * Turn checkpoints still live in core because thread opening, project
 * switching, forking and transcript anchors depend on them. This facade is the
 * wire Workspace Kit owns until that lifecycle coupling is unwound.
 */
export interface HostCheckpointServices {
  canRestore(sessionId: string, checkpointId: string): Promise<boolean>;
  restorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges>;
  restore(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  turnFileDiff(sessionId: string, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  turnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  subscribe(listener: (event: CheckpointHostEvent) => void): () => void;
}

export interface RuntimeSettingsView {
  global: unknown;
  project: unknown;
}

export interface RuntimeExtensionOptions {
  /** Decides per runtime, from Pi's settings, whether the extension loads at all. */
  enabledFor?: (settings: RuntimeSettingsView) => boolean;
}

export interface RuntimeExtensionContribution extends RuntimeExtensionOptions {
  name: string;
  factory: ExtensionFactory;
}

/** What a host extension may do with one open thread. */
export interface HostThread {
  readonly sessionId: string;
  readonly cwd: string;
  readonly backendKind: ThreadBackendKind;
  isStreaming(): boolean;
  waitForIdle(): Promise<void>;
  /** False once the host replaced or closed this thread's runtime. */
  isCurrent(): boolean;
  sessionName(): string | undefined;
  transcript(): Promise<UiMessage[]>;
  /** Asks a model of the thread's runtime for a title of the given conversation. */
  completeTitle(provider: string, modelId: string, conversation: string): Promise<string>;
  /** The provider API of the thread's active model, e.g. "openai-responses". */
  modelApi(): string | undefined;
}

/**
 * Host-side extension seam. Core owns the workspace, the thread lifecycle and
 * the event channel; a host extension owns a feature and reaches the renderer
 * through commands and events routed by id, never through a core IPC entry.
 */
export interface HostExtensionServices {
  /** The workspace the host currently has open. */
  cwd(): string;
  readonly safeMode: boolean;
  log(label: string, detail?: string): void;
  /** Opens a project the way a project switch does; the same path re-activates it. */
  openWorkspace(path: string): Promise<HostActionResult>;
  /** Canonical path of a project the host already admitted; rejects any other path. */
  knownWorkspacePath(path: string): Promise<string>;
  projectName(cwd: string): Promise<string>;
  rememberProjectName(cwd: string, name: string): void;
  /** Shared Git cache; core still reads branches from it for the thread index. */
  readonly git: GitCoordinator;
  /** Native folder picker of the host platform; resolves undefined when cancelled. */
  pickDirectory(options?: DirectoryPickerOptions): Promise<string | undefined>;
  /** Whether Tau or an attached Pi terminal owns the active runtime. */
  runtimeOwner(): "tau" | "pi";
  /** An open thread by id, or the active one; `undefined` when it is not open. */
  thread(sessionId?: string): HostThread | undefined;
  /** Renames a thread the way the title menu does, and publishes the change. */
  setThreadTitle(sessionId: string, title: string, source: "generated" | "renamed"): Promise<void>;
  /** Loads a Pi extension into every runtime the host creates from now on. */
  registerRuntimeExtension(name: string, factory: ExtensionFactory, options?: RuntimeExtensionOptions): () => void;
  readonly checkpoints: HostCheckpointServices;
  /** Lets an extension annotate Pi dialogs before the workbench sees them. */
  decorateUiPrompt(decorator: (prompt: ExtensionUiPrompt) => void): () => void;
  /** Which permission policy external runtimes launch with; `undefined` restores full access. */
  setPermissionPolicy(provider: (() => RuntimePermissionPolicy) | undefined): void;
}

export type HostExtensionCommandHandler = (input: unknown) => unknown;

export interface HostExtensionContext {
  readonly id: string;
  readonly services: HostExtensionServices;
  registerCommand(name: string, handler: HostExtensionCommandHandler): () => void;
  /** Publishes an `extension-event` for this extension's desktop counterpart. */
  emit(name: string, payload?: unknown): void;
}

export interface HostExtension {
  id: string;
  name: string;
  activate(context: HostExtensionContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

interface ActiveHostExtension {
  extension: HostExtension;
  commands: Map<string, HostExtensionCommandHandler>;
  disposers: Array<() => void | Promise<void>>;
}

export class HostExtensionRegistry {
  private readonly active = new Map<string, ActiveHostExtension>();
  private readonly known = new Map<string, HostExtension>();
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly services: HostExtensionServices,
    private readonly publish: (event: GlobalHostEvent) => void,
  ) {}

  /** Activates one extension; a failure is recorded and reported, never thrown. */
  async activate(extension: HostExtension): Promise<boolean> {
    if (!EXTENSION_ID.test(extension.id)) {
      this.failures.set(extension.id, `invalid host extension id "${extension.id}"`);
      return false;
    }
    await this.deactivate(extension.id);
    this.known.set(extension.id, extension);
    this.failures.delete(extension.id);
    const record: ActiveHostExtension = { extension, commands: new Map(), disposers: [] };
    const context: HostExtensionContext = {
      id: extension.id,
      services: this.services,
      registerCommand: (name, handler) => {
        if (!COMMAND_NAME.test(name)) throw new Error(`Host extension ${extension.id}: invalid command name "${name}"`);
        if (record.commands.has(name)) throw new Error(`Host extension ${extension.id}: command "${name}" registered twice`);
        record.commands.set(name, handler);
        const dispose = () => { if (record.commands.get(name) === handler) record.commands.delete(name); };
        record.disposers.push(dispose);
        return dispose;
      },
      emit: (name, payload) => {
        if (this.active.get(extension.id) !== record) return;
        this.publish({ type: "extension-event", extensionId: extension.id, name, payload });
      },
    };
    try {
      const dispose = await extension.activate(context);
      if (dispose) record.disposers.push(dispose);
      this.active.set(extension.id, record);
      this.services.log("host-extension.activated", `${extension.name} · ${[...record.commands.keys()].join(", ") || "no commands"}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(extension.id, message);
      await this.disposeAll(record.disposers).catch(() => undefined);
      this.services.log("host-extension.failed", `${extension.name}: ${message}`);
      return false;
    }
  }

  async deactivate(id: string): Promise<void> {
    const record = this.active.get(id);
    if (!record) return;
    this.active.delete(id);
    await this.disposeAll(record.disposers);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  async invoke(extensionId: string, command: string, input?: unknown): Promise<unknown> {
    const record = this.active.get(extensionId);
    if (!record) {
      const known = this.known.get(extensionId);
      throw new Error(known
        ? `Host extension ${known.name} is not active.`
        : `Host extension ${extensionId} is not installed.`);
    }
    const handler = record.commands.get(command);
    if (!handler) throw new Error(`Host extension ${record.extension.name} has no command "${command}".`);
    return handler(input);
  }

  summaries(): HostExtensionSummary[] {
    return [...this.known.values()].map((extension) => {
      const record = this.active.get(extension.id);
      const error = this.failures.get(extension.id);
      return {
        id: extension.id,
        name: extension.name,
        active: Boolean(record),
        commands: record ? [...record.commands.keys()].sort() : [],
        ...(error ? { error } : {}),
      };
    });
  }

  async dispose(): Promise<void> {
    const ids = [...this.active.keys()].reverse();
    const errors: unknown[] = [];
    for (const id of ids) {
      try { await this.deactivate(id); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Host extension shutdown failed");
  }

  private async disposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Host extension cleanup failed");
  }
}
