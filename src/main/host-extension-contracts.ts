/** Public host extension contracts. Imports here are types only; runtime registration lives separately. */
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { UiHostEndpoint, UiNetworkAccess } from "../shared/connections.js";
import type {
  ClientTurnIdentity,
  ExtensionPackageSummary,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  PackageBuild,
  RuntimeToolVersion,
  ThreadBackendKind,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiMessage,
  UiModel,
  UiProject,
  UiPromptAttachment,
  UiRuntimeBackend,
  UiRuntimeCatalog,
  UiRuntimeToolsState,
  UiSession,
  UiSkillDraft,
  UiThreadOrigin,
  UiThreadUsage,
  UiToolRun,
  UiWake,
} from "../shared/contracts.js";
import type { ExtensionIsolation } from "../shared/extension-permissions.js";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol.js";
import type { RuntimeReadiness } from "../shared/host-resources.js";
import type { HostPushEvent } from "../shared/host-transport.js";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
import type { HostMachine } from "../shared/machine-protocol.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type { RuntimeToolMaintenance } from "./cli-install.js";
import type { InstalledExtension as InstalledPackage, RemovalResult as PackageRemoval } from "./extension-installer.js";
import type { PackageScope } from "./extension-sources.js";
import type { HostBrowserResources } from "./host-browser-resources.js";
import type { HostExecutionPolicy, HostExecutionPolicyServices } from "./host-execution-policy.js";
import type { HostMachineRoutingPolicy } from "./host-machine-routing.js";
import type { HostModelAuthServices } from "./model-auth.js";
import type { PackageReview } from "./package-approval.js";
import type { AgentRuntimeAdapter, RuntimePermissionLevel } from "./runtime-adapters.js";
import type { CompletionRequest, ThreadBackgroundCapability, ThreadRuntimeBackend, ThreadRuntimeEvent } from "./runtime-types.js";
import type { PricedUsage, UsageTally } from "./usage-pricing.js";
export type { HostMachine, HostMachineStatus } from "../shared/machine-protocol.js";
export type { HostBrowserResourceHandler, HostBrowserResources, SandboxFrameDocument } from "./host-browser-resources.js";
export type { HostMachineRoutingAdapter, HostMachineRoutingContext, HostMachineRoutingPolicy } from "./host-machine-routing.js";

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
  callClient?(extensionId: string, command: string, input?: unknown, options?: HostClientCallOptions): Promise<unknown>;
  /** The id of the window on the host's machine a call with `{ window: "host" }` reaches now. */
  clientWindow?(extensionId: string): string | undefined;
  /** Native consent for granting a package: the dialog's answer, or undefined where no native window can ask (ADR 0036). */
  confirmExtensionGrant?(pkg: ExtensionPackageSummary): Promise<boolean | undefined>;
}

/**
 * Which window `callClient` asks (API 1.13.0). `"host"`: a Tau window on the
 * host's own machine — the caller's, when it is one, else the newest — never
 * a window on another device. A window id from `clientWindow()`: exactly that
 * window, whoever the caller is; the call rejects at once once it is gone.
 */
export interface HostClientCallOptions {
  window?: "host" | (string & {});
}

