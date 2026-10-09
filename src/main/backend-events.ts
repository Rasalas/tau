import type { HostEvent, HostSnapshot, UiMessage, UiToolRun, UiTurnActivityEntry } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, type HostUpdate, type ThreadDetail } from "../shared/host-protocol.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { ThreadRuntimeEvent } from "./runtime-types.js";
import type { HostTurnObserverSet } from "./host-extensions.js";
import type { ThreadControls } from "./thread-stop.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export interface BackendEventServices {
  clientTurns: ClientTurnLedger;
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  log(label: string, detail?: string): void;
  fail(error: unknown, sessionId: string): void;
  settledSnapshot(): Promise<HostSnapshot>;
  detailForSnapshot(snapshot: HostSnapshot): ThreadDetail;
  ownTool(toolCallId: string, sessionId: string): void;
  releaseTool(toolCallId: string): void;
  pushToolOutput(toolCallId: string, output: string): void;
  /** `unpromptedEnded`: a turn the runtime began itself ended, and its outcome stands for the run's. */
  turnObservers: Pick<HostTurnObserverSet, "toolEnded" | "unpromptedEnded">;
  /** Republishes the thread's shell in the index: title, count, usage. */
  refreshShell(thread: ThreadRuntime, touch: boolean): Promise<void>;
  /** Republishes the goal and the background work the runtime holds now. */
  controls: Pick<ThreadControls, "publishGoal" | "publishBackground">;
  /** How the turn ended: why it failed, or undefined, and whether a provider limit stopped it. */
  turnSettled(sessionId: string, error: string | undefined, limit?: { resetsAt?: number }): void;
}

/**
 * Translates what a streamed external backend reports into the host event
 * stream, with the same bookkeeping the Pi path does: tool ownership for
 * output batching, `toolEnded` for turn observers, live turn state for a thread
 * opened mid-turn, and the settled snapshot at the end of a run.
 */
export function handleBackendRuntimeEvent(event: ThreadRuntimeEvent, thread: ThreadRuntime, services: BackendEventServices): void {
  const sessionId = thread.threadId;
  switch (event.type) {
    case "turn-started":
      thread.turnError = undefined;
      thread.unpromptedTurn = event.unprompted === true;
      thread.adapterStreaming = true;
      thread.adapterActivity.push({ id: nextActivityId(thread), tools: [], status: "running" });
      services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId });
      services.emit({ type: "agent-status", sessionId, running: true });
      services.log("agent.started", sessionId.slice(0, 8));
      break;
    case "turn-settled":
      settleTurn(event.status, thread, services, event.error, event.limit);
      break;
    case "assistant-start":
      thread.currentAssistantId = event.id;
      thread.liveAssistant = { id: event.id, text: "", thinking: "", timestamp: event.timestamp };
      services.emit({ type: "assistant-start", sessionId, id: event.id, timestamp: event.timestamp });
      break;
    case "assistant-delta":
      if (thread.liveAssistant?.id === event.id) thread.liveAssistant.text += event.delta;
      services.emit({ type: "assistant-delta", sessionId, id: event.id, delta: event.delta });
      break;
    case "assistant-thinking":
      if (thread.liveAssistant?.id === event.id) thread.liveAssistant.thinking += event.delta;
      services.emit({ type: "assistant-thinking", sessionId, id: event.id, delta: event.delta });
      break;
    case "assistant-end":
      remember(thread, event.message);
      if (thread.currentAssistantId === event.message.id) {
        thread.currentAssistantId = undefined;
        thread.liveAssistant = undefined;
      }
      services.emit({ type: "assistant-end", sessionId, message: event.message });
      break;
    case "user-message":
      remember(thread, event.message);
      services.emit({ type: "user-message", sessionId, message: event.message });
      break;
    case "tool-start":
      thread.tools.set(event.tool.id, event.tool);
      recordTool(thread, event.tool);
      saveActivity(thread, services);
      services.ownTool(event.tool.id, sessionId);
      services.emit({ type: "tool-start", sessionId, tool: event.tool });
      services.log("tool.started", event.tool.name);
      break;
    case "tool-update": {
      const previous = thread.tools.get(event.id);
      if (previous) {
        const updated = { ...previous, output: event.output };
        thread.tools.set(event.id, updated);
        recordTool(thread, updated);
      }
      services.pushToolOutput(event.id, event.output);
      break;
    }
    case "tool-end":
      if (event.tool.kind === "subagent") {
        const entry = thread.adapterActivity.find((activity) => activity.tools.some((tool) => tool.id === event.tool.id)) ?? currentActivity(thread);
        const at = entry.tools.findIndex((tool) => tool.id === event.tool.id);
        if (at === -1) {
          entry.anchorMessageId ??= thread.adapterMessages.at(-1)?.id;
          entry.tools.push(event.tool);
        } else entry.tools[at] = event.tool;
        saveActivity(thread, services, entry);
        services.emit({ type: at === -1 ? "tool-start" : "tool-end", sessionId, tool: event.tool });
      } else finishTool(event.tool, thread, services);
      break;
    case "queue":
      services.emit({ type: "queue", sessionId, steering: [...event.steering], followUp: [...event.followUp] });
      break;
    case "notice":
      // The first error of a running turn is the likeliest cause, for a backend that names none.
      if (event.level === "error" && thread.adapterStreaming) thread.turnError ??= event.message;
      services.emit({ type: "notice", sessionId, message: event.message, level: event.level });
      break;
    case "usage":
    case "title":
      services.refreshShell(thread, false).catch((error) => services.fail(error, sessionId));
      break;
    case "goal":
      services.controls.publishGoal(thread);
      break;
    case "background":
      services.controls.publishBackground(thread);
      break;
    default: {
      const unhandled: never = event;
      services.log("backend.event.unknown", String((unhandled as { type?: unknown }).type));
    }
  }
}

