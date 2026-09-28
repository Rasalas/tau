/**
 * Test harness for PiHost that collapses all internal access into one seam.
 *
 * The goal is to make structural changes to pi-host.ts cheap: instead of
 * breaking 161 `internals` casts across test files, only this harness breaks.
 *
 * Usage:
 * - Use the public API (hostWithThread, adoptThread, spyOnPrompt, etc.)
 * - Tests read like behavior, not internal structure
 * - Remaining `internals` cast is documented here, not scattered
 */

import type { PiHost } from "../pi-host.js";
import type { ThreadRuntime } from "../thread-runtime.js";

/**
 * Internal structure of PiHost, consolidated into one type definition.
 * When pi-host.ts changes, update this interface, not 161 test sites.
 */
interface PiHostInternals {
  // Thread lifecycle
  threads: {
    adopt(record: {
      threadId: string;
      cwd: string;
      runtime: ThreadRuntime;
      isolation: "in-process" | "worker";
    }): Promise<void>;
    setActive(sessionId: string): void;
    active?: { runtime: unknown; threadId: string };
    release?: (threadId: string) => Promise<void>;
  };

  // Attached runtime state
  attached: {
    session: {
      client?: object;
      snapshot?: unknown;
      command?: (...args: unknown[]) => unknown;
    };
  };

  // Session index
  index: {
    sessions?: Array<Record<string, unknown>>;
    refreshShell?(thread: unknown, touch: boolean): Promise<void>;
  };

  // Activation coordination
  beginActivation?(): number;
  activateThread?(thread: unknown, touch: boolean, epoch: number): Promise<boolean>;

  // Project and workspace
  rememberProject?(cwd: string): Promise<void>;
  projects?: unknown;

  // Runtime coordination
  runtimes?: {
    open?: (cwd: string, sessionFile: string) => Promise<ThreadRuntime>;
  };
  takePreparedThread?(sessionId: string): ThreadRuntime | undefined;
  takeSpareThread?(): Promise<ThreadRuntime | undefined>;

  // Prompt and message handling
  prompt?(text: string, options?: unknown): Promise<unknown>;
  prompts?: unknown;
  projection?: unknown;

  // Bridge coordination
  detachBridge?(): void;
  attachAvailableBridge?(): void;

  // What the host publishes
  publication: {
    activeUpdates(activationEpoch?: number): Promise<{ version: number; updates: unknown[] }>;
  };

  // Extension and lifecycle
  lifecycle?: unknown;
  activateHostExtensions?(): Promise<void>;
  handleSessionEvent?(event: unknown): void;

  // Prewarming
  prewarm: {
    scheduleThreads?(): void;
    scheduleSpare?(): void;
  };

  // Logging and cleanup
  logReplacement?(): void;
  recoverPendingRestoreTransactions?(): Promise<void>;
}

/**
 * Get internal access to a PiHost for test setup.
 * This is the ONLY place in the test suite that performs this cast.
 */
function internals(host: PiHost): PiHostInternals {
  return host as unknown as PiHostInternals;
}

/**
 * Adopt a thread runtime into the host's thread registry.
 * Used for test setup when a thread needs to exist before testing behavior.
 */
export async function adoptThread(
  host: PiHost,
  config: {
    threadId: string;
    cwd: string;
    runtime: ThreadRuntime;
    isolation?: "in-process" | "worker";
  },
): Promise<void> {
  await internals(host).threads.adopt({
    threadId: config.threadId,
    cwd: config.cwd,
    runtime: config.runtime,
    isolation: config.isolation ?? "in-process",
  });
}

/**
 * Set a thread as the active thread in the host.
 */
export function setActiveThread(host: PiHost, threadId: string): void {
  internals(host).threads.setActive(threadId);
}

/**
 * Get the currently active thread ID.
 */
export function getActiveThreadId(host: PiHost): string | undefined {
  return internals(host).threads.active?.threadId;
}

/**
 * Set the session index entries directly.
 * Used for test setup when specific index state is needed.
 */
export function setSessionIndex(
  host: PiHost,
  sessions: Array<{
    id: string;
    path: string;
    title: string;
    modifiedAt: number;
    projectPath: string;
    projectName: string;
    messageCount: number;
  }>,
): void {
  internals(host).index.sessions = sessions;
}

/**
 * Set up an attached runtime with a bridge command.
 * Used for testing bridge-related behavior.
 */
export function attachRuntimeWithBridge(
  host: PiHost,
  config: {
    snapshot: unknown;
    command: (...args: unknown[]) => unknown;
  },
): void {
  const i = internals(host);
  i.attached.session.client = {};
  i.attached.session.snapshot = config.snapshot;
  i.attached.session.command = config.command;
}

/**
 * Spy on the host's internal prompt method.
 * Returns an object that tracks calls and allows custom behavior.
 */
