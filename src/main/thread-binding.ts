import { performance } from "node:perf_hooks";
import { CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker, unclaimedClientMessageIds } from "../shared/client-message-correlation.js";
import type { ThreadHostEvent } from "../shared/contracts.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import type { ClientMessageTracker } from "./client-message-tracker.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { HostTurnObserverSet, HostUiPresenter } from "./host-extensions.js";
import type { ThreadProjection } from "./thread-projection.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import { beforeRuntimeDeadline } from "./pi-host-support.js";

const BIND_TIMEOUT_MS = 30_000;

export interface ThreadBindingPort {
  extensionUi: ExtensionUiCoordinator;
  clientTurns: ClientTurnLedger;
  clientMessages: ClientMessageTracker;
  turnObservers: HostTurnObserverSet;
  projection: ThreadProjection;
  /** Whether this thread is the one the workbench shows. */
  isActive(thread: ThreadRuntime): boolean;
  /** Whether the registry still holds this exact runtime for its thread id. */
  isCurrent(thread: ThreadRuntime): boolean;
  /** Runtime events, once a binding has decided the host receives them. */
  onSessionEvent(event: unknown, thread: ThreadRuntime, threadId: string, cwd: string): void;
  emitForThread(thread: ThreadRuntime, event: ThreadHostEvent): void;
  presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean;
  setWindowTitle(title: string): void;
  /** Extensions contribute prompts, skills and themes while they bind. */
  publishActiveCatalog(): Promise<void>;
  recordBackground(name: string, startedAt: number): void;
  logPhase(phase: string, startedAt: number, reason: string, cwd: string, thread: ThreadRuntime): void;
  log(label: string, detail?: string): void;
  logForThread(thread: ThreadRuntime, label: string, detail?: string): void;
  fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void;
  errorMessage(error: unknown): string;
  discard(thread: ThreadRuntime): void;
}

/**
 * Tau's dialog surface inside a runtime's extensions, and the event
 * subscription that comes with it. Binding is what turns a built runtime into
 * one the workbench can draw for: until it has run, an extension has no `ctx.ui`
 * and no shortcut of it can be dispatched.
 */
export class ThreadBinding {
  /** Bindings still running beside the switch that opened their thread. */
  private readonly pending = new Map<ThreadRuntime, Promise<void>>();
  private readonly failed = new WeakMap<ThreadRuntime, Error>();

  constructor(private readonly port: ThreadBindingPort) {}

  /**
   * Binds Tau's dialog surface into a runtime's extensions. Pi binds them one
   * after another, so the wait runs beside the switch instead of in front of
   * it. Subscription and marker recovery stay synchronous: they decide which
   * runtime events reach the host, and none may be missed.
   */
  bind(thread: ThreadRuntime, deferred = false): Promise<void> {
    const extensions = thread.backend.capabilities.extensions;
    if (!extensions) return Promise.resolve();
    thread.unsubscribe = thread.backend.capabilities.events?.subscribe((event, threadId) => {
      if (!this.failed.has(thread)) this.port.onSessionEvent(event, thread, threadId, thread.cwd);
    });
    this.recoverOrphanedMarkers(thread);
    const bind = () => extensions.bind({
      ui: {
        sessionId: () => thread.threadId,
        ask: (prompt) => this.failed.has(thread) ? Promise.resolve({ cancelled: true }) : this.port.extensionUi.ask(prompt, thread),
        notify: (message, level) => { if (!this.failed.has(thread)) this.port.emitForThread(thread, { type: "notice", message, level, sessionId: thread.threadId }); },
        setWindowTitle: (title) => {
          if (this.failed.has(thread)) return;
          if (!thread.deferTitle(title)) this.port.setWindowTitle(title);
        },
        unsupported: (method) => this.port.logForThread(thread, "extension-ui.unsupported", method),
        setStatus: (key, text) => !this.failed.has(thread) && this.port.presentUi("setStatus", thread.threadId, key, text),
        setWidget: (key, lines, placement) => !this.failed.has(thread) && this.port.presentUi("setWidget", thread.threadId, key, lines, placement),
        setWorkingMessage: (message) => !this.failed.has(thread) && this.port.presentUi("setWorkingMessage", thread.threadId, message),
        setFooter: (lines) => !this.failed.has(thread) && this.port.presentUi("setFooter", thread.threadId, lines),
        setHeader: (lines) => !this.failed.has(thread) && this.port.presentUi("setHeader", thread.threadId, lines),
        setEditorText: (text) => !this.failed.has(thread) && this.port.presentUi("setEditorText", thread.threadId, text),
        pasteToEditor: (text) => !this.failed.has(thread) && this.port.presentUi("pasteToEditor", thread.threadId, text),
        setToolsExpanded: (expanded) => !this.failed.has(thread) && this.port.presentUi("setToolsExpanded", thread.threadId, expanded),
      },
      onError: (error) => { if (!this.failed.has(thread)) this.port.fail(error, thread.threadId, thread); },
    });
    if (!deferred) return this.run(thread, bind, "caller");
    const bound = this.run(thread, bind, "host");
    this.pending.set(thread, bound);
    void bound.finally(() => { if (this.pending.get(thread) === bound) this.pending.delete(thread); });
    return bound;
  }

