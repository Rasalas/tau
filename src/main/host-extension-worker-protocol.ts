import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type { PricedUsage, UsageTally } from "./usage-pricing.js";
export type { PricedUsage, UsageTally, UsageTurn } from "./usage-pricing.js";
import type { ThreadBackendKind, UiMessage, UiThreadUsage, UiToolRun } from "../shared/contracts.js";
import type { HostActionResult } from "../shared/host-protocol.js";
import type { UiHostEndpoint, UiNetworkAccess } from "../shared/connections.js";
import type { DirectoryPickerOptions, HostExtensionEmitOptions, HostExtensionSettings, HostSessionSummary, HostSkill, HostStartedThread, HostThreadStartOptions, HostTrashedThread } from "./host-extensions.js";

/**
 * The wire between the main process and an isolated host extension. Only plain
 * data crosses it: a worker never holds a live host object, so every facade
 * member here is either a value the main side can serialize or a round trip.
 */

export interface WorkerBootstrap {
  /** Compiled CommonJS bundle of the package's host entry. */
  file: string;
  id: string;
  name: string;
  /** Pi's configuration directory, as `HostExtensionServices.agentDir` reports it. */
  agentDir: string;
  /** The Pi session directory, as `HostExtensionServices.sessionsDir` reports it. */
  sessionsDir: string;
  /** This package's own state folder, as `HostExtensionServices.stateDir` reports it. */
  stateDir: string;
  /** The user's themes folder, as `HostExtensionServices.themesDir` reports it. */
  themesDir: string;
  safeMode: boolean;
  /** Host-issued identity for this worker activation; the supervisor binds it to the worker. */
  invocationContextId: string;
  /** The grant, so the worker can close what the main side cannot see: `network`. */
  permissions: readonly string[];
}

/** An open thread as a worker sees it. */
export interface WorkerThreadSnapshot {
  sessionId: string;
  cwd: string;
  backendKind: ThreadBackendKind;
  sessionFile?: string;
  /** The thread that spawned this one; absent for a thread the user started. */
  parentThreadId?: string;
  title?: string;
  streaming: boolean;
  idle: boolean;
  current: boolean;
  usage?: UiThreadUsage;
  model?: { provider: string; id: string };
}

/** A persisted session file, read once, without its manager. */
export interface WorkerSessionSnapshot {
  path: string;
  sessionId: string;
  cwd: string;
  entries: readonly unknown[];
  leafId?: string;
}

export interface WorkerSessionSweep {
  sessions: HostSessionSummary[];
  liveThreads: WorkerThreadSnapshot[];
  projectPaths: string[];
  deleted: Array<{ sessionId: string; cwd: string }>;
}

/** Thread lifecycle hooks a worker may implement; a hook returns nothing, so it cannot roll back. */
export interface WorkerThreadLifecycle {
  beforeWorkspace?(cwd: string): void | Promise<void>;
  afterWorkspaceClose?(cwd: string, reason: "switch" | "shutdown"): void | Promise<void>;
  threadDeleted?(sessionId: string, cwd: string): void | Promise<void>;
  beforeOpen?(session: WorkerSessionSnapshot): void | Promise<void>;
  afterFork?(source: WorkerThreadSnapshot, target: WorkerSessionSnapshot): void | Promise<void>;
  beforeActivate?(thread: WorkerThreadSnapshot): void | Promise<void>;
  sweep?(sweep: WorkerSessionSweep): void | Promise<void>;
}

export interface WorkerTurnObserver {
  accepted?(sessionId: string, turnId: string, options: { deferBefore: boolean; expectsInput?: boolean }): void | Promise<void>;
  prepare?(sessionId: string, turnId: string): void | Promise<void>;
  cancelled?(sessionId: string, turnId: string): void | Promise<void>;
  ended?(sessionId: string, turnId: string, outcome: "completed" | "failed"): void | Promise<void>;
  reset?(sessionId: string): void | Promise<void>;
  closed?(sessionId: string): void | Promise<void>;
  toolEnded?(sessionId: string, tool: UiToolRun, cwd: string): void | Promise<void>;
}