/** A thread an external backend persisted, as the index lists it. */
export interface HostBackendThreadRecord {
  threadId: string;
  cwd: string;
  title?: string;
  /** When the thread began; the rail orders active threads by it. New in API 1.54.0. */
  createdAt?: number;
  updatedAt: number;
  /** Visible messages, enough for a title and a count. */
  messages: ReadonlyArray<Pick<UiMessage, "role" | "text">>;
  /** A count without loading the transcript. New in API 1.42.0. */
  messageCount?: number;
  /** The home machine of a proxy thread and its runtime marks. New in API 1.42.0. */
  machine?: UiSession["machine"];
  /** The workspace identity supplied by the backend's home host. New in API 1.44.0. */
  workspace?: WorkspaceRef;
  /** Project presentation from the home host, including the root icon for a worktree. */
  project?: Pick<UiProject, "name" | "icon"> & { listed?: boolean };
  /** The model it last ran on, for its row before it opens; else the row shows `modelProvider` (API 1.24.0). */
  model?: Pick<UiModel, "provider" | "id">;
  /**
   * What it was billed for, from the backend's own store; the index prices it
   * like a Pi thread's, so a thread that is not open shows its cost (API 1.30.0).
   */
  usage?: readonly UsageTally[];
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
  /** Withdraws this thread's pending questions when its runtime exits. API 1.61.0. */
  cancelPrompts?(): void;
  /**
   * The thread's total from its tallies, priced as core prices every thread,
   * for `catalogView().usage`. Prices can change under a thread, so ask on
   * each read. Absent before API 1.12.0.
   */
  priceUsage?(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
  /**
   * What the thread's project lets its commands reach, merged from every
   * provider (`services.executionPolicy`). Ask before each turn: the user can
   * lift or set a limit while the thread lives. A backend that cannot hold its
   * commands to a limit refuses the prompt (`executionPolicyRefusal`). New in
   * API 1.14.0.
   */
  executionPolicy?(): Promise<HostExecutionPolicy>;
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
  /**
   * Where the backend sits in every runtime list (pickers, Providers,
   * onboarding), after Pi; lower first, unset last. The bundled kits use
   * 10, 20 and 30 (API 1.11.0).
   */
  readonly order?: number;
  /** Lists existing threads but stays out of new-thread runtime pickers. New in API 1.42.0. */
  readonly hidden?: true;
  readonly adapter: AgentRuntimeAdapter;
  /** Provider identity used for the thread index when the backend has no selectable model. */
  readonly modelProvider?: string;
  /**
   * Model providers the runtime owns (Codex: `openai`): beside one of them its
   * own mark stands alone. A provider of the runtime's own name is one without
   * saying so (API 1.24.0).
   */
  readonly homeProviders?: readonly string[];
  /**
   * A subscription here is the runtime's own plan (Cursor's), not the model
   * provider's, so a model keeps its provider's mark (API 1.24.0).
   */
  readonly ownPlan?: boolean;
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
   * How the program is installed and the commands that keep it current
   * (`cliMaintenance` builds it); the host runs them when the user keeps
   * agent tools up to date. Asked on the host's schedule, never by a client.
   */
  maintenance?(): Promise<RuntimeToolMaintenance | undefined>;
  /**
   * Changes whenever the program does (`executableFingerprint`): a catalog
   * held for another key is asked again, so an updated CLI's models show at once.
   */
  programKey?(): Promise<string | undefined>;
  /**
   * The models and thinking levels a new thread may start with, without
   * opening one. The host asks in the background and keeps the answer on
   * disk, so it may spawn the program; it asks again when a client opens a
   * picker and the answer is some minutes old. The chosen pair reaches the
   * thread through `catalogWrite` right after `open`.
   */
  newThreadCatalog?(): Promise<HostRuntimeNewThreadCatalog | undefined>;
}

/**
 * A backend's answer to `newThreadCatalog`; the host adds the kind, the
 * adapter's capabilities and `checkedAt`, and fills price, context and
 * input facts it knows from Pi's model data for what a model leaves out.
 */
export type HostRuntimeNewThreadCatalog = Omit<UiRuntimeCatalog, "kind" | "runtimeCapabilities" | "checkedAt" | "models"> & {
  models: HostCatalogModel[];
};

/** A model as a backend names it; `apiModelId` is the provider's own id when `id` is an alias (`opus` → `claude-opus-5`). */
export type HostCatalogModel = UiModel & { apiModelId?: string };

/**
 * Facts an extension knows about a project folder. Core caches them, refreshes
 * the label in the background and publishes changes with the thread index.
 */
export interface HostProjectFacts {
  /** True for a private thread workspace, which is never remembered as a project. */
  projectless?(cwd: string): Promise<boolean>;
  /** Display name of a project; undefined keeps the folder name. */
  name?(cwd: string): Promise<string | undefined>;
  /** Short label shown beside the project (Workspace Kit: the Git branch). */
  label?(cwd: string): Promise<string | undefined>;
  /** True for a secondary checkout of another project; it is not listed as a project of its own. */
  nested?(cwd: string): Promise<boolean>;
  /** The project a nested checkout belongs to, whose settings it follows (API 1.59.0); undefined for a project of its own. */
  root?(cwd: string): Promise<string | undefined>;
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
  /** The machine and thread an imported session came from; only the sweep reads it. */
  origin?: UiThreadOrigin;
}

/** A thread an extension asks the host to run for it, off screen. */
export interface HostThreadStartOptions {
  /** Project the thread runs in. */
  cwd: string;
  /** Before first prompt admission; in-process only. Rejection cleans up the thread. API 1.61.0. */
  beforePrompt?: (thread: HostThread) => Promise<void>;
  /** First prompt, delivered as soon as the thread exists. */
  prompt: string;
  attachments?: readonly UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
  thinkingLevel?: string;
  mode?: string;
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

/** A session from another machine, taken over as a thread here (new in API 1.15.0). */
export interface HostThreadImportOptions {
  /** The project folder on this machine the thread continues in; it must exist. */
  cwd: string;
  /** The session file as the other machine wrote it (Pi's JSONL, format 3). */
  jsonl: string;
  title?: string;
  /**
   * Where it came from, written as the `tau.remote-work/origin` entry right
   * after the header; `details` is stored beside it for the kit that imports.
   */
  origin: { hostId: string; threadId: string; details?: Record<string, unknown> };
}

export interface HostImportedThread {
  sessionId: string;
  /** The new session file on this machine. */
  path: string;
  cwd: string;
}

export interface HostStartedThread {
  sessionId: string;
  cwd: string;
  title?: string;
}

/** How `sessions.send` delivers a message. */
export interface HostThreadSendOptions {
  delivery?: "prompt" | "steer" | "queue";
  /** Preserve the composer's delivery identity across a machine hop. */
  identity?: ClientTurnIdentity;
  /** The thread that sent the message; the queue shows where it came from. */
  from?: string;
  /** Attachments checked as a composer's are. Runtimes without native file input receive host-local file paths in the prompt. New in API 1.47.0. */
  attachments?: readonly UiPromptAttachment[];
  /**
   * The message wakes the thread for something other than the user: it needs
   * `delivery: "queue"` and shows as a wake line. A running turn gets it as a
   * steer unless the user's `threads.wakeDelivery` is "queue"; Stop drops it while it waits. New in API 1.52.0.
   */
  wake?: UiWake;
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
  /** Changes the executing runtime of an idle local conversation, retaining its visible history. */
  switchRuntime?(id: string, kind: string): Promise<void>;
  /**
   * Takes over a Pi session another machine wrote: a new id, `cwd` in its
   * header, and the origin entry after it; every other entry is copied as it
   * was, so paths in tool results stay text. A format version other than this
   * Pi's, an entry over 16 MB or a file over 96 MB is refused. The thread is
   * indexed but not opened; `send` continues it. New in API 1.15.0; absent on
   * an older host.
   */
  import?(options: HostThreadImportOptions): Promise<HostImportedThread>;
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
  /**
   * Sends a message to a thread the way a composer does. `prompt` starts a
   * turn, or joins a running one as a follow-up; `steer` joins the running
   * turn now; `queue` waits in the thread's visible queue until its turn ends.
   * A thread whose runtime was released is reopened off screen first; `from`
   * names the thread that sent it. New in API 1.11.0.
   */
  send?(sessionId: string, text: string, options?: HostThreadSendOptions): Promise<void>;
  /** Stops a thread's running turn, as the stop button does; what it had queued waits for the user. New in API 1.11.0. */
  abort?(sessionId: string): Promise<void>;
  /**
   * Changes a thread's model, on screen or not; a released runtime is reopened off screen.
   * Rejects where its runtime has no model selection. New in API 1.46.0; absent on an older host.
   */
  setModel?(sessionId: string, provider: string, id: string): Promise<void>;
  /** Serializes with the host's own thread lifecycle work (open, switch, fork). */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Rescans persisted sessions and returns the index update. Release any lease before the sweep.
   * `publish` also sends a changed index to connected clients. New in API 1.45.0.
   * `requireComplete` rejects failed scans or unavailable backend listings instead of returning cached rows. New in API 1.74.0.
   */
  refreshIndex(options?: { publish?: boolean; requireComplete?: boolean }): Promise<HostUpdate>;
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
  /**
   * The thread is done: its last prompt ended and nothing queued continues it.
   * Once per run however many turns it took; `failed` when any of them did.
   * News for the user belongs here, not in `ended`. New in API 1.56.0.
   */
  runEnded?(sessionId: string, outcome: "completed" | "failed"): void;
  /** Work still pending for the thread; a thread with pending work is not released. */
  pending?(sessionId: string): number;
  /** The thread's runtime was rebound; live state starts over. */
  reset?(sessionId: string): Promise<void>;
  /** The thread's runtime closes; flush and release. */
  closed?(sessionId: string): Promise<void>;
  /** A tool call of the thread finished; `cwd` is the checkout it may have changed. */
  toolEnded?(sessionId: string, tool: UiToolRun, cwd: string): void;
  /**
   * The user, or a kit through `sessions.abort`, stopped the thread: its waiting
   * wakes are already gone and its run is aborted next. Not called for a
   * shutdown, a reload or the host's own repairs. Answer short phrases of what
   * this stopped ("stopped watching PR #42"), or a report that also names work
   * of yours that keeps running and may still wake the thread; the thread's
   * status line joins them. New in API 1.52.0.
   */
  stopped?(sessionId: string): HostStopAnswer | void | Promise<HostStopAnswer | void>;
}

/** What one observer stopped, and what of its work goes on regardless. */
export type HostStopAnswer = readonly string[] | { stopped?: readonly string[]; continues?: readonly string[] };

/** Every observer's answer to one stop, joined. */
export interface HostStopReport {
  stopped: string[];
  continues: string[];
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
  /** A device was paired, renamed, changed its preset, was revoked or expired. New in API 1.13.0. */
  devicesChanged?(): void;
}

/** A device paired with this host (ADR 0024), as Settings → Connections lists it. New in API 1.13.0. */
export interface HostPairedDevice {
  /** The same id `HostCommandCall.device` names. */
  readonly id: string;
  readonly name: string;
  readonly access: "full" | "read-only";
}

/**
 * Network access as a package sees it (API 1.13.0): the listeners the owner
 * turned on, the loopback proxy listener a proxy the package set up forwards
 * to, and the addresses only the package knows. Absent on a host that opens no
 * listeners of its own.
 */
export interface HostNetworkServices {
  /** What Settings → Connections shows under Network access. */
  state(): UiNetworkAccess | undefined;
  /**
   * Keeps the loopback proxy listener (`state().settings.proxyPort`, plain
   * HTTP, every peer remote) open until the returned function runs. Resolves
   * once the listeners follow; a port that cannot open is in `state().problems`.
   */
  holdProxy(): Promise<() => void>;
  /**
   * Keeps the proxy listener open for this package across restarts, until
   * `keepProxy(false)`: the host opens it at start, before any package runs,
   * so a proxy that outlives Tau (`tailscale serve --bg`) finds it at once.
   */
  keepProxy(keep: boolean): Promise<void>;
  /**
   * Adds endpoints the host cannot see itself, such as a proxy's public name.
   * They join Connections' list and every pairing link, and a page opened at
   * one may open its socket. Only `network` endpoints with an http(s) URL are
   * taken. The returned function withdraws them; publish again to change them.
   */
  publishEndpoints(endpoints: readonly UiHostEndpoint[]): () => void;
}

/** How this host's own connection to another machine is doing (ADR 0027). */
/** This host, as its hello names it to other machines. */
export interface HostMachineSelf {
  /** The host id; `request` with it asks this host itself. */
  id: string;
  name: string;
  /** Tau's version here, as `HostMachine.hostVersion` reads on the other side. */
  version: string;
}

/** An extension event another machine's kit emitted under a topic this host watches. */
export interface HostMachineEvent {
  name: string;
  payload?: unknown;
}

/**
 * The machines this host's agents may work on, and the calls they may make
 * there (`machines` permission, ADR 0027). A machine is named by its host id,
 * or by its name when that is unique. Every call rejects with a reason when
 * the machine is unknown, offline or refuses this host.
 */
export interface HostMachineServices {
  /** This host as the other machines know it: what a kit tells them it came from. New in API 1.15.0. */
  readonly self: HostMachineSelf;
  list(): HostMachine[];
  /** Called with the whole list whenever a machine is added, removed or changes status. */
  subscribe(listener: (machines: readonly HostMachine[]) => void): () => void;
  /** A command of a kit on that machine (`host-extension`), as a Full or Read-only device of its own. */
  call(machine: string, extensionId: string, command: string, input?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** One of the core methods `MACHINE_REQUEST_METHODS` lists; any other is refused before it leaves. */
  request(machine: string, method: string, params?: readonly unknown[], options?: { timeoutMs?: number }): Promise<unknown>;
  /**
   * Events that machine's kit emits under `topic`, until the returned function
   * runs. The kit is this extension's counterpart there unless `extension`
   * names another. Survives reconnects; nothing arrives while it is offline.
   */
  watch(machine: string, topic: string, listener: (event: HostMachineEvent) => void, options?: { extension?: string }): () => void;
  /**
   * Sends a file to that machine in 8 MB pieces and answers its blob id there;
   * a kit on that machine takes it with `services.blobs.take`. At most 2 GB,
   * and only with Full access there. Rejects on the first refusal, a checksum
   * the other host disagrees with, or `signal`. New in API 1.15.0.
   */
  upload(machine: string, source: HostBlobSource, options?: HostBlobUploadOptions): Promise<HostUploadedBlob>;
  /** That machine's last thread index; undefined before its first read. New in API 1.41.0. */
  index?(machine: string): ThreadIndexSnapshot | undefined;
  /** Hears changes of a machine's index and running threads; read `index()` in the listener. New in API 1.41.0. */
  subscribeIndex?(listener: (machine: string) => void): () => void;
  /** The ids running there, from `agent-status` pushes. New in API 1.41.0. */
  running?(machine: string): ReadonlySet<string>;
  /**
   * Follows a thread's pushes as they arrived, including host-wide run state,
   * questions and their resolutions that name this session. Subscribes while any
   * listener remains, including after reconnect. New in API 1.41.0.
   */
  followThread?(machine: string, sessionId: string, listener: (push: HostPushEvent) => void): () => void;
}

/** Bytes to send: a buffer, or any stream of them (a `fs.createReadStream` without an encoding). */
export type HostBlobSource = Uint8Array | AsyncIterable<Uint8Array>;

export interface HostBlobUploadOptions {
  /** After each piece the other machine stored; `total` is `size`, or the buffer's length. */
  onProgress?(progress: { sent: number; total?: number }): void;
  signal?: AbortSignal;
  /** The source's length when it is a stream, for `onProgress` and an early refusal of one too large. */
  size?: number;
  /** Per piece; 120 s by default. */
  timeoutMs?: number;
}

export interface HostUploadedBlob {
  /** The blob's id on the other machine; hand it to the kit there that takes it. */
  id: string;
  size: number;
  /** Hex; the other machine checked it before it answered. */
  sha256: string;
}

/** A file another machine sent here, while `take`'s callback holds it. */
export interface HostBlob {
  id: string;
  /** Readable until the callback settles; then it is deleted. Move or copy it to keep it. */
  path: string;
  size: number;
  sha256: string;
  /** The paired device that sent it; absent for the host token. */
  device?: string;
}

export interface HostBlobTakeOptions {
  /** The command call that named the blob: one another device sent stays and reads as missing. */
  caller?: HostCommandCall;
}

/**
 * Files other machines sent this host (`machines` permission, plan-H). A blob
 * lives an hour after it arrived unless a kit takes it; it can be taken once.
 */
export interface HostBlobServices {
  /**
   * Hands the file to `use` and deletes it once `use` settles; a second take,
   * an expired or unknown id rejects with the same sentence.
   */
  take<T>(id: string, use: (blob: HostBlob) => Promise<T> | T, options?: HostBlobTakeOptions): Promise<T>;
}

/** Who is attached right now, and word when that changes. */
export interface HostClientServices {
  observe(observer: HostClientObserver): () => void;
  count(): number;
  /**
   * The devices paired with this host, connected or not; empty on a host that
   * pairs none (a window's own in-process host). Absent before API 1.13.0.
   */
  devices?(): readonly HostPairedDevice[];
}

/**
 * A piece of media an extension attached to one turn of a thread: an image, a
 * recording. Core knows its media type and nothing about what it shows.
 */
export interface TurnAttachment {
  /** Unique within its source and thread. */
  id: string;
  /** The extension that provided it; `read` takes it back. Filled in by core. */
  source: string;
  /** The host's id of the turn (`HostTurnObserver`), when the provider knew it. */
  turnId?: string;
  /** When that turn started and, once settled, ended; epoch ms. */
  turnStartedAt?: number;
  turnEndedAt?: number;
  /** When it was taken; epoch ms. */
  at: number;
  /** `image/jpeg`, `video/webm`, … */
  mediaType: string;
  /** Bytes. */
  size: number;
  width?: number;
  height?: number;
  caption?: string;
}

export interface TurnAttachmentData {
  mediaType: string;
  /** Base64. */
  data: string;
}

/** What an extension offers; core adds `source`. */
export interface TurnAttachmentProvider {
  list(threadId: string): Promise<readonly Omit<TurnAttachment, "source">[]> | readonly Omit<TurnAttachment, "source">[];
  read(threadId: string, id: string): Promise<TurnAttachmentData | undefined>;
}

/** Media on a thread's turns: extensions provide it, any extension reads it. */
export interface HostTurnAttachmentServices {
  /** Offers this extension's attachments; a second call replaces the first. */
  provide(provider: TurnAttachmentProvider): () => void;
  /** Tells the readers that this extension's attachments of a thread changed. */
  changed(threadId: string): void;
  /** Every provider's attachments of a thread, oldest first; a provider that fails is left out. */
  list(threadId: string): Promise<TurnAttachment[]>;
  read(threadId: string, source: string, id: string): Promise<TurnAttachmentData | undefined>;
  /** Hears every `changed`, with the thread and the source. */
  observe(listener: (threadId: string, source: string) => void): () => void;
}

/** An extension's own `options` and `values` entries, keyed without the `<id>.` in front. */
export interface HostExtensionSettings {
  options: Record<string, boolean>;
  values: Record<string, string>;
}

export interface RuntimeSessionInfo {
  sessionId: string;
  cwd: string;
  /** Capabilities supplied by the runtime backend. Providers avoid duplicates or offer tools for them; `background-work` enables task listing and service release. */
  nativeCapabilities?: readonly string[];
  /** The thread that spawned this one (`sessions.start({ parent })`); set for a Pi runtime only. */
  parentThreadId?: string;
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
   * Pi package sources (`npm:name@1.2`, a path, a git URL) this extension
   * replaces. Pi runtimes Tau owns do not load a listed package that matches;
   * Pi's settings files and a Pi terminal stay as they are. New in API 1.59.0.
   */
  replacesPiPackage?: (source: string) => boolean;
  /**
   * Interaction modes this extension gives Pi threads, e.g. `plan`. A Pi thread
   * offers every mode an extension declares; the extension reads the thread's
   * mode from its session (`threadModeFromEntries`) and does what it means.
   */
  modes?: readonly string[];
  /**
   * Shell lines Pi runs before every `bash` command of this runtime, the user's
   * `!` commands included. They run outside whatever a `tool_call` handler
   * rewrote the command to, so a wrapper there (a sandbox) cannot undo them.
   * Asked once per runtime; `undefined` adds nothing. New in API 1.15.0.
   */
  shellCommandPrefix?: (session: RuntimeSessionInfo) => string | undefined;
}

export interface RuntimeExtensionContribution extends RuntimeExtensionOptions {
  name: string;
  factory: RuntimeExtensionFactory;
}

/**
 * A Pi tool, offered to the runtimes that are not Pi over the host's local MCP
 * endpoint (ADR 0022). Over MCP `execute` gets no `ExtensionContext`: its last
 * argument is `undefined`, so a tool that reads one must cope without it.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
export type HostMcpTool = ToolDefinition<any, any, any>;

/** The tools a thread's runtime is offered; asked on every list and call, with the thread the credential names. */
export type HostMcpToolProvider = (thread: RuntimeSessionInfo) => readonly HostMcpTool[] | Promise<readonly HostMcpTool[]>;

/** A section of what the endpoint tells a thread's runtime when it connects; `undefined` adds nothing. */
export type HostMcpInstructionsProvider = (thread: RuntimeSessionInfo) => string | undefined;

/** One tool call over MCP, as a gate sees it before the tool runs. */
export interface HostMcpToolCall {
  readonly threadId: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** The tool's own hints (`readOnlyHint`, `destructiveHint`), when it declares any. */
  readonly annotations?: HostMcpTool["annotations"];
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
   * Adds a section to MCP's `instructions`, which a runtime that honours them
   * puts into the model's system prompt; sections join in registration order.
   * New in API 1.12.0, so absent on an older host.
   */
  registerInstructions?(provider: HostMcpInstructionsProvider): () => void;
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
  /** A title supplied by the runtime, excluding first-prompt previews. */
  nativeTitle?(): Promise<string | undefined>;
  /** Models available for `complete` through this thread's own login. */
  completionModels?(): Promise<UiModel[]>;
  /** The thread's messages under the ids the client draws, so one can be named back to it. */
  transcript(): Promise<UiMessage[]>;
  /** One short answer from a model of the thread's runtime, unrelated to the conversation. */
  complete(provider: string, modelId: string, request: CompletionRequest): Promise<string>;
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
/** What `services.packageBuilds` offers. */
export interface HostPackageBuilds {
  /** Newest first, one per half and entry file. */
  list(): PackageBuild[];
  observe(listener: (build: PackageBuild) => void): () => void;
}

/** What `services.newPackage` is asked for. API 1.75.0. */
export interface HostNewPackageSpec {
  /** The folder name and the end of the id `local.<slug>`: lowercase words joined by dashes. */
  slug: string;
  displayName?: string;
  description?: string;
  /** Adds a host half; false by default. */
  host?: boolean;
}

/** The package `services.newPackage` wrote. */
export interface HostNewPackage {
  directory: string;
  id: string;
  name: string;
  apiVersion: string;
  /** Relative to `directory`; a folder ends in a slash. */
  files: string[];
}

/** Pi's project trust, as `services.projectTrust` offers it. */
export interface HostProjectTrust {
  /** Whether Pi trusts the folder (the open workspace by default), or the nearest parent it has an answer for. */
  trusted(cwd?: string): boolean;
  /** Trusts the folder (the open workspace by default) in Pi's `trust.json`, through Pi's own store; answers the path. */
  trust(cwd?: string): string;
}

/** A start choice from the composer catalog and the project gate. API 1.61.0. */
export interface HostRuntimeChoice {
  backend: UiRuntimeBackend;
  enabled: boolean;
  catalog?: UiRuntimeCatalog;
  readiness: RuntimeReadiness;
}

export interface HostExtensionServices {
  /** Composer catalogs, readiness and project enablement; optionally one kind. API 1.61.0; in-process only. */
  runtimeChoices?(cwd: string, kind?: string): Promise<HostRuntimeChoice[]>;
  /** Kit-owned background work, combined with the runtime's work on every client. New after API 1.59.0. */
  readonly background?: {
    provide(provider: (threadId: string) => ThreadBackgroundCapability | undefined): () => void;
    forThread(threadId: string): ThreadBackgroundCapability | undefined;
    changed(threadId: string): void;
  };
  /** Short-lived streaming resources scoped to this extension and the asking connection. API 1.51.0; in-process only. */
  readonly browserResources?: HostBrowserResources;
  /** This host's installed agent tools. Updates keep their package manager and wait for busy turns. API 1.48.0. */
  runtimeTools?(action: "state" | "update", input?: { kind: string }): Promise<UiRuntimeToolsState>;
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
   * The thread by id, its released runtime reopened off screen first, for work
   * the user asked for on a thread they are not reading (a title regenerated
   * from the rail's selection). `undefined` for one Pi's terminal holds.
   * Rejects for a thread that no longer exists. New in API 1.79.0.
   */
  reopenThread?(sessionId: string): Promise<HostThread | undefined>;
  /**
   * One short answer for a small job of the extension's own — a title, a
   * branch name, a commit message. It runs on the user's Pi model
   * configuration, so it does not depend on which runtime owns the visible
   * thread; without a model it uses the default from `~/.pi/agent`.
   */
  complete(request: CompletionRequest, model?: { provider: string; id: string }): Promise<string>;
  /**
   * The models `complete` can be asked for: the user's Pi catalog, those with a key or a login, less a
   * subscription's models its vendor's own runtime does not report (API 1.12.0). Absent before API 1.11.0.
   */
  completionModels?(): Promise<UiModel[]>;
  /**
   * Tallies priced the way core prices a thread: the user's own prices first,
   * then the runtime's, then the provider's API list for a subscription or an
   * API key. A subscription's figure is `apiValueUsd`, never `costUsd`.
   * Absent before API 1.12.0.
   */
  priceUsage?(tallies: readonly UsageTally[]): Promise<PricedUsage[]>;
  /**
   * Pi's model providers and their sign-in: which are set up, a login or a
   * key handed straight to Pi, a sign-out (`runtime:extend`). Pi keeps the
   * credential in its own `auth.json`; nothing reads one back. Absent before
   * API 1.12.0 and in a worker.
   */
  readonly modelAuth?: HostModelAuthServices;
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
  /**
   * Writes a package to start from (both `tau kit new` files, the extension
   * API's types and an AGENTS.md recipe) as `<slug>` in the global extension
   * folder, `~/.tau/extensions` or below `TAU_PACKAGES_HOME`, and nowhere else.
   * It throws when the slug is not a name or the folder exists. Nothing is
   * installed or approved. New in API 1.75.0; in-process only.
   */
  newPackage(spec: HostNewPackageSpec): Promise<HostNewPackage>;
  /**
   * Reads a package folder directly inside the global extension folder (a path
   * relative to it works too), compiles each half without running it and
   * scans it in, so it waits for approval. Throws for any other folder.
   * Grants nothing (`packages`). New in API 1.75.0.
   */
  reviewPackage(path: string): Promise<PackageReview>;
  /**
   * Records the user's yes for the folder `fingerprint` (from `reviewPackage`)
   * names and starts the package. Only an owner connection counts, and the
   * grant needs the same native confirmation dialog as Settings → Extensions
   * (ADR 0036): the call waits for it, a refusal throws, and only a host with
   * no native window to ask accepts the owner alone. A folder that changed
   * since the review, or while the dialog was open, is refused. Call it only
   * from a `long`, `access: "owner"` command that the user's click reached,
   * never from a tool (`packages`). New in API 1.75.0.
   */
  approvePackage(path: string, fingerprint: string): Promise<PackageReview>;
  /**
   * Starts a package `newPackage` wrote, for the thread `threadId`, without
   * asking, when that thread runs at Full access (the level the Access Kit
   * holds, `setPermissionLevel`). Later edits to the folder keep it running; a
   * change of permissions or isolation turns it off until it is started again.
   * Answers false, and changes nothing, for any other level, for a package
   * `newPackage` did not write (only the host's own record says so, never a
   * file in the folder) and for one the user turned off. A folder that changed
   * since the review throws. New in API 1.75.0 (`packages`, in-process only).
   */
  startOwnPackage(path: string, fingerprint: string, threadId: string): Promise<boolean>;
  /** Turns a package off, as the owner's "Turn off" on a toast; owner connections only, it stays installed. New in API 1.75.0 (`packages`, in-process only). */
  stopPackage(id: string): Promise<void>;
  /** The folder `newPackage` writes to and a global install scans: `~/.tau/extensions`, or below `TAU_PACKAGES_HOME`. New in API 1.75.0; in-process only. */
  globalExtensionsDirectory(): string;
  removePackage(source: string, scope: PackageScope): Promise<PackageRemoval>;
  /** Re-fetches one source, or every source both files list. */
  updatePackages(source?: string, progress?: (message: string) => void): Promise<InstalledPackage[]>;
  /**
   * Pi's trust in a project folder, which decides whether its `.tau` packages
   * load (`packages`). `trust` records the user's yes in Pi's own store, the
   * way Pi's `/trust` does. Absent in a worker; new with K112.
   */
  readonly projectTrust?: HostProjectTrust;
  /**
   * The last compile of each half of the installed packages, with esbuild's
   * errors, and each new one as it happens (`packages`). Absent in a worker;
   * new with K112.
   */
  readonly packageBuilds?: HostPackageBuilds;
  readonly sessions: HostSessionServices;
  /**
   * The clients attached to this host. Ungated: it reports how many there are,
   * which transport each came through and which profile it claimed, and
   * nothing about what they see.
   */
  readonly clients: HostClientServices;
  /** Network access and what a package adds to it; gated by `network` (API 1.13.0). */
  readonly network?: HostNetworkServices;
  /**
   * Other machines this host's agents may work on (`machines`, ADR 0027).
   * Absent on a host in the window's process and in a worker. New in API 1.15.0.
   */
  readonly machines?: HostMachineServices;
  /**
   * Files other machines' agents sent here (`machines`). Absent on a host in
   * the window's process and in a worker. New in API 1.15.0.
   */
  readonly blobs?: HostBlobServices;
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
  /** Media extensions attach to a thread's turns (`sessions`). Absent before API 1.12.0 and in a worker. */
  readonly turnAttachments?: HostTurnAttachmentServices;
  /**
   * What each project's agent commands may reach (`workspace:read`): kits
   * provide rules per folder, the strictest wins, and whoever runs commands
   * reads the result. New in API 1.14.0; absent before and in a worker.
   */
  readonly executionPolicy?: HostExecutionPolicyServices;
  /**
   * This extension's own settings as the levels resolve them: the project's
   * `.tau/config.json` over this machine's, for `cwd`, else this machine's
   * alone. Ungated. Absent before API 1.12.0.
   */
  settings?(cwd?: string): Promise<HostExtensionSettings>;
  /**
   * A module from Tau's own npm dependencies, resolved from the host's modules
   * for the same reason: a native addon finds its binary beside itself only
   * where npm put it. A CommonJS module answers with its `module.exports`.
   * API 1.49.0: exported subpaths are allowed; `namespace` retains named
   * exports alongside an ES module's default export.
   */
  loadDependency(packageName: string, options?: { namespace?: boolean }): Promise<unknown>;
  /**
   * Runs a command in this extension's window half — the part of a kit that
   * needs the process the user's window lives in (ADR 0021). Rejects when the
   * host has no such client, so a kit can fall back or say so; a Linux service
   * host with an invisible display starts its window first (API 1.15.0).
   */
  callClient(command: string, input?: unknown, options?: HostClientCallOptions): Promise<unknown>;
  /**
   * The id of the Tau window on the host's machine that `callClient` with
   * `{ window: "host" }` would ask now: the caller's, when it is one, else the
   * newest. Pass it as `window` to keep talking to that one window — the one
   * that holds a view, say — whichever client or turn asks next. Undefined
   * when there is none. Absent before API 1.13.0 and in a worker.
   */
  clientWindow?(): string | undefined;
  /**
   * Follows the files the host watches. The host re-reads none of them for a
   * kit and calls no kit by name: it reports what moved, and whoever owns those
   * files decides what to do — the keybindings kit re-reads `keybindings.json`,
   * a themes kit its folder. Off when watching is, except for Tau's own
   * config writes (`update-config`, `clear-config`), which are reported
   * always: a write may then arrive twice.
   */
  observeConfigChanges(listener: (change: HostConfigChange) => void): () => void;
  /**
   * Lets an extension annotate Pi dialogs before the workbench sees them. A
   * function the decorator returns runs once the dialog is answered (on any
   * client), cancelled or expires.
   */
  decorateUiPrompt(decorator: (prompt: ExtensionUiPrompt) => void | (() => void)): () => void;
  /** What the user lets external runtimes do; `undefined` restores full access. */
  setPermissionLevel(provider: ((sessionId?: string) => RuntimePermissionLevel) | undefined): void;
  /** Adds a runtime backend threads can be created with (ADR 0005); its kind names the backend. */
  registerRuntimeBackend(provider: HostRuntimeBackendProvider): () => void;
  /** Draws what Pi extensions put on terminal surfaces (status, widgets, working message). */
  presentUi(presenter: HostUiPresenter): () => void;
}

/** Who called a host command. New in API 1.13.0; an older host passes nothing. */
export interface HostCommandCall {
  /** The paired device that called (`HostPairedDevice.id`); absent for the host token, a window, the host and another kit. */
  readonly device?: string;
  /** The caller may manage this host (ADR 0024): the host itself, its own window, or the host token from this machine. */
  readonly owner: boolean;
  /** File reads have Full access, independently of permission to manage connections. */
  readonly fullAccess?: true;
  /** The kit whose host half called, through `invokeHostExtension`; absent for a client and the host. */
  readonly extension?: string;
}

export type HostExtensionCommandHandler = (input: unknown, call: HostCommandCall) => unknown;

/** A topic narrows an event to the clients that watch it; 1 to 256 characters. */
export interface HostExtensionEmitOptions {
  topic?: string;
}

export interface HostExtensionCommandOptions {
  /** Commands that may be called by these host extension IDs. */
  callers?: readonly string[];
  /** Commands that may run for minutes and therefore use the host job path. */
  long?: boolean;
  /**
   * `"read"`: the command only looks — it changes no file, thread, setting or
   * process and calls nothing that does — so a device paired Read only may
   * call it. Without it a command needs Full access (ADR 0024).
   * `"owner"` (API 1.13.0): it changes who can reach the host, so only the
   * host token from this machine may call it, like the `connections-*` methods.
   */
  access?: "read" | "owner";
  /**
   * How Settings → Connections shows a call a paired device made (API 1.13.0).
   * `label` reads after "last change:", past tense ("committed changes"); without
   * it the row shows the kit's name and the command. `automatic`: a client
   * calls it on its own after something the user did (a thread's title after
   * its prompt), so it is logged but never replaces the device's last change.
   */
  audit?: { label?: string; automatic?: boolean };
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
export type {
HostExecutionPolicy,
HostExecutionPolicyChange,
HostExecutionPolicyProvider,
HostExecutionPolicyRule,
HostExecutionPolicyServices,
HostNetworkReach
} from "./host-execution-policy.js";
export type { PackageReview } from "./package-approval.js";

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
  /** Route this kit’s workspace calls and topics to the thread’s home machine. */
  registerMachineRouting(policy?: HostMachineRoutingPolicy): () => void;
  /**
   * Publishes an `extension-event` for this extension's desktop counterpart.
   * With a `topic` it goes only to the clients whose desktop half watches that
   * topic (`HostExtensionClient.watch`); use one for output only a visible view draws.
   */
  emit(name: string, payload?: unknown, options?: HostExtensionEmitOptions): void;
  /**
   * Says this extension answers a contract another extension names, such as
   * `tau.usage/limits` (API 1.62.0). Core never reads the contract; it only
   * answers `offering`. The offer goes with the returned disposer or deactivation.
   */
  offer(contract: string): () => void;
  /** The active extensions offering `contract`, in activation order (API 1.62.0). */
  offering(contract: string): Array<{ id: string; name: string }>;
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

export interface HostExtensionRegistryOptions {
  commandTimeoutMs?: number;
  /** The ids the user turned off (`disabledExtensions`); `activate` leaves them known but stopped. */
  disabled?: () => readonly string[];
  now?: () => number;
}
