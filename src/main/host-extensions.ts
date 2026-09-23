import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  GlobalHostEvent,
  HostExtensionSummary,
  RuntimeToolVersion,
  UiRuntimeCatalog,
  ThreadBackendKind,
  UiComposerCommand,
  UiMessage,
  UiModel,
  UiThreadUsage,
  UiToolRun,
} from "../shared/contracts.js";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol.js";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
import type { AgentRuntimeAdapter, RuntimePermissionLevel } from "./runtime-adapters.js";
import type { CompletionRequest, ThreadRuntimeBackend, ThreadRuntimeEvent } from "./runtime-types.js";
import { HOST_SERVICE_PERMISSIONS, type ExtensionIsolation } from "../shared/extension-permissions.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import { HostAuthorizationError, HostCommandError, isExpectedCommandError } from "./host-extension-errors.js";
import { HOST_CORE_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import type { InstalledExtension as InstalledPackage, RemovalResult as PackageRemoval } from "./extension-installer.js";
import type { PackageScope } from "./extension-sources.js";

export interface DirectoryPickerOptions {
  buttonLabel?: string;
  message?: string;
  createDirectory?: boolean;
}

/** What the platform (Electron main, later a remote host) lends to extensions. */
export interface HostPlatform {
  pickDirectory?(options?: DirectoryPickerOptions): Promise<string | undefined>;
  /**
   * Calls the window half of an extension. Only a host whose client runs in
   * its own process has one; a host with a window of its own does not.
   */
  callClient?(extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

/** A thread an external backend persisted, as the index lists it. */
export interface HostBackendThreadRecord {
  threadId: string;
  cwd: string;
  title?: string;
  updatedAt: number;
  /** Visible messages, enough for a title and a count. */
  messages: ReadonlyArray<Pick<UiMessage, "role" | "text">>;
}

/** What core hands a backend when it opens a thread. */
export interface HostBackendOpenContext {
  projectName: string;
  projectLabel?: string;
  permissionLevel(): RuntimePermissionLevel;
  /** Delivers a message the backend produced (user echo or assistant result) to the transcript. */
  onMessage(message: UiMessage): void;
  /** A streamed backend reports its turn through here; see `ThreadRuntimeEvent`. */
  onEvent(event: ThreadRuntimeEvent): void;
  /**
   * A blocking question to the user, on the workbench's own dialog surface;
   * the thread waits for it. Aborting the thread answers it as cancelled.
   */
  ask(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
}

/** A backend's question; the host names the prompt and its thread. */
export type BackendPrompt = Omit<ExtensionUiPrompt, "id" | "sessionId">;

/**
 * A runtime backend an extension supplies for threads it owns (ADR 0005).
 * Core creates, resumes, lists and prompts such threads through it and never
 * learns which program answers.
 */
export interface HostRuntimeBackendProvider {
  readonly kind: ThreadBackendKind;
  /** What the workbench calls this backend where a new thread's runtime is chosen; defaults to the kind. */
  readonly label?: string;
  readonly adapter: AgentRuntimeAdapter;
  /** Provider identity used for the thread index when the backend has no selectable model. */
  readonly modelProvider?: string;
  /** Every thread the backend persisted, for the index. */
  listThreads(): Promise<HostBackendThreadRecord[]>;
  /**
   * Takes a thread's shell out of the backend's own store and answers it as
   * plain JSON for the host's trash; the program's own history stays. Without
   * this pair the backend's threads cannot be deleted.
   */
  removeThread?(threadId: string): Promise<unknown>;
  /** Puts back what `removeThread` answered. */
  restoreThread?(threadId: string, record: unknown): Promise<void>;
  lookup(threadId: string): Promise<HostBackendThreadRecord | undefined>;
  /**
   * Opens a thread's backend; `resume` false creates it. `tools` comes only
   * with a create and only to a provider that `restrictsTools`: the thread
   * keeps just these tools for its whole life, resumes included.
   */
  open(threadId: string, cwd: string, options: { resume: boolean; tools?: readonly string[] }, context: HostBackendOpenContext): Promise<ThreadRuntimeBackend>;
  /** The provider honours `tools` on `open`; `sessions.start({ tools })` is refused for one that does not. */
  readonly restrictsTools?: boolean;
  /** Commands the composer offers for threads of this backend. */
  composerCommands(cwd: string): UiComposerCommand[];
  /** Rejects a prompt the backend cannot serve at this access level. */
  assertPromptAllowed?(level: RuntimePermissionLevel): void;
  /**
   * The program the backend drives: its installed and newest version and how
   * to update it. The host asks once a day and publishes the answer on
   * `runtimeBackends`; clients show a hint when `installed` is older.
   */
  version?(): Promise<RuntimeToolVersion | undefined>;
  /**
   * The models and thinking levels a new thread may start with, without
   * opening one; asked when a draft is bound for this backend. The chosen
   * pair reaches the thread through `catalogWrite` right after `open`.
   */
  newThreadCatalog?(): Promise<HostRuntimeNewThreadCatalog | undefined>;
}

/** A backend's answer to `newThreadCatalog`; the host adds the kind and the adapter's capabilities. */
export type HostRuntimeNewThreadCatalog = Omit<UiRuntimeCatalog, "kind" | "runtimeCapabilities">;

/**
 * Facts an extension knows about a project folder. Core caches them, refreshes
 * the label in the background and publishes changes with the thread index.
 */
export interface HostProjectFacts {
  /** Display name of a project; undefined keeps the folder name. */
  name?(cwd: string): Promise<string | undefined>;
  /** Short label shown beside the project (Workspace Kit: the Git branch). */
  label?(cwd: string): Promise<string | undefined>;
  /** True for a secondary checkout of another project; it is not listed as a project of its own. */
  nested?(cwd: string): Promise<boolean>;
}

/** A persisted session file without a runtime: its raw entries and the durable custom-entry seam. */
export interface HostSessionFile {
  readonly path: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** Entries on the current branch, in order. */
  entries(): readonly unknown[];
  leafId(): string | undefined;
  appendEntry(customType: string, data: unknown): void;
  appendInfo(text: string): void;
  /**
   * A new session continuing from `entryId`, or undefined for an unknown entry.
   * The handle it returns replaces this one; a branch without an assistant
   * message has no file until its first response, so it is never reopened from disk.
   */
  branch(entryId: string): HostSessionFile | undefined;
}

/** A runtime opened for a session that stays off screen until an extension activates it. */
export interface HostPreparedThread {
  readonly sessionId: string;
  readonly session: HostSessionFile;
  /** Adopts the runtime and puts it on screen; the updates carry the new detail, not the index. */
  activate(): Promise<HostActionResult>;
  /** Closes the runtime without ever showing it. */
  discard(): Promise<void>;
}

export interface HostSessionSummary {
  sessionId: string;
  path: string;
  cwd: string;
  /** The thread that spawned this one, as the index read it from the session file. */
  parentThreadId?: string;
}

/** A thread an extension asks the host to run for it, off screen. */
export interface HostThreadStartOptions {
  /** Project the thread runs in. */
  cwd: string;
  /** First prompt, delivered as soon as the thread exists. */
  prompt: string;
  title?: string;
  /** Model the thread starts with; the host's own default otherwise. */
  model?: { provider: string; id: string };
  /**
   * Runtime backend the thread runs on (`"pi"` or a registered kind); Pi when
   * absent. A kind nobody registered is refused before anything is created.
   */
  backend?: ThreadBackendKind;
  /**
   * The only tools the thread may use, as Pi names them (`read`, `bash`,
   * `tau_spawn_thread`, …); the backend maps them onto its own. Only for a
   * backend whose provider `restrictsTools` — any other, Pi included, is
   * refused before anything is created. A Pi thread's tools are set by a
   * runtime extension instead.
   */
  tools?: readonly string[];
  /**
   * The thread this one is spawned from. The host records the link in the new
   * session before its first prompt, so the thread index knows the child's
   * parent without opening either thread; `details` is stored beside it for
   * the kit that asked for the thread.
   */
  parent?: { threadId: string; details?: Record<string, unknown> };
}

export interface HostStartedThread {
  sessionId: string;
  cwd: string;
  title?: string;
}

/** A deleted thread waiting in the trash. */
export interface HostTrashedThread {
  sessionId: string;
  cwd: string;
  title: string;
  backendKind: ThreadBackendKind;
  deletedAt: number;
  /** When the host removes it for good. */
  purgeAt: number;
}

/** Session files the host can reach for an extension that keeps state beside them. */
export interface HostSessionServices {
  /** Every persisted session the host knows, across projects. */
  list(): Promise<HostSessionSummary[]>;
  open(path: string): HostSessionFile;
  /** Opens a runtime for a session file the extension created; `previousSessionFile` names what it continues. */
  prepare(session: HostSessionFile, options?: { previousSessionFile?: string }): Promise<HostPreparedThread>;
  /**
   * Creates a thread in a project, indexes it and delivers its first prompt.
   * The thread never competes for the screen, so the user keeps the thread
   * they are reading; it resolves once the thread exists, not when it answers.
   */
  start(options: HostThreadStartOptions): Promise<HostStartedThread>;
  /**
   * Deletes a persisted thread into the trash, the verb behind a rail's
   * "delete thread": its runtime is released, a Pi session file moves to
   * `<userData>/thread-trash/`, a thread of another backend hands its shell
   * record over (`removeThread` on its provider), and the index is
   * republished without it. Nothing is gone yet: `restore` puts it back, and
   * only the purge after the retention period (30 days;
   * `TAU_THREAD_TRASH_RETENTION_MS` for a test) or `purge` removes it and runs
   * `threadDeleted`. The thread on screen and a running one are refused.
   */
  remove(sessionId: string): Promise<void>;
  /** Puts a deleted thread back where it was and republishes the index. */
  restore(sessionId: string): Promise<void>;
  /** The deleted threads that can still be restored, newest first. */
  trash(): Promise<HostTrashedThread[]>;
  /** Removes a deleted thread for good now and runs `threadDeleted`. */
  purge(sessionId: string): Promise<void>;
  /** Serializes with the host's own thread lifecycle work (open, switch, fork). */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Rescans persisted sessions and returns the index update. The sweep runs inside, so release any lease first. */
  refreshIndex(): Promise<HostUpdate>;
}

/** Work an extension wraps around a thread becoming visible; core commits after activation and rolls back when it fails. */
export interface HostActivationTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface HostSessionSweep {
  sessions: HostSessionSummary[];
  liveThreads: HostThread[];
  /** Roots of every project the host remembers, including ones without sessions. */
  projectPaths: string[];
  /** Sessions whose files disappeared since the last sweep. */
  deleted: Array<{ sessionId: string; cwd: string }>;
}

/** Why the host left a workspace: it opened another one, or it is stopping. */
export type HostWorkspaceCloseReason = "switch" | "shutdown";

/**
 * Where an extension may step into the thread lifecycle. Every hook is
 * optional; a failure is the caller's failure, so a hook that cannot repair
 * what it found must throw.
 */
export interface HostThreadLifecycle {
  /** Before a workspace's first thread opens: startup, project switch. */
  beforeWorkspace?(cwd: string): Promise<void>;
  /**
   * After the host left a workspace and before `beforeWorkspace` of the next
   * one: `"switch"` for a project change, `"shutdown"` for every workspace the
   * host still had open when it stopped. Nothing of that workspace is opened
   * again without a `beforeWorkspace` first, so this is where what belongs to
   * it — shells, watchers, caches — is released.
   */
  afterWorkspaceClose?(cwd: string, reason: HostWorkspaceCloseReason): Promise<void>;
  /**
   * A thread is gone for good: purged from the trash, or its session file
   * disappeared. A thread in the trash is not gone yet. Runtime eviction is
   * not deletion — `HostTurnObserver.closed` is that.
   */
  threadDeleted?(sessionId: string, cwd: string): Promise<void>;
  /** Before a runtime is built for a session file. */
  beforeOpen?(session: HostSessionFile): Promise<void>;
  /** After a fork wrote its session file and before that file's runtime opens. */
  afterFork?(source: HostThread, target: HostSessionFile): Promise<void>;
  /** Before a thread is put on screen. */
  beforeActivate?(thread: HostThread): Promise<HostActivationTransaction | undefined>;
  /** Periodic pass over every persisted session the host indexes. */
  sweep?(sweep: HostSessionSweep): Promise<void>;
}

/**
 * Turn boundaries of a thread the host drives. `turnId` is the host's id for
 * one prompt; Pi's own events follow through the runtime extension.
 */
export interface HostTurnObserver {
  /** A prompt was accepted; `deferBefore` when it queues behind a running turn. */
  accepted?(sessionId: string, turnId: string, options: { deferBefore: boolean; expectsInput?: boolean }): void;
  /** An idle prompt is about to start; runs before the runtime begins. */
  prepare?(sessionId: string, turnId: string): Promise<void>;
  /** The prompt was refused before its turn started. */
  cancelled?(sessionId: string, turnId: string): Promise<void>;
  /** The prompt's run ended; an observer drops what it prepared for a turn that never started. */
  ended?(sessionId: string, turnId: string, outcome: "completed" | "failed"): Promise<void>;
  /** Work still pending for the thread; a thread with pending work is not released. */
  pending?(sessionId: string): number;
  /** The thread's runtime was rebound; live state starts over. */
  reset?(sessionId: string): Promise<void>;
  /** The thread's runtime closes; flush and release. */
  closed?(sessionId: string): Promise<void>;
  /** A tool call of the thread finished; `cwd` is the checkout it may have changed. */
  toolEnded?(sessionId: string, tool: UiToolRun, cwd: string): void;
}

/** Which door a client came through: the window's own IPC, or the host socket. */
export type HostClientTransport = "electron" | "socket";

/** What the host knows about one attached client, all of it plain data. */
export interface HostClientInfo {
  readonly id: string;
  readonly transport: HostClientTransport;
  /** The client profile it claimed in its hello (`desktop`, `web`, `compact`); absent when it claimed none. */
  readonly profile?: string;
}

/**
 * Clients coming and going. A kit reads this to know whether anybody is
 * watching — to raise a notification, or to hold background work until
 * somebody is.
 */
export interface HostClientObserver {
  attached?(clientId: string, client: HostClientInfo): void;
  detached?(clientId: string): void;
}

/** Who is attached right now, and word when that changes. */
export interface HostClientServices {
  observe(observer: HostClientObserver): () => void;
  count(): number;
}

export interface RuntimeSessionInfo {
  sessionId: string;
  cwd: string;
}

/** A Pi extension factory that also learns which session it serves. */
export type RuntimeExtensionFactory = (pi: Parameters<ExtensionFactory>[0], session: RuntimeSessionInfo) => ReturnType<ExtensionFactory>;

/** The Pi terminal that owns a thread while Tau is attached to it. */
export interface HostAttachedRuntime {
  readonly sessionId: string;
  /** Runs a command of the extension's counterpart inside that Pi; it answers with whatever it returns. */
  invoke(extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

export interface RuntimeSettingsView {
  global: unknown;
  project: unknown;
}

export interface RuntimeExtensionOptions {
  /** Decides per runtime, from Pi's settings, whether the extension loads at all. */
  enabledFor?: (settings: RuntimeSettingsView) => boolean;
  /**
   * Interaction modes this extension gives Pi threads, e.g. `plan`. A Pi thread
   * offers every mode an extension declares; the extension reads the thread's
   * mode from its session (`threadModeFromEntries`) and does what it means.
   */
  modes?: readonly string[];
}

export interface RuntimeExtensionContribution extends RuntimeExtensionOptions {
  name: string;
  factory: RuntimeExtensionFactory;
}

/** Every mode the registered runtime extensions give Pi threads, once each. */
export function runtimeExtensionModes(contributions: readonly RuntimeExtensionContribution[]): string[] {
  return [...new Set(contributions.flatMap((contribution) => contribution.modes ?? []))].filter((mode) => mode !== "default");
}

/**
 * A Pi tool, offered to the runtimes that are not Pi over the host's local MCP
 * endpoint (ADR 0022). Over MCP `execute` gets no `ExtensionContext`: its last
 * argument is `undefined`, so a tool that reads one must cope without it.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
export type HostMcpTool = ToolDefinition<any, any, any>;

/** The tools a thread's runtime is offered; asked on every list and call, with the thread the credential names. */
export type HostMcpToolProvider = (thread: RuntimeSessionInfo) => readonly HostMcpTool[];

/** One tool call over MCP, as a gate sees it before the tool runs. */
export interface HostMcpToolCall {
  readonly threadId: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** Aborts when the runtime cancels the call or its thread closes. */
  readonly signal: AbortSignal;
  /** Asks the user on the thread's own dialog surface; a cancelled question is `false`. */
  confirm(title: string, message: string): Promise<boolean>;
}

/** Runs before every MCP tool call; an answer with `block` refuses it with that reason. */
export type HostMcpToolGate = (call: HostMcpToolCall) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined;

/** Where a runtime reaches Tau's tools for one thread: the server entry it puts in its own MCP configuration. */
export interface HostMcpConnection {
  /** The server name runtimes show in front of a tool (`mcp__tau__…`). */
  readonly name: string;
  /** Streamable HTTP on 127.0.0.1. */
  readonly url: string;
  /** The thread's bearer credential, bare; `headers` carries it as `Authorization`. */
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Tau's tools for every runtime (ADR 0022). Pi gets tools through
 * `registerRuntimeExtension`; a runtime Tau does not own reaches the same tools
 * through a local MCP endpoint, with a credential bound to one thread.
 */
export interface HostMcpServices {
  /** Offers tools to every thread that connects; the provider sees only the thread the credential names. */
  registerTools(provider: HostMcpToolProvider): () => void;
  /** Runs before each call, in registration order; the first block wins. Access Kit's gate is one. */
  gate(gate: HostMcpToolGate): () => void;
  /**
   * The endpoint and a credential for one thread, for a runtime backend to put
   * in its session's MCP configuration. The credential is revoked when the
   * thread's runtime closes. `undefined` when the host cannot serve MCP.
   */
  connect(thread: RuntimeSessionInfo, options?: HostMcpConnectOptions): Promise<HostMcpConnection | undefined>;
}

export interface HostMcpConnectOptions {
  /**
   * The only tools the thread may list and call, by the names kits register
   * (`tau_spawn_thread`, not `mcp__tau__…`); every tool when absent. A thread
   * whose runtime was started with `tools` passes the same list here.
   */
  tools?: readonly string[];
}

/** What a host extension may do with one open thread. */
export interface HostThread {
  readonly sessionId: string;
  readonly cwd: string;
  readonly backendKind: ThreadBackendKind;
  /** The session file behind the thread, once it has one. */
  readonly sessionFile: string | undefined;
  /** The thread that spawned this one; absent for a thread the user started. */
  readonly parentThreadId?: string;
  /** Tokens and money the thread has used so far; absent when the runtime has no total. */
  readonly usage?: UiThreadUsage;
  /** The model the thread runs on, as its runtime names it; absent before it has one. New in API 1.11.0. */
  readonly model?: { provider: string; id: string };
  isStreaming(): boolean;
  /** Nothing running, queued or asked: the thread can be replaced safely. */
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
  /** False once the host replaced or closed this thread's runtime. */
  isCurrent(): boolean;
  sessionName(): string | undefined;
  transcript(): Promise<UiMessage[]>;
  /** One short answer from a model of the thread's runtime, unrelated to the conversation. */
  complete(provider: string, modelId: string, request: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
  /** The provider API of the thread's active model, e.g. "openai-responses". */
  modelApi(): string | undefined;
  /** Shortcuts Pi extensions registered for this thread's runtime, resolved against the user's keybindings.json. */
  shortcuts(userBindings: PiUserKeybindings): PiShortcut[];
  /** Runs such a shortcut; false when the runtime has none for the chord. */
  runShortcut(keys: string, userBindings: PiUserKeybindings): Promise<boolean>;
  /** Raw entries on the thread's current branch, in order. */
  entries(): readonly unknown[];
  /** Appends a custom entry to the thread's session, the durable seam for extension state. */
  appendEntry(customType: string, data: unknown): void;
}

/** Where Pi's `ctx.ui` asks for a text widget, relative to the composer. */
export type PiUiWidgetPlacement = "aboveEditor" | "belowEditor";

/**
 * Terminal surfaces of Pi's `ctx.ui` a host extension may draw somewhere.
 * A call no presenter handles is reported to the thread log as unsupported.
 */
export interface HostUiPresenter {
  setStatus?(sessionId: string, key: string, text: string | undefined): void;
  setWidget?(sessionId: string, key: string, lines: string[] | undefined, placement: PiUiWidgetPlacement): void;
  setWorkingMessage?(sessionId: string, message: string | undefined): void;
  setFooter?(sessionId: string, lines: string[] | undefined): void;
  setHeader?(sessionId: string, lines: string[] | undefined): void;
  setEditorText?(sessionId: string, text: string): void;
  pasteToEditor?(sessionId: string, text: string): void;
  setToolsExpanded?(sessionId: string, expanded: boolean): void;
  /** The thread's runtime went away; forget what it drew. */
  clear?(sessionId: string): void;
}

/**
 * Files the host watches changed on disk. `kind` names the group — the host's
 * own vocabulary for what it reads — and `paths` what moved inside it.
 */
export interface HostConfigChange {
  kind: string;
  paths: readonly string[];
}

/** One entry of a workspace's skill catalog, as `services.skills` reports it. */
export interface HostSkill {
  name: string;
  description?: string;
}

/**
 * Host-side extension seam. Core owns the workspace, the thread lifecycle and
 * the event channel; a host extension owns a feature and reaches the renderer
 * through commands and events routed by id, never through a core IPC entry.
 */
export interface HostExtensionServices {
  /** The workspace the host currently has open. */
  cwd(): string;
  /**
   * Pi's own configuration directory (`~/.pi/agent`, or what `PI_CODING_AGENT_DIR`
   * names). The path only: reading inside it is ordinary file work, which no
   * permission gates, so this one is ungated too.
   */
  readonly agentDir: string;
  /**
   * Where Tau reads and writes Pi sessions: `PI_CODING_AGENT_SESSION_DIR`
   * when set (a dev instance's scratch store), else Pi's `<agentDir>/sessions`.
   * A package that keeps thread-like state of its own puts it beside this
   * directory, so a test instance never writes into the user's real store.
   */
  readonly sessionsDir: string;
  /**
   * This extension's own folder for state it keeps, `<userData>/kit-state/<id>/`.
   * Nothing creates it until something writes there, and a dev instance's
   * `TAU_USER_DATA` moves it, so a test run never touches the user's own state.
   * The facade the registry starts from carries the root; `activate` binds each
   * extension's folder under it.
   */
  readonly stateDir: string;
  /**
   * The folder of the user's own themes (`~/.tau/themes`, or `TAU_THEMES_DIR`):
   * a theme written here is listed and applied like one the user put there.
   */
  readonly themesDir: string;
  readonly safeMode: boolean;
  log(label: string, detail?: string): void;
  /** Opens a project the way a project switch does; the same path re-activates it. */
  openWorkspace(path: string): Promise<HostActionResult>;
  /** Canonical path of a project the host already admitted, named by workspace id or path; rejects any other. */
  knownWorkspacePath(path: string): Promise<string>;
  /** Identity a client may keep for a workspace the extension found on this host. */
  workspaceRef(path: string): WorkspaceRef;
  /**
   * The same identity, for a folder the extension made on this host for a thread
   * about to start there (a worktree): `knownWorkspacePath` accepts it from now on,
   * before any thread runs in it.
   */
  admitWorkspace(path: string): WorkspaceRef;
  projectName(cwd: string): Promise<string>;
  rememberProjectName(cwd: string, name: string): void;
  /** Native folder picker of the host platform; resolves undefined when cancelled. */
  pickDirectory(options?: DirectoryPickerOptions): Promise<string | undefined>;
  /** Whether Tau or an attached Pi terminal owns the active runtime. */
  runtimeOwner(): "tau" | "pi";
  /** An open thread by id, or the active one; `undefined` when it is not open. */
  thread(sessionId?: string): HostThread | undefined;
  /**
   * One short answer for a small job of the extension's own — a title, a
   * branch name, a commit message. It runs on the user's Pi model
   * configuration, so it does not depend on which runtime owns the visible
   * thread; without a model it uses the default from `~/.pi/agent`.
   */
  complete(request: CompletionRequest, model?: { provider: string; id: string }): Promise<string>;
  /** The models `complete` can be asked for: the user's Pi catalog, those with a key or a login. Absent before API 1.11.0. */
  completionModels?(): Promise<UiModel[]>;
  /** Renames a thread the way the title menu does, and publishes the change. */
  setThreadTitle(sessionId: string, title: string, source: "generated" | "renamed"): Promise<void>;
  /** The Pi terminal owning a thread while Tau is attached; `undefined` when Tau runs it. */
  attachedRuntime(sessionId?: string): HostAttachedRuntime | undefined;
  /** Supplies what the thread index shows about a project: its name, a label, whether it is nested in another. */
  describeProjects(facts: HostProjectFacts): () => void;
  /** Counts a child process the extension spawned, for the host's lifecycle metrics. */
  noteSubprocess(): void;
  /** Absolute path of a command on the host's PATH (the login shell's, see `shell-environment.ts`), or undefined. */
  findCommand(name: string): string | undefined;
  /** The skills a workspace offers, the catalog the composer lists; a runtime backend publishes them as its own commands. */
  skills(cwd: string): readonly HostSkill[];
  /**
   * Re-reads the extension packages of this workspace and starts, restarts or
   * stops their halves to match what is on disk and granted. It needs no
   * permission because it can only apply the user's own answers: a package
   * without a grant is still never imported.
   */
  refreshExtensionPackages(): Promise<void>;
  /** Every source the two `packages.json` files name, with the package it resolved to. */
  listPackages(): Promise<InstalledPackage[]>;
  /**
   * Fetches a source, checks that it is a package and records it. Nothing is
   * activated: the permission grant still decides that. `progress` gets one
   * line per step of a fetch that may run for minutes.
   */
  installPackage(source: string, scope: PackageScope, progress?: (message: string) => void): Promise<InstalledPackage>;
  removePackage(source: string, scope: PackageScope): Promise<PackageRemoval>;
  /** Re-fetches one source, or every source both files list. */
  updatePackages(source?: string, progress?: (message: string) => void): Promise<InstalledPackage[]>;
  readonly sessions: HostSessionServices;
  /**
   * The clients attached to this host. Ungated: it reports how many there are,
   * which transport each came through and which profile it claimed, and
   * nothing about what they see.
   */
  readonly clients: HostClientServices;
  /** Steps into thread opening, forking, activation and the index sweep. */
  registerThreadLifecycle(lifecycle: HostThreadLifecycle): () => void;
  /** Follows the turns of every thread the host drives. */
  registerTurnObserver(observer: HostTurnObserver): () => void;
  /**
   * Entries an extension attaches rows to. A text-empty assistant message stays
   * in the transcript when a provider names its entry, so the row has a place.
   */
  pinTranscriptEntries(provider: (thread: HostThread) => Iterable<string>): () => void;
  /** Loads a Pi extension into every runtime the host creates from now on. */
  registerRuntimeExtension(name: string, factory: RuntimeExtensionFactory, options?: RuntimeExtensionOptions): () => void;
  /**
   * A Pi extension Tau ships as one of its own npm dependencies, resolved from
   * the host's modules. A package whose files must stay where npm put them —
   * native binaries a driver launches, for instance — cannot be copied into a
   * kit's bundle, so the host loads it and the kit registers what it gets back.
   */
  loadRuntimeExtension(packageName: string): Promise<RuntimeExtensionFactory>;
  /** Tau's tools for the runtimes that are not Pi, over a local MCP endpoint (ADR 0022). */
  readonly mcp: HostMcpServices;
  /**
   * A module from Tau's own npm dependencies, resolved from the host's modules
   * for the same reason: a native addon finds its binary beside itself only
   * where npm put it. A CommonJS module answers with its `module.exports`.
   */
  loadDependency(packageName: string): Promise<unknown>;
  /**
   * Runs a command in this extension's window half — the part of a kit that
   * needs the process the user's window lives in (ADR 0021). Rejects when the
   * host has no such client, so a kit can fall back or say so.
   */
  callClient(command: string, input?: unknown): Promise<unknown>;
  /**
   * Follows the files the host watches. The host re-reads none of them for a
   * kit and calls no kit by name: it reports what moved, and whoever owns those
   * files decides what to do — the keybindings kit re-reads `keybindings.json`,
   * a themes kit its folder. Off when watching is.
   */
  observeConfigChanges(listener: (change: HostConfigChange) => void): () => void;
  /** Lets an extension annotate Pi dialogs before the workbench sees them. */
  decorateUiPrompt(decorator: (prompt: ExtensionUiPrompt) => void): () => void;
  /** What the user lets external runtimes do; `undefined` restores full access. */
  setPermissionLevel(provider: (() => RuntimePermissionLevel) | undefined): void;
  /** Adds a runtime backend threads can be created with (ADR 0005); its kind names the backend. */
  registerRuntimeBackend(provider: HostRuntimeBackendProvider): () => void;
  /** Draws what Pi extensions put on terminal surfaces (status, widgets, working message). */
  presentUi(presenter: HostUiPresenter): () => void;
}

export type HostExtensionCommandHandler = (input: unknown) => unknown;

export interface HostExtensionCommandOptions {
  /** Commands that may be called by these host extension IDs. */
  callers?: readonly string[];
  /** Commands that may run for minutes and therefore use the host job path. */
  long?: boolean;
}

export interface HostExtensionInvocationContext {
  /** Opaque host-issued identity for this activation, useful for diagnostics. */
  readonly id: string;
  /** Calls are bound to the extension activation that received this context. */
  invoke(extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

// A kit reaches these through `tau/host-extension`; they live in a leaf module
// so importing one does not pull the registry into a kit's bundle.
// The package manager's vocabulary. A kit that manages packages needs the row
// shape and the scope name; both are plain data, so they travel as types only.
export type { InstalledExtension as InstalledPackage, RemovalResult as PackageRemoval } from "./extension-installer.js";
export type { PackageScope } from "./extension-sources.js";

export interface HostExtensionContext {
  readonly id: string;
  /** Opaque identity minted by the host for this activation. */
  readonly invocationContextId: string;
  readonly services: HostExtensionServices;
  /** Calls another host entry through a host-bound caller context. */
  readonly invokeHostExtension: HostExtensionInvocationContext["invoke"];
  /**
   * `long: true` marks a command that may run for minutes (a repository copy,
   * a build): it skips the command timeout and clients run it as a host job.
   */
  registerCommand(name: string, handler: HostExtensionCommandHandler, options?: HostExtensionCommandOptions): () => void;
  /** Publishes an `extension-event` for this extension's desktop counterpart. */
  emit(name: string, payload?: unknown): void;
  /**
   * Reports a failure the extension cannot recover from, after activation: the
   * registry records the reason and deactivates it. An isolated package uses
   * this when its worker dies.
   */
  fail(reason: string): void;
}

export interface HostExtension {
  id: string;
  name: string;
  permissions?: readonly string[];
  /** Where the extension runs; a bundled kit is in-process by construction. */
  isolation?: ExtensionIsolation;
  activate(context: HostExtensionContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export function guardedServices(
  services: HostExtensionServices,
  permissions?: readonly string[],
  extensionId: string = "unknown",
): HostExtensionServices {
  if (permissions === undefined) return services;
  const allowed = new Set(permissions);

  return new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in HOST_SERVICE_PERMISSIONS) {
        const required = HOST_SERVICE_PERMISSIONS[prop];
        if (required && !allowed.has(required)) {
          const message = `Extension ${extensionId} lacks permission ${required}`;
          services.log("host-extension.denied", message);
          // A denied service is an authorization answer, not a broken command.
          // Keep it out of the registry's handler-crash counter; the denial is
          // already recorded above and the caller still receives the reason.
          throw new HostCommandError(message);
        }
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

/** What one extension sees: the permission guard, with `stateDir` bound to its own folder. */
export function extensionServices(services: HostExtensionServices, extension: Pick<HostExtension, "id" | "permissions">): HostExtensionServices {
  const guarded = guardedServices(services, extension.permissions, extension.id);
  const stateDir = services.stateDir ? join(services.stateDir, extension.id) : undefined;
  // `callClient` reaches one extension's own window half: the id is bound
  // here, never passed by the caller, so no kit can drive another kit's.
  const callClient = (command: string, input?: unknown): Promise<unknown> =>
    (services.callClient as unknown as (id: string, command: string, input?: unknown) => Promise<unknown>)(extension.id, command, input);
  return new Proxy(guarded, {
    get: (target, prop, receiver) => {
      if (prop === "callClient") return callClient;
      if (prop === "stateDir" && stateDir) return stateDir;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

interface ActiveHostExtension {
  extension: HostExtension;
  invocationContextId: string;
  commands: Map<string, HostExtensionCommandHandler>;
  longCommands: Set<string>;
  commandCallers: Map<string, ReadonlySet<string>>;
  disposers: Array<() => void | Promise<void>>;
  /** Set once the extension reported a failure it cannot recover from. */
  fatal?: string;
}

export interface HostExtensionRegistryOptions {
  commandTimeoutMs?: number;
}

export class HostExtensionRegistry {
  private readonly active = new Map<string, ActiveHostExtension>();
  private readonly known = new Map<string, HostExtension>();
  /** Host-issued contexts are valid only while their activation is alive. */
  private readonly invocationContexts = new Map<string, { extensionId: string; record?: ActiveHostExtension }>();
  private readonly failures = new Map<string, string>();
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly services: HostExtensionServices,
    private readonly publish: (event: GlobalHostEvent) => void,
    private readonly options: HostExtensionRegistryOptions = {},
  ) {}

  addKnown(extension: HostExtension): void {
    this.known.set(extension.id, extension);
  }

  /** Activates one extension; a failure is recorded and reported, never thrown. */
  async activate(extension: HostExtension): Promise<boolean> {
    if (!EXTENSION_ID.test(extension.id)) {
      this.failures.set(extension.id, `invalid host extension id "${extension.id}"`);
      return false;
    }
    await this.deactivate(extension.id);
    this.known.set(extension.id, extension);
    this.failures.delete(extension.id);
    this.clearCommandFailures(extension.id);
    const invocationContextId = randomUUID();
    const record: ActiveHostExtension = {
      extension,
      invocationContextId,
      commands: new Map(),
      longCommands: new Set(),
      commandCallers: new Map(),
      disposers: [],
    };
    this.invocationContexts.set(invocationContextId, { extensionId: extension.id, record });
    const context: HostExtensionContext = {
      id: extension.id,
      invocationContextId,
      services: extensionServices(this.services, extension),
      invokeHostExtension: (extensionId, command, input) => this.invoke(
        extensionId,
        command,
        input,
        { kind: "host-extension", contextId: invocationContextId },
      ),
      registerCommand: (name, handler, options) => {
        if (!COMMAND_NAME.test(name)) throw new Error(`Host extension ${extension.id}: invalid command name "${name}"`);
        if (record.commands.has(name)) throw new Error(`Host extension ${extension.id}: command "${name}" registered twice`);
        const callers = options?.callers?.map((caller) => {
          if (!EXTENSION_ID.test(caller)) throw new Error(`Host extension ${extension.id}: invalid caller id "${caller}"`);
          return caller;
        }) ?? [];
        record.commands.set(name, handler);
        if (options?.long) record.longCommands.add(name);
        record.commandCallers.set(name, new Set(callers));
        const dispose = () => {
          if (record.commands.get(name) !== handler) return;
          record.commands.delete(name);
          record.commandCallers.delete(name);
          record.longCommands.delete(name);
        };
        record.disposers.push(dispose);
        return dispose;
      },
      emit: (name, payload) => {
        if (this.active.get(extension.id) !== record) return;
        this.publish({ type: "extension-event", extensionId: extension.id, name, payload });
      },
      fail: (reason) => this.reportFatal(extension, record, reason),
    };
    try {
      const dispose = await extension.activate(context);
      if (dispose) record.disposers.push(dispose);
      if (record.fatal) throw new Error(record.fatal);
      this.active.set(extension.id, record);
      this.services.log("host-extension.activated", `${extension.name} · ${[...record.commands.keys()].join(", ") || "no commands"}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(extension.id, message);
      this.invocationContexts.delete(invocationContextId);
      await this.disposeAll(record.disposers).catch(() => undefined);
      this.services.log("host-extension.failed", `${extension.name}: ${message}`);
      return false;
    }
  }

  /** An extension that cannot go on: the reason is kept and the extension stops. */
  private reportFatal(extension: HostExtension, record: ActiveHostExtension, reason: string): void {
    if (record.fatal) return;
    record.fatal = reason;
    this.failures.set(extension.id, reason);
    this.services.log("host-extension.failed", `${extension.name}: ${reason}`);
    if (this.active.get(extension.id) === record) {
      this.announceDeactivation(extension, reason);
      void this.deactivate(extension.id).catch(() => undefined);
    }
  }

  /**
   * The one place a deactivation the user did not ask for is announced, so a
   * client can raise exactly one toast for it. A failure during `activate` is
   * not one of these: nothing was running yet, and `summaries()` carries it.
   */
  private announceDeactivation(extension: HostExtension, reason: string): void {
    this.publish({ type: "extension-deactivated", extensionId: extension.id, name: extension.name, reason });
  }

  /** Re-activates an extension the registry knows, after `deactivate`. */
  async activateKnown(id: string): Promise<boolean> {
    const extension = this.known.get(id);
    if (!extension) throw new Error(`Host extension ${id} is not installed.`);
    return this.activate(extension);
  }

  /** Forgets an extension entirely, e.g. when its package left the disk. */
  async remove(id: string): Promise<void> {
    await this.deactivate(id);
    this.known.delete(id);
    this.failures.delete(id);
    this.clearCommandFailures(id);
  }

  /** Removes every per-command failure counter belonging to an extension. */
  private clearCommandFailures(extensionId: string): void {
    const prefix = `${extensionId}/`;
    for (const key of [...this.consecutiveFailures.keys()]) {
      if (key.startsWith(prefix)) this.consecutiveFailures.delete(key);
    }
  }

  async deactivate(id: string): Promise<void> {
    const record = this.active.get(id);
    if (!record) return;
    this.active.delete(id);
    this.invocationContexts.delete(record.invocationContextId);
    await this.disposeAll(record.disposers);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  private async runWithTimeout<T>(fn: () => T | Promise<T>, timeoutMs: number, command: string): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
      }, { once: true });
    });

    return Promise.race([
      Promise.resolve().then(() => fn()),
      timeoutPromise,
    ]);
  }

  async invoke(
    extensionId: string,
    command: string,
    input?: unknown,
    principal: HostInvocationPrincipal = HOST_CORE_PRINCIPAL,
  ): Promise<unknown> {
    const record = this.active.get(extensionId);
    if (!record) {
      const known = this.known.get(extensionId);
      throw new Error(known
        ? `Host extension ${known.name} is not active.`
        : `Host extension ${extensionId} is not installed.`);
    }
    const handler = record.commands.get(command);
    if (!handler) throw new Error(`Host extension ${record.extension.name} has no command "${command}".`);
    this.authorize(record, extensionId, command, principal);

    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    // The counter is keyed by command so that a healthy command cannot mask an
    // unstable sibling: three consecutive failures of *this* command deactivate
    // the extension, not three of any command.
    const commandKey = `${extensionId}/${command}`;
    try {
      const result = record.longCommands.has(command)
        ? await handler(input)
        : await this.runWithTimeout(() => handler(input), timeoutMs, command);
      this.consecutiveFailures.delete(commandKey);
      return result;
    } catch (error) {
      // An answer to bad input is not a broken command: it neither counts
      // nor resets, so a real crash between two of them is still noticed.
      if (isExpectedCommandError(error)) throw error;
      const isTimeout = error instanceof Error && error.message.includes(`timed out after ${timeoutMs}ms`);
      const failures = (this.consecutiveFailures.get(commandKey) ?? 0) + 1;
      this.consecutiveFailures.set(commandKey, failures);

      if (isTimeout || failures >= 3) {
        // The reason names no extension: it is read beside the name, in a
        // summary row and in the client's toast.
        const reason = isTimeout
          ? `command "${command}" timed out after ${timeoutMs}ms`
          : `failed three times in a row — ${error instanceof Error ? error.message : String(error)}`;
        this.failures.set(extensionId, reason);
        this.services.log("host-extension.failed", `${record.extension.name}: ${reason}`);
        this.announceDeactivation(record.extension, reason);
        await this.deactivate(extensionId);
      }
      throw error;
    }
  }

  /** Checks a host-issued caller before target lookup or handler execution. */
  private authorize(record: ActiveHostExtension, extensionId: string, command: string, principal: HostInvocationPrincipal): void {
    if (principal.kind === "host-core" || principal.kind === "workbench-client") return;
    const context = principal.kind === "host-extension" ? this.invocationContexts.get(principal.contextId) : undefined;
    const caller = context?.extensionId;
    const allowed = caller === extensionId || Boolean(caller && record.commandCallers.get(command)?.has(caller));
    if (allowed) return;
    const reason = context
      ? "the host-issued context has no grant for this target command"
      : "the host-issued context is unknown or expired";
    const details = {
      caller: caller ?? "unknown",
      target: extensionId,
      command,
      capability: `${extensionId}/${command}`,
      reason,
    } as const;
    this.services.log("host-extension.denied", JSON.stringify(details));
    throw new HostAuthorizationError(details);
  }

  /** Long commands of every active extension, as `<extensionId>/<command>`. */
  longCommands(): string[] {
    return [...this.active.values()].flatMap((record) => [...record.longCommands].map((command) => `${record.extension.id}/${command}`)).sort();
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
        isolation: extension.isolation ?? "in-process",
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

/** Fans one lifecycle step out to every registered hook, in registration order. */
export class HostThreadLifecycleSet {
  private readonly hooks = new Set<HostThreadLifecycle>();

  add(hook: HostThreadLifecycle): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }

  async beforeWorkspace(cwd: string): Promise<void> {
    for (const hook of [...this.hooks]) await hook.beforeWorkspace?.(cwd);
  }

  /** One hook that cannot let go must not keep the next workspace from opening. */
  async afterWorkspaceClose(cwd: string, reason: HostWorkspaceCloseReason): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.afterWorkspaceClose?.(cwd, reason); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Workspace close failed");
  }

  /** The thread is already gone, so every hook gets its turn whatever the others do. */
  async threadDeleted(sessionId: string, cwd: string): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.threadDeleted?.(sessionId, cwd); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Thread deletion cleanup failed");
  }

  async beforeOpen(session: HostSessionFile): Promise<void> {
    for (const hook of [...this.hooks]) await hook.beforeOpen?.(session);
  }

  async afterFork(source: HostThread, target: HostSessionFile): Promise<void> {
    for (const hook of [...this.hooks]) await hook.afterFork?.(source, target);
  }

  /** One transaction over every hook's; a hook failing rolls back the ones before it. */
  async beforeActivate(thread: HostThread): Promise<HostActivationTransaction | undefined> {
    const transactions: HostActivationTransaction[] = [];
    for (const hook of [...this.hooks]) {
      try {
        const transaction = await hook.beforeActivate?.(thread);
        if (transaction) transactions.push(transaction);
      } catch (error) {
        await rollbackAll(transactions).catch(() => undefined);
        throw error;
      }
    }
    if (transactions.length === 0) return undefined;
    return {
      commit: async () => { for (const transaction of transactions) await transaction.commit(); },
      rollback: () => rollbackAll(transactions),
    };
  }

  async sweep(sweep: HostSessionSweep): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.sweep?.(sweep); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Session sweep failed");
  }
}

async function rollbackAll(transactions: readonly HostActivationTransaction[]): Promise<void> {
  const errors: unknown[] = [];
  for (const transaction of [...transactions].reverse()) {
    try { await transaction.rollback(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Activation rollback failed");
}

/** Fans turn boundaries out to every observer; pending work is the sum of theirs. */
export class HostTurnObserverSet {
  private readonly observers = new Set<HostTurnObserver>();

  add(observer: HostTurnObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  accepted(sessionId: string, turnId: string, options: { deferBefore: boolean; expectsInput?: boolean }): void {
    for (const observer of [...this.observers]) observer.accepted?.(sessionId, turnId, options);
  }

  async prepare(sessionId: string, turnId: string): Promise<void> {
    for (const observer of [...this.observers]) await observer.prepare?.(sessionId, turnId);
  }

  async cancelled(sessionId: string, turnId: string): Promise<void> {
    for (const observer of [...this.observers]) await observer.cancelled?.(sessionId, turnId);
  }

  async ended(sessionId: string, turnId: string, outcome: "completed" | "failed"): Promise<void> {
    for (const observer of [...this.observers]) await observer.ended?.(sessionId, turnId, outcome);
  }

  pending(sessionId: string): number {
    let total = 0;
    for (const observer of this.observers) total += observer.pending?.(sessionId) ?? 0;
    return total;
  }

  async reset(sessionId: string): Promise<void> {
    for (const observer of [...this.observers]) await observer.reset?.(sessionId);
  }

  toolEnded(sessionId: string, tool: UiToolRun, cwd: string): void {
    for (const observer of [...this.observers]) observer.toolEnded?.(sessionId, tool, cwd);
  }

  /** Every observer gets to close; failures are reported together afterwards. */
  async closed(sessionId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const observer of [...this.observers]) {
      try { await observer.closed?.(sessionId); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Turn observer shutdown failed");
  }
}

/** Asks every provider in turn; the first defined answer wins. */
export class HostProjectFactsSet {
  private readonly providers = new Set<HostProjectFacts>();

  add(facts: HostProjectFacts): () => void {
    this.providers.add(facts);
    return () => { this.providers.delete(facts); };
  }

  async name(cwd: string): Promise<string | undefined> {
    for (const facts of [...this.providers]) {
      const value = await facts.name?.(cwd);
      if (value) return value;
    }
    return undefined;
  }

  async label(cwd: string): Promise<string | undefined> {
    for (const facts of [...this.providers]) {
      const value = await facts.label?.(cwd);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async nested(cwd: string): Promise<boolean> {
    for (const facts of [...this.providers]) {
      if (await facts.nested?.(cwd)) return true;
    }
    return false;
  }
}