export interface WorkerProjectFacts {
  name?(cwd: string): Promise<string | undefined> | string | undefined;
  label?(cwd: string): Promise<string | undefined> | string | undefined;
  nested?(cwd: string): Promise<boolean> | boolean;
}

export const LIFECYCLE_HOOKS = ["beforeWorkspace", "afterWorkspaceClose", "threadDeleted", "beforeOpen", "afterFork", "beforeActivate", "sweep"] as const;
export const TURN_HOOKS = ["accepted", "prepare", "cancelled", "ended", "reset", "closed", "toolEnded"] as const;
export const FACT_HOOKS = ["name", "label", "nested"] as const;
export const CLIENT_HOOKS = ["attached", "detached"] as const;

/** One attached client as a worker sees it; the same plain data the seam carries. */
export interface WorkerClientInfo {
  id: string;
  transport: "electron" | "socket";
  profile?: string;
}

export interface WorkerClientObserver {
  attached?(clientId: string, client: WorkerClientInfo): void | Promise<void>;
  detached?(clientId: string): void | Promise<void>;
}
export const CONFIG_HOOKS = ["changed"] as const;

/**
 * What an isolated host extension may ask of the host. Everything is a round
 * trip, so the facade is asynchronous where the in-process one is not, and
 * nothing that would hand out a live object is here (see ADR 0009).
 */
export interface WorkerHostServices {
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly stateDir: string;
  readonly themesDir: string;
  readonly safeMode: boolean;
  cwd(): Promise<string>;
  /** Fire and forget: the host log never answers. */
  log(label: string, detail?: string): void;
  openWorkspace(path: string): Promise<HostActionResult>;
  knownWorkspacePath(path: string): Promise<string>;
  /** The identity the host publishes for a folder it can open; plain data, safe to cross the port. */
  workspaceRef(path: string): Promise<WorkspaceRef>;
  admitWorkspace(path: string): Promise<WorkspaceRef>;
  projectName(cwd: string): Promise<string>;
  rememberProjectName(cwd: string, name: string): Promise<void>;
  /** Tallies priced the way core prices a thread; see `HostExtensionServices.priceUsage`. New in API 1.12.0. */
  priceUsage(tallies: readonly UsageTally[]): Promise<PricedUsage[]>;
  /** This extension's own settings; see `HostExtensionServices.settings`. New in API 1.12.0. */
  settings(cwd?: string): Promise<HostExtensionSettings>;
  pickDirectory(options?: DirectoryPickerOptions): Promise<string | undefined>;
  runtimeOwner(): Promise<"tau" | "pi">;
  /** An open thread by id, or the active one, reduced to plain facts. */
  thread(sessionId?: string): Promise<WorkerThreadSnapshot | undefined>;
  /** Visible messages of an open thread. */
  transcript(sessionId?: string): Promise<UiMessage[]>;
  setThreadTitle(sessionId: string, title: string, source: "generated" | "renamed"): Promise<void>;
  noteSubprocess(): Promise<void>;
  findCommand(name: string): Promise<string | undefined>;
  skills(cwd: string): Promise<HostSkill[]>;
  refreshExtensionPackages(): Promise<void>;
  /** Answers the index's questions about a project folder, by round trip. */
  describeProjects(facts: WorkerProjectFacts): Promise<() => void>;
  readonly sessions: {
    list(): Promise<HostSessionSummary[]>;
    /** Reads a session file once; the manager behind it stays in the host. */
    read(path: string): Promise<WorkerSessionSnapshot>;
    /** Starts a thread for a project and delivers its first prompt, off screen. */
    start(options: HostThreadStartOptions): Promise<HostStartedThread>;
    /** Moves a thread to the trash; `threadDeleted` runs when it is purged. */
    remove(sessionId: string): Promise<void>;
    restore(sessionId: string): Promise<void>;
    trash(): Promise<HostTrashedThread[]>;
    purge(sessionId: string): Promise<void>;
    /** Runs `work` inside the host's thread lifecycle lock, one round trip wide. */
    exclusive<T>(work: () => Promise<T> | T): Promise<T>;
  };
  readonly clients: {
    observe(observer: WorkerClientObserver): Promise<() => void>;
    count(): Promise<number>;
  };
  /** Network access; see `HostExtensionServices.network`. `state` answers undefined where the host opens no listeners. New in API 1.13.0. */
  readonly network: {
    state(): Promise<UiNetworkAccess | undefined>;
    holdProxy(): Promise<() => void>;
    keepProxy(keep: boolean): Promise<void>;
    publishEndpoints(endpoints: readonly UiHostEndpoint[]): Promise<() => void>;
  };
  /** Follows the files the host watches; the hook receives one change at a time. */
  observeConfigChanges(listener: (change: { kind: string; paths: readonly string[] }) => void): Promise<() => void>;
  registerThreadLifecycle(lifecycle: WorkerThreadLifecycle): Promise<() => void>;
  registerTurnObserver(observer: WorkerTurnObserver): Promise<() => void>;
  /** Work the extension still owes a thread; the host keeps such a thread alive. */
  setPendingWork(sessionId: string, count: number): Promise<void>;
  /** Entries rows anchor to, pushed as data: calling again replaces this registration's map. */
  pinTranscriptEntries(pins: Record<string, string[]>): Promise<() => void>;
}