export function spyOnPrompt(host: PiHost): {
  calls: string[];
  mockImplementation: (impl: (text: string) => Promise<unknown>) => void;
} {
  const calls: string[] = [];
  const i = internals(host);
  const original = i.prompt?.bind(i);

  let customImpl: ((text: string) => Promise<unknown>) | undefined;

  i.prompt = async (text: string) => {
    calls.push(text);
    if (customImpl) return customImpl(text);
    if (original) return original(text);
    return undefined;
  };

  return {
    calls,
    mockImplementation: (impl) => {
      customImpl = impl;
    },
  };
}

/**
 * Mock internal coordination methods for activation tests.
 * Returns the mocked internals for inspection.
 */
export function mockActivationCoordination(host: PiHost): {
  beginActivation(): number;
  activateThread(thread: unknown, touch: boolean, epoch: number): Promise<boolean>;
  rememberProject: ((cwd: string) => Promise<void>) & { calls: string[] };
  refreshShell: (() => Promise<void>) & { calls: number };
  detachBridge: (() => void) & { calls: number };
  prewarmThreads: (() => void) & { calls: number };
  prewarmSpare: (() => void) & { calls: number };
} {
  const i = internals(host);

  const rememberProjectCalls: string[] = [];
  const refreshShellCalls: number[] = [];
  const detachBridgeCalls: number[] = [];
  const prewarmThreadsCalls: number[] = [];
  const prewarmSpareCalls: number[] = [];

  const rememberProject = async (cwd: string) => {
    rememberProjectCalls.push(cwd);
  };
  Object.defineProperty(rememberProject, "calls", { get: () => rememberProjectCalls });

  const refreshShell = async () => {
    refreshShellCalls.push(refreshShellCalls.length);
  };
  Object.defineProperty(refreshShell, "calls", { get: () => refreshShellCalls });

  const detachBridge = () => {
    detachBridgeCalls.push(detachBridgeCalls.length);
  };
  Object.defineProperty(detachBridge, "calls", { get: () => detachBridgeCalls });

  const prewarmThreads = () => {
    prewarmThreadsCalls.push(prewarmThreadsCalls.length);
  };
  Object.defineProperty(prewarmThreads, "calls", { get: () => prewarmThreadsCalls });

  const prewarmSpare = () => {
    prewarmSpareCalls.push(prewarmSpareCalls.length);
  };
  Object.defineProperty(prewarmSpare, "calls", { get: () => prewarmSpareCalls });

  i.rememberProject = rememberProject;
  i.index.refreshShell = refreshShell;
  i.detachBridge = detachBridge;
  i.prewarm.scheduleThreads = prewarmThreads;
  i.prewarm.scheduleSpare = prewarmSpare;

  return {
    beginActivation: () => i.beginActivation?.() ?? 0,
    activateThread: (thread, touch, epoch) => i.activateThread?.(thread, touch, epoch) ?? Promise.resolve(false),
    rememberProject: rememberProject as any,
    refreshShell: refreshShell as any,
    detachBridge: detachBridge as any,
    prewarmThreads: prewarmThreads as any,
    prewarmSpare: prewarmSpare as any,
  };
}

/**
 * Mock various internal methods for complex test scenarios.
 */
export function mockInternalMethods(
  host: PiHost,
  mocks: Partial<{
    rememberProject: (cwd: string) => Promise<void>;
    refreshShell: () => Promise<void>;
    detachBridge: () => void;
    takeSpareThread: () => Promise<ThreadRuntime | undefined>;
    openRuntime: (cwd: string, sessionFile: string) => Promise<ThreadRuntime>;
    logReplacement: () => void;
    activeUpdates: () => Promise<{ version: number; updates: unknown[] }>;
    release: (threadId: string) => Promise<void>;
    prompt: (text: string) => Promise<unknown>;
  }>,
): void {
  const i = internals(host);

  if (mocks.rememberProject) i.rememberProject = mocks.rememberProject;
  if (mocks.refreshShell) i.index.refreshShell = mocks.refreshShell;
  if (mocks.detachBridge) i.detachBridge = mocks.detachBridge;
  if (mocks.takeSpareThread) i.takeSpareThread = mocks.takeSpareThread;
  if (mocks.openRuntime) {
    if (!i.runtimes) i.runtimes = {};
    i.runtimes.open = mocks.openRuntime;
  }
  if (mocks.logReplacement) i.logReplacement = mocks.logReplacement;
  if (mocks.activeUpdates) i.publication.activeUpdates = mocks.activeUpdates;
  if (mocks.release) i.threads.release = mocks.release;
  if (mocks.prompt) i.prompt = mocks.prompt;
}

/**
 * Activate host extensions. Call this after constructing a host with extensions.
 */
export async function activateHostExtensions(host: PiHost): Promise<void> {
  await internals(host).activateHostExtensions?.();
}

/**
 * Get the raw internal structure for complex inspection.
 * Use sparingly - prefer the specific helpers above.
 */
export function rawInternals(host: PiHost): PiHostInternals {
  return internals(host);
}
