import type { WindowShellEvent } from "../shared/window-shell";
import type { ExtensionUiAnswer, HostEvent, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import type { HostUpdate } from "../shared/host-protocol";
import type { HostClient } from "./host-client";
import type { HostConnectionState } from "./host-connection";
import type { TranscriptTurnStart } from "./transcript-navigation";
import { isSameUserMessage } from "./app-state";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";

/**
 * What a host event needs of the contribution registry. `ExtensionRegistry`
 * satisfies it; naming only these three keeps React out of the workbench.
 */
export interface RegistryPort {
  dispatchWorkbenchEvent(event: WorkbenchEventCandidate): void;
  dispatchExtensionEvent(event: Extract<HostEvent, { type: "extension-event" }>): void;
  interceptPrompt(prompt: Extract<HostEvent, { type: "extension-ui-prompt" }>["prompt"]): ExtensionUiAnswer | undefined;
}

/** The host events the registry forwards to extensions; the rest stays workbench state. */
export type WorkbenchEventCandidate =
  | Extract<HostEvent, { type: "tool-start" | "tool-end" | "agent-status" | "user-message" | "assistant-end" | "thread-index" | "notice" | "client-count" }>
  | { type: "active-thread-changed"; sessionId?: string }
  /** The host opened another project; `from` is absent for the first one this client saw. */
  | { type: "workspace-changed"; from?: string; to: string }
  | { type: "host-connection"; state: HostConnectionState };

/** What a host event needs of the user's preferences. */
export interface SettledThreadsPort {
  unsettle(sessionId: string): void;
  /** Re-reads config and user themes from the host, e.g. after one of those files changed. */
  syncFromHost(): Promise<void>;
}

/** What a delivery in flight needs to hear from the host. */
export interface SubmissionPort {
  hasRecovery(clientMessageId: string): boolean;
  recoveryScope(clientMessageId: string): string | undefined;
  markWithoutUserTurn(clientMessageId: string): void;
  promoteRecovery(clientMessageId: string, sessionId: string, message: UiMessage): boolean;
  settleDelivery(clientMessageId: string, sessionId: string, settlement: { accepted: true } | { accepted: false; message: string }): boolean;
}

/** What a host event reaches besides the view store it is reduced into. */
export interface HostEventTargets {
  client?: HostClient;
  registry: RegistryPort;
  threadStore: ThreadStore;
  view: ThreadViewStore;
  submission: SubmissionPort;
  preferences: SettledThreadsPort;
  /** Whether the user is looking at something else; a run that ends unseen marks its thread unread. */
  viewerHidden(): boolean;
  currentDraftKey(): string | undefined;
  transcriptTurnStart(): TranscriptTurnStart | undefined;
  setTranscriptTurnStart(value: TranscriptTurnStart | undefined, expectedTurnId?: string): void;
  applyHostUpdate(update: HostUpdate): void;
  applyThreadIndex(index: ThreadIndexSnapshot): void;
  /**
   * Re-reads the desktop halves the host serves, after its package set moved.
   * `only` names the extensions that moved, so the client can swap those
   * modules alone.
   */
  syncDesktopExtensions(only?: readonly string[]): void;
  /** A downloaded Tau waiting for a restart. */
  setUpdateReady(version: string): void;
  /** A Pi extension retitled the window; the page title is what the OS shows for it. */
  setWindowTitle?(title: string): void;
  /** The window's own process: its menu, the quit shortcut, a quit waiting for an answer. */
  windowShell?(event: WindowShellEvent): void;
}

/** Events an extension may observe through the workbench event bus. */
function isWorkbenchEvent(event: HostEvent): event is HostEvent & WorkbenchEventCandidate {
  return event.type === "tool-start" || event.type === "tool-end" || event.type === "agent-status"
    || event.type === "user-message" || event.type === "assistant-end" || event.type === "thread-index"
    || event.type === "notice" || event.type === "client-count";
}

/**
 * Routes one host event: the effects that are not view state happen here, the
 * transition of the visible thread happens in the view store's reducer.
 */
export function applyHostEvent(event: HostEvent, targets: HostEventTargets): void {
  const { registry, threadStore, view } = targets;
  if (isWorkbenchEvent(event)) queueMicrotask(() => registry.dispatchWorkbenchEvent(event));

  switch (event.type) {
    case "host-update":
      targets.applyHostUpdate(event.update);
      return;
    case "thread-index":
      targets.applyThreadIndex(event.threadIndex);
      return;
    case "extension-event":
      registry.dispatchExtensionEvent(event);
      return;
    case "extension-packages-changed":
      // A package the user just approved, installed or updated, or one whose
      // files the host saw change: its desktop half is built and served now, so
      // the slots appear without a reload.
      targets.syncDesktopExtensions(event.extensionIds);
      return;
    case "config-changed":
      // Config and themes are read from the host on demand; this is the one
      // push that tells a client the answer would be different now.
      void targets.preferences.syncFromHost();
      return;
    case "extension-deactivated":
      view.setNotice(
        `Package ${event.name} deactivated: ${event.reason}. Re-enable it in Settings → Extensions.`,
        "warning",
      );
      return;
    case "app-update":
      targets.setUpdateReady(event.version);
      return;
    // The machine's own Tau; `update-store` follows it on the connection itself.
    case "update-status":
      return;
    case "window-title":
      targets.setWindowTitle?.(event.title);
      return;
    case "window-shell":
      targets.windowShell?.(event.event);
      return;
    // The platform's machine list and its look-ins follow these themselves.
    case "environments":
    case "environment-thread":
      return;
    case "user-message": {
      const clientMessageId = event.message.clientMessageId;
      if (clientMessageId && targets.submission.hasRecovery(clientMessageId)) {
        targets.submission.promoteRecovery(clientMessageId, event.sessionId, event.message);
      }
      const active = event.sessionId === threadStore.getSnapshot().activeThreadId;
      const known = active ? view.getTranscript().messages : view.details.get(event.sessionId)?.messages;
      if (known && !known.some((message) => isSameUserMessage(message, event.message))) targets.preferences.unsettle(event.sessionId);
      break;
    }
    case "prompt-without-user-turn": {
      const turnStart = targets.transcriptTurnStart();
      if (turnStart?.clientMessageId === event.clientMessageId) targets.setTranscriptTurnStart(undefined, turnStart.turnId);
      targets.submission.markWithoutUserTurn(event.clientMessageId);
      break;
    }
    case "new-thread-delivery-settled":
      targets.submission.settleDelivery(event.clientMessageId, event.sessionId, event.accepted
        ? { accepted: true }
        : { accepted: false, message: event.message });
      break;
    case "user-message-failed": {
      const recoveryScope = targets.submission.recoveryScope(event.clientMessageId);
      if (recoveryScope !== undefined) {
        targets.submission.settleDelivery(event.clientMessageId, event.sessionId, { accepted: false, message: event.message });
      }
      if (event.sessionId === threadStore.getSnapshot().activeThreadId
        || recoveryScope === targets.currentDraftKey()) view.setNotice(event.message);
      // A supervisor watching a list of threads sees the refusal on the row,
      // not only in a toast the thread on screen gets.
      threadStore.markFailed(event.sessionId);
      break;
    }
    case "agent-status":
      applyAgentStatus(event, targets);
      break;
    case "tool-start":
      // The rail's running-tool name describes the thread on screen only.
      if (event.sessionId === threadStore.getSnapshot().activeThreadId) threadStore.toolStarted(event.tool.id, event.tool.name);
      break;
    case "tool-end":
      if (event.sessionId === threadStore.getSnapshot().activeThreadId) threadStore.toolEnded(event.tool.id);
      break;
    case "extension-ui-prompt": {
      const known = registry.interceptPrompt(event.prompt);
      // An extension that answers its own question never shows a dialog.
      if (known) {
        void targets.client?.answerExtensionUi(event.prompt.id, known);
        return;
      }
      break;
    }
    default:
      break;
  }
  view.dispatch(event);
}

function applyAgentStatus(event: Extract<HostEvent, { type: "agent-status" }>, targets: HostEventTargets): void {
  const { threadStore, view } = targets;
  // The one writer of run state. isStreaming, the live timer and the rail all
  // read it back through ThreadStore's activity selector.
  threadStore.setThreadRunning(event.sessionId, event.running, event.startedAt);
  if (event.running || event.sessionId !== threadStore.getSnapshot().activeThreadId) return;
  const finished = view.getState().runningThreadId;
  const viewed = threadStore.getSnapshot().activeThreadId;
  if (finished && (finished !== viewed || targets.viewerHidden())) threadStore.markUnread(finished);
}