export type WorkerCommandHandler = (input: unknown) => unknown;

export interface WorkerHostExtensionContext {
  readonly id: string;
  /** Opaque host-issued identity for this worker activation. */
  readonly invocationContextId: string;
  readonly services: WorkerHostServices;
  /** Calls another host entry through the supervisor-bound worker identity. */
  readonly invokeHostExtension: (extensionId: string, command: string, input?: unknown) => Promise<unknown>;
  registerCommand(name: string, handler: WorkerCommandHandler, options?: { long?: boolean; callers?: readonly string[]; access?: "read" | "owner" }): () => void;
  emit(name: string, payload?: unknown, options?: HostExtensionEmitOptions): void;
}

/** The default export of a package's host entry when it runs isolated. */
export interface WorkerHostExtension {
  id?: string;
  name?: string;
  activate(context: WorkerHostExtensionContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface SerializedError {
  message: string;
  stack?: string;
  name?: string;
  code?: string;
  details?: unknown;
  /** Set for a `HostCommandError`: bad input, not a broken command. */
  expected?: true;
}

export type HostToWorkerMessage =
  | { t: "call"; id: number; command: string; input: unknown }
  | { t: "hook"; id: number; handle: number; hook: string; args: readonly unknown[] }
  | { t: "enter"; id: number }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; error: SerializedError };

export type WorkerToHostMessage =
  | { t: "ready" }
  | { t: "fatal"; error: SerializedError }
  | { t: "command"; name: string; long: boolean; callers: readonly string[]; access?: "read" | "owner" }
  | { t: "command-off"; name: string }
  | { t: "emit"; name: string; payload: unknown; topic?: string }
  | { t: "log"; label: string; detail?: string }
  | { t: "rpc"; id: number; path: string; args: readonly unknown[] }
  | { t: "release"; handle: number }
  | { t: "exit"; id: number; ok: true; value: unknown }
  | { t: "exit"; id: number; ok: false; error: SerializedError }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; error: SerializedError };

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const expected = (error as { expected?: unknown }).expected === true;
    const code = (error as { code?: unknown }).code;
    const details = (error as { details?: unknown }).details;
    let plainDetails: unknown;
    if (details !== undefined) {
      try { plainDetails = toPlain(details); } catch { plainDetails = undefined; }
    }
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.name !== "Error" ? { name: error.name } : {}),
      ...(typeof code === "string" ? { code } : {}),
      ...(plainDetails === undefined ? {} : { details: plainDetails }),
      ...(expected ? { expected: true } : {}),
    };
  }
  return { message: String(error) };
}

export function reviveError(error: SerializedError): Error {
  const revived = new Error(error.message);
  if (error.stack) revived.stack = error.stack;
  if (error.name) revived.name = error.name;
  if (error.code) Object.defineProperty(revived, "code", { value: error.code, enumerable: true });
  if (error.details !== undefined) Object.defineProperty(revived, "details", { value: error.details, enumerable: true });
  if (error.expected) {
    revived.name = error.name ?? "HostCommandError";
    Object.defineProperty(revived, "expected", { value: true, enumerable: false });
  }
  return revived;
}

/** Strips anything the structured clone would refuse; entries come from Pi as JSON. */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}