  /**
   * Runs one binding and the catalog publication that follows it. A deferred
   * binding reports its own failure, because the thread it belongs to is
   * already on screen and cannot be unwound; an awaited binding leaves the
   * error with its caller.
   */
  private async run(thread: ThreadRuntime, bind: () => Promise<void>, owner: "host" | "caller"): Promise<void> {
    const bindStartedAt = performance.now();
    try {
      const completed = await beforeRuntimeDeadline((async () => {
        await bind();
        if (!this.failed.has(thread) && this.port.isActive(thread)) await this.port.publishActiveCatalog();
      })(), BIND_TIMEOUT_MS);
      if (!completed) {
        const error = new Error("The runtime's extensions did not finish binding within 30 s. Open this thread again to retry.");
        this.failed.set(thread, error);
        throw error;
      }
    } catch (error) {
      if (owner === "caller") throw error;
      if (this.port.isCurrent(thread)) this.port.fail(error, thread.threadId, thread);
      else this.port.logForThread(thread, "runtime.bind.failed", this.port.errorMessage(error));
    } finally {
      if (this.failed.has(thread)) this.port.discard(thread);
      this.port.recordBackground("bind", bindStartedAt);
      this.port.logPhase("bind", bindStartedAt, "active", thread.cwd, thread);
    }
  }

  /**
   * Waits for a binding that is still running. Only callers outside the
   * lifecycle queue may use it: an extension can ask for that queue through
   * `sessions.exclusive` while it binds, and holding it here would deadlock
   * (ADR 0004).
   */
  async settle(thread: ThreadRuntime): Promise<void> {
    await this.pending.get(thread);
    const error = this.failed.get(thread);
    if (error) throw error;
  }

  /**
   * A persisted request marker can outlive a host process that crashed or was
   * disconnected before Pi emitted the corresponding user message. Cancel
   * those markers before subscribing to a reopened runtime so they cannot be
   * assigned to a later, unrelated turn.
   */
  private recoverOrphanedMarkers(thread: ThreadRuntime): void {
    const staleIds = unclaimedClientMessageIds(thread.entries, knownSkillNames(this.port.projection.composerCommands(thread)));
    for (const clientMessageId of staleIds) {
      thread.appendJournalEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
      this.port.clientMessages.forget(thread, clientMessageId);
    }
  }

  /** Pi drives a rebind itself and waits for it; only the switch path defers. */
  installHooks(thread: ThreadRuntime): void {
    const extensions = thread.backend.capabilities.extensions;
    if (!extensions) return;
    extensions.setLifecycleHooks(() => {
      extensions.unbind();
      this.port.clientTurns.settle(thread.threadId);
      thread.resetLiveState();
      void this.port.turnObservers.reset(thread.threadId).catch((error) => this.port.log("turn-observer.reset.failed", this.port.errorMessage(error)));
    }, async () => {
      await this.bind(thread);
    });
  }
}