/** Past every number in use: turns a runtime kept may have been thinned out, and ids must stay the ones a client saw. */
function nextActivityId(thread: ThreadRuntime): string {
  const used = thread.adapterActivity.map((entry) => Number(/-(\d+)$/u.exec(entry.id)?.[1] ?? 0));
  return `activity-${thread.threadId}-${Math.max(thread.adapterActivity.length, ...used) + 1}`;
}

/** The turn's activity entry; a tool arriving outside a turn opens one. */
function currentActivity(thread: ThreadRuntime): UiTurnActivityEntry {
  const last = thread.adapterActivity.at(-1);
  if (last?.status === "running") return last;
  const entry: UiTurnActivityEntry = { id: nextActivityId(thread), tools: [], status: "running" };
  thread.adapterActivity.push(entry);
  return entry;
}

/** Keeps the turn's activity entry current; the anchor is the message before its first tool. */
function recordTool(thread: ThreadRuntime, tool: UiToolRun): void {
  const entry = currentActivity(thread);
  if (entry.anchorMessageId === undefined) {
    const anchor = thread.adapterMessages.at(-1)?.id;
    if (anchor) entry.anchorMessageId = anchor;
  }
  const at = entry.tools.findIndex((existing) => existing.id === tool.id);
  if (at === -1) entry.tools.push(tool);
  else entry.tools[at] = tool;
}

/** Hands the turn's activity to a runtime that keeps it across restarts. */
function saveActivity(thread: ThreadRuntime, services: BackendEventServices, entry = thread.adapterActivity.at(-1)): void {
  const history = thread.backend.capabilities.activityHistory;
  if (!history || !entry) return;
  const copy = { ...entry, tools: entry.tools.map((tool) => ({ ...tool })) };
  Promise.resolve().then(() => history.save(copy))
    .catch((error: unknown) => services.log("activity.save.failed", error instanceof Error ? error.message : String(error)));
}

/** The transcript the host holds for a thread without a journal; a re-sent id replaces its row. */
function remember(thread: ThreadRuntime, message: UiMessage): void {
  const at = thread.adapterMessages.findIndex((existing) => existing.id === message.id);
  thread.adapterMessages = at === -1
    ? [...thread.adapterMessages, message]
    : thread.adapterMessages.map((existing, index) => index === at ? message : existing);
}

function finishTool(tool: UiToolRun, thread: ThreadRuntime, services: BackendEventServices): void {
  const previous = thread.tools.get(tool.id);
  const ended: UiToolRun = { ...tool, args: Object.keys(tool.args).length > 0 ? tool.args : previous?.args ?? {}, startedAt: previous?.startedAt ?? tool.startedAt, endedAt: tool.endedAt ?? Date.now() };
  recordTool(thread, ended);
  saveActivity(thread, services);
  services.turnObservers.toolEnded(thread.threadId, ended, thread.cwd);
  services.emit({ type: "tool-end", sessionId: thread.threadId, tool: ended });
  thread.tools.delete(tool.id);
  services.releaseTool(tool.id);
  services.log("tool.ended", `${ended.name}:${ended.status}`);
}

function settleTurn(status: "completed" | "interrupted" | "error", thread: ThreadRuntime, services: BackendEventServices, failure?: string, limit?: { resetsAt?: number }): void {
  const sessionId = thread.threadId;
  // A tool still running when the turn ends never reports again; close its card.
  for (const tool of [...thread.tools.values()]) {
    finishTool({ ...tool, status: "error", output: tool.output ?? (status === "interrupted" ? "Interrupted." : "The turn ended before this tool finished.") }, thread, services);
  }
  thread.adapterStreaming = false;
  thread.currentAssistantId = undefined;
  thread.liveAssistant = undefined;
  const entry = thread.adapterActivity.at(-1);
  if (entry?.status === "running") {
    // A turn without tools leaves no fold behind.
    if (entry.tools.length === 0) thread.adapterActivity.pop();
    else {
      entry.status = status;
      saveActivity(thread, services);
    }
  }
  services.clientTurns.settle(sessionId);
  if (thread.unpromptedTurn) {
    thread.unpromptedTurn = false;
    services.turnObservers.unpromptedEnded(sessionId, status === "error" ? "failed" : "completed");
  }
  const reason = status === "error" ? failure?.trim() || thread.turnError || "The turn failed." : undefined;
  if (reason !== undefined && limit) services.turnSettled(sessionId, reason, limit);
  else services.turnSettled(sessionId, reason);
  thread.turnError = undefined;
  services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId });
  services.emit({ type: "agent-status", sessionId, running: false });
  void services.settledSnapshot().then((snapshot) => {
    if (snapshot.sessionId !== sessionId || snapshot.isStreaming) return;
    services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: services.detailForSnapshot(snapshot) });
    // The turn may have taught the backend its model and levels; the detail does not carry them.
    services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
  }).catch((error) => services.fail(error, sessionId));
  services.log("agent.settled", `${sessionId.slice(0, 8)} ${status}`);
}
