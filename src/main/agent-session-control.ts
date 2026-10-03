import type { HostActionResult } from "../shared/host-protocol.js";
import type { HostPublication } from "./host-publication.js";
import type { RuntimePrewarm } from "./runtime-prewarm.js";
import type { ThreadRuntimeLifecycle } from "./thread-runtime-lifecycle.js";
import type { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { externalThreadPath } from "./pi-host-support.js";
import { ThreadRuntime, isLocalPiRuntime } from "./thread-runtime.js";
import { requireCapability } from "./runtime-types.js";
import { UnavailableThreadBackend } from "./unavailable-thread-backend.js";

interface AgentSessionControlPort {
  thread(id?: string): ThreadRuntime;
  active(): ThreadRuntime | undefined;
  isAttached(thread: ThreadRuntime): boolean;
  pending(id: string): number;
  hasQuestion(id: string): boolean;
  path(id: string): string | undefined;
  publication(): HostPublication;
  runtimes(): ThreadRuntimeLifecycle;
  prewarm(): RuntimePrewarm;
  threads(): ThreadRuntimeRegistry<ThreadRuntime>;
  activate(thread: ThreadRuntime, epoch: number): Promise<boolean>;
  staleResult(): Promise<HostActionResult>;
  cwd(): string;
  extensionCount(count: number): void;
  refreshPackages(): Promise<void>;
  log(event: string, detail?: string): void;
  errorMessage(error: unknown): string;
}

/** Owns targeted restart admission, discovery refresh and failed-reopen recovery. */
export class AgentSessionControl {
  private readonly restartingThreads = new Set<string>();
  constructor(private readonly port: AgentSessionControlPort) {}

  assertAvailable(threadId?: string): void {
    const id = threadId ?? this.port.active()?.threadId;
    if (id && this.restartingThreads.has(id)) throw new Error("The agent session is restarting. Wait before sending another message or changing this thread.");
  }

  async restart(threadId: string, epoch: number): Promise<HostActionResult> {
    const thread = this.port.thread(threadId);
    if (thread !== this.port.active()) throw new Error("Open this thread on its home machine before restarting its agent session.");
    if (thread.state.streaming || !thread.state.idle || thread.adapterPending > 0
      || thread.pendingClientMessageIds.length > 0 || thread.inFlightClientMessageIds.size > 0
      || thread.backend.capabilities.shellAction?.isRunning()
      || [...thread.tools.values()].some((tool) => tool.status === "running")
      || this.port.pending(threadId) > 0 || this.port.hasQuestion(threadId)) {
      throw new Error("Wait for this thread's running work and questions to finish before restarting its agent session.");
    }
    const restart = requireCapability(thread.backend, "restart");
    if (this.port.isAttached(thread)) throw new Error("Restart this attached session in its owning terminal.");
    this.restartingThreads.add(threadId);
    thread.restartGeneration += 1;
    try {
      if (!isLocalPiRuntime(thread)) {
        await restart.restart();
        this.port.publication().invalidateModels();
        this.port.log("runtime.session.restarted", threadId);
        return this.port.publication().activeUpdates(epoch);
      }
      const messages = await thread.backend.transcript();
      const entries = thread.entries;
      const state = thread.state;
      const path = thread.sessionFile ?? this.port.path(threadId)
        ?? (thread.backend.kind !== "pi" ? externalThreadPath(thread.backend.kind, threadId) : undefined);
      if (!path) throw new Error("This runtime cannot resume its session after a restart.");
      this.port.runtimes().invalidateResources();
      this.port.publication().invalidateModels();
      this.port.prewarm().discardSpare();
      let replacement: ThreadRuntime;
      try {
        await this.port.threads().release(threadId);
        replacement = await this.port.runtimes().openForPath(path, "resume", false, thread.backend.kind);
      } catch (error) {
        const why = `Agent restart failed: ${this.port.errorMessage(error)} Open this thread again to retry.`;
        replacement = new ThreadRuntime(new UnavailableThreadBackend(thread.backend.kind, thread.runtimeAdapter, {
          threadId, cwd: thread.cwd, updatedAt: Date.now(), messages,
          ...(state.title ? { title: state.title } : {}),
        }, why, { sessionFile: path, entries }));
        await this.port.threads().adopt({ threadId, cwd: thread.cwd, runtime: replacement, isolation: "in-process" });
        await this.port.activate(replacement, epoch);
        await this.port.publication().activeUpdates(epoch);
        throw new Error(why, { cause: error });
      }
      if (!await this.port.activate(replacement, epoch)) return this.port.staleResult();
      this.port.log("runtime.session.restarted", threadId);
      return this.port.publication().activeUpdates(epoch);
    } finally { this.restartingThreads.delete(threadId); }
  }

  /** Refresh resources for the workbench reload, including its other idle Pi sessions. */
  async reload(): Promise<void> {
    const thread = this.port.thread();
    const reload = requireCapability(thread.backend, "reload");
    // A runtime the host does not own reloads in its own process; the caches
    // below are the host's, and it has none of them for that thread.
    if (!isLocalPiRuntime(thread)) {
      await reload.reload();
      this.port.log("runtime.reload.requested", "runtime owner");
      return;
    }
    if (thread.state.streaming) throw new Error("Wait for the active run before reloading Pi.");
    await reload.reload();
    this.port.publication().invalidateModels();
    this.port.runtimes().invalidateResources();
    // Other idle runtimes still hold the old resources; they are cheap to
    // rebuild on demand, so drop them rather than reload each one.
    this.port.prewarm().discardSpare();
    for (const record of this.port.threads().list()) {
      if (record.runtime !== thread && isLocalPiRuntime(record.runtime)
        && record.runtime.state.idle
        && this.port.pending(record.threadId) === 0
        && !this.port.hasQuestion(record.threadId)) {
        await this.port.threads().release(record.threadId);
      }
    }
    this.port.extensionCount(thread.state.extensionCount);
    // The manual fallback restarts every package, however unchanged it looks.
    await this.port.refreshPackages();
    this.port.log("runtime.reloaded");
    await this.port.publication().publishLifecycle();
    this.port.prewarm().scheduleThreads();
    this.port.prewarm().scheduleSpare(this.port.cwd());
  }
}
