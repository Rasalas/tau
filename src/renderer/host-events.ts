import type { HostEvent, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import type { HostUpdate } from "../shared/host-protocol";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import type { ExtensionRegistry } from "./extension-system";
import { isSameUserMessage, type NewThreadSubmissionRecovery } from "./app-state";
import { preferences } from "./preferences";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";

/** What a host event reaches besides the view store it is reduced into. */
export interface HostEventTargets {
  registry: ExtensionRegistry;
  threadStore: ThreadStore;
  view: ThreadViewStore;
  recoveries: Map<string, NewThreadSubmissionRecovery>;
  currentDraftKey(): string | undefined;
  transcriptTurnStart(): TranscriptTurnStart | undefined;
  setTranscriptTurnStart(value: TranscriptTurnStart | undefined, expectedTurnId?: string): void;
  settleNewThreadDelivery(clientMessageId: string, sessionId: string, settlement: { accepted: true } | { accepted: false; message: string }): boolean;
  promoteRecoveryToSession(clientMessageId: string, sessionId: string, message: UiMessage): boolean;
  applyHostUpdate(update: HostUpdate): void;
  applyThreadIndex(index: ThreadIndexSnapshot): void;
}

type WorkbenchEvent = Parameters<ExtensionRegistry["dispatchWorkbenchEvent"]>[0];

/** Events an extension may observe through the workbench event bus. */
function isWorkbenchEvent(event: HostEvent): event is HostEvent & WorkbenchEvent {
  return event.type === "tool-start" || event.type === "tool-end" || event.type === "agent-status"
    || event.type === "user-message" || event.type === "assistant-end" || event.type === "thread-index"
    || event.type === "notice";
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
    case "user-message": {
      const clientMessageId = event.message.clientMessageId;
      if (clientMessageId && targets.recoveries.has(clientMessageId)) {
        targets.promoteRecoveryToSession(clientMessageId, event.sessionId, event.message);
      }
      const active = event.sessionId === threadStore.getSnapshot().activeThreadId;
      const known = active ? view.getTranscript().messages : view.details.get(event.sessionId)?.messages;
      if (known && !known.some((message) => isSameUserMessage(message, event.message))) preferences.unsettle(event.sessionId);
      break;
    }
    case "prompt-without-user-turn": {
      const turnStart = targets.transcriptTurnStart();
      if (turnStart?.clientMessageId === event.clientMessageId) targets.setTranscriptTurnStart(undefined, turnStart.turnId);
      const recovery = targets.recoveries.get(event.clientMessageId);
      if (recovery) recovery.withoutUserTurn = true;
      break;
    }
    case "new-thread-delivery-settled":
      targets.settleNewThreadDelivery(event.clientMessageId, event.sessionId, event.accepted
        ? { accepted: true }
        : { accepted: false, message: event.message });
      break;
    case "user-message-failed": {
      const recovery = targets.recoveries.get(event.clientMessageId);
      if (recovery) targets.settleNewThreadDelivery(event.clientMessageId, event.sessionId, { accepted: false, message: event.message });
      if (event.sessionId === threadStore.getSnapshot().activeThreadId
        || recovery?.scopeRef.scope === targets.currentDraftKey()) view.setNotice(event.message);
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
        void window.tau?.answerExtensionUi(event.prompt.id, known);
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
  threadStore.setThreadRunning(event.sessionId, event.running);
  if (event.running || event.sessionId !== threadStore.getSnapshot().activeThreadId) return;
  const finished = view.getState().runningThreadId;
  const viewed = threadStore.getSnapshot().activeThreadId;
  if (finished && (finished !== viewed || document.hidden)) threadStore.markUnread(finished);
}
