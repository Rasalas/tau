import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiSession } from "../shared/contracts.js";
import type { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import type { ThreadRuntimeLifecycle } from "./thread-runtime-lifecycle.js";

export interface RuntimePrewarmPort {
  /** False in tests and benchmarks, where a background runtime would distort the measurement. */
  automatic: boolean;
  safeMode: boolean;
  /** Live runtimes the host keeps; prewarming never fills the budget to the brim. */
  maxLiveThreads: number;
  cwd(): string;
  sessionsDir: string | undefined;
  runtimes: ThreadRuntimeLifecycle;
  extensionUi: ExtensionUiCoordinator;
  /** Threads with a live runtime already. */
  liveThreadIds(): Set<string>;
  /** False while Pi's own terminal owns the visible thread; nothing is prewarmed then. */
  hasLocalActive(): boolean;
  indexedSessions(): readonly UiSession[];
  prewarmSession(path: string): Promise<void>;
  recordBackground(name: string, startedAt: number): void;
  log(label: string, detail?: string): void;
  fail(error: unknown): void;
  errorMessage(error: unknown): string;
}

/**
 * Runtimes built before anyone asks for them: one blank spare for the current
 * project, so a new thread is ready the moment it is wanted, and the neighbours
 * of the thread on screen, so switching to one is immediate.
 */
export class RuntimePrewarm {
  private spare?: { cwd: string; pending: Promise<ThreadRuntime | undefined>; cancel: () => void };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly port: RuntimePrewarmPort) {}

  /** Builds a blank runtime for a project. `force` overrides the automatic-prewarm switch. */
  scheduleSpare(cwd: string, force = false): void {
    if ((!this.port.automatic && !force) || this.port.safeMode || this.spare?.cwd === cwd) return;
    void this.discardSpare().catch((error) => this.port.fail(error));
    const startedAt = performance.now();
    const cancellation = new AbortController();
    const pending = this.port.runtimes.open(
      SessionManager.create(cwd, this.port.sessionsDir),
      { type: "session_start", reason: "new", previousSessionFile: undefined },
      { background: true, adopt: false, prepared: true, abortSignal: cancellation.signal },
    ).then((thread) => {
      this.port.log("runtime.spare.ready", basename(cwd));
      return thread;
    }).catch((error) => {
      this.port.log("runtime.spare.failed", this.port.errorMessage(error));
      return undefined;
    }).finally(() => this.port.recordBackground("spare", startedAt));
    this.spare = { cwd, pending, cancel: () => cancellation.abort() };
  }

  /** Hands over the spare of this project, if there is one; the caller owns it afterwards. */
  async takeSpare(cwd: string): Promise<ThreadRuntime | undefined> {
    const spare = this.spare;
    if (!spare || spare.cwd !== cwd) return undefined;
    this.spare = undefined;
    return await spare.pending;
  }

  /** Puts an untouched candidate back; a rejected prompt must not cost the spare. */
  retainSpare(thread: ThreadRuntime): void {
    this.spare = { cwd: thread.cwd, pending: Promise.resolve(thread), cancel: () => {
      this.port.extensionUi.cancelFor(thread.sessionId);
      void thread.backend.abort().catch((error) => this.port.log("runtime.prepared.abort", this.port.errorMessage(error)));
    } };
  }

  /** The spare of this project, built now if there is none. It stays the spare. */
  async awaitSpare(cwd: string): Promise<ThreadRuntime | undefined> {
    if (this.spare?.cwd !== cwd) this.scheduleSpare(cwd, true);
    return this.spare?.cwd === cwd ? await this.spare.pending : undefined;
  }

  async discardSpare(): Promise<void> {
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) return;
    spare.cancel();
    const thread = await spare.pending;
    if (thread) await this.port.runtimes.dispose(thread);
  }

  /** Opens the neighbours of the thread on screen, a second after it settled. */
  scheduleThreads(): void {
    if (!this.port.automatic || this.port.safeMode || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.port.hasLocalActive()) return;
      const live = this.port.liveThreadIds();
      const candidates = this.port.indexedSessions()
        .filter((session) => session.projectPath === this.port.cwd() && !live.has(session.id) && !this.port.runtimes.isOpening(session.path))
        .slice(0, Math.max(0, this.port.maxLiveThreads - 2 - live.size));
      for (const session of candidates) void this.port.prewarmSession(session.path);
    }, 1_000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
